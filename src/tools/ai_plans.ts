/**
 * Los planes de IA: seis herramientas, y la única de este servidor que GASTA DINERO.
 *
 * POR QUÉ ESTÁN AQUÍ, DESPUÉS DE HABER ESTADO FUERA A PROPÓSITO
 *
 * El roadmap dejó los planes de IA fuera de la v1 con un motivo que sigue siendo cierto: «`create`
 * cuesta dinero por llamada, y un agente en bucle es justo el peor cliente posible para un endpoint
 * que factura». Lo fiaba a la MRTR —la elicitación de la spec 2026-07-28, «¿confirmas que gasto
 * esto?» desde el propio servidor—, que hoy casi ningún cliente implementa.
 *
 * La fase 10 de `cambios-planvortex.md` pide lo contrario, y las dos cosas caben: el motivo cubre
 * `create`, no la lectura. Así que
 *
 *  - **las cinco de lectura entran siempre.** No facturan nada, y sin ellas el modelo no puede
 *    siquiera explicar lo que costaría un plan antes de proponerlo, ni cuál de los que ya hizo
 *    funcionó (`get_ai_plan_results`), ni elegir los productos de una tienda (`list_store_products`).
 *  - **`create_ai_plan` necesita `PLANVORTEX_MCP_ALLOW_AI=1`**, que es la confirmación humana que
 *    la MRTR no da: la escribe una persona en su fichero de configuración, una vez, antes de que
 *    ningún agente arranque. Y como el gate actúa en el REGISTRO, apagado no está en `tools/list`.
 *
 * Y `validate_ai_plan` NO está, que es la decisión menos obvia de este fichero. Validar convierte
 * de golpe la semana entera en publicaciones programadas: es la acción que de verdad saca el plan
 * a la calle, y es exactamente el multiplicador que el roadmap temía. Lo generado son borradores
 * normales, así que un agente que quiera programar uno ya tiene `update_publication` — de uno en
 * uno, con una persona mirando cada texto, que es como debe salir algo escrito por un modelo.
 *
 * LO QUE HAY QUE SABER DEL CICLO (y el modelo lo lee en las descripciones)
 *
 * `create` NO genera: encola y devuelve el presupuesto. La generación la hace un job aparte y puede
 * tardar minutos, así que se sondea `get_ai_plan` mientras el estado sea `pending` o `generating`.
 */
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AiPlanCreateRequest, AiPlanResult, Integration } from "planvortex";
import type { Context } from "../context.js";
import { toolOk, ToolInputError } from "../errors.js";
import { asLines, clampLimit, compactNumbers, paginationNote, snippet } from "../format/project.js";
import { fingerprint } from "../dedupe.js";
import { defineTool } from "./register.js";

const OrganizationArg = z.string().describe("The PlanVortex organization id. Optional.").optional();

/**
 * La nota del gate, que va en las TRES de lectura y no sólo en una.
 *
 * Un modelo que encuentra `list_ai_plans` y no encuentra con qué crear uno concluye lo más barato
 * —que no se puede— y se pone a escribir la semana él mismo. Que es justo lo que este servidor
 * existe para no tener que hacer.
 */
const GATE_NOTE =
    "Creating plans is off unless the server was started with PLANVORTEX_MCP_ALLOW_AI=1, because " +
    "generating one spends AI credits. If create_ai_plan is not in your tool list, that is why: " +
    "tell the user to add it to the env block of their MCP configuration.";

const PlanView = z.object({
    id: z.string(),
    state: z.string(),
    template: z.string(),
    prompt: z.string(),
    accounts: z.number(),
    publications: z.number(),
    credits_spent: z.number(),
    creation_date: z.string(),
    archived: z.boolean(),
});

interface PlanRow {
    id: string;
    state: string;
    template: string;
    prompt: string;
    accounts: number;
    publications: number;
    credits_spent: number;
    creation_date: string;
    archived: boolean;
}

/**
 * `template` viaja siempre, aunque el plan no lo trajera: un plan sin plantilla es `standard`, y
 * omitir la clave haría creer al modelo que es otra cosa. Y `publications` se cuenta en vez de
 * listarse porque el LISTADO devuelve identificadores y el detalle objetos enteros (§ el tipo lo
 * avisa): un `length` significa lo mismo en los dos, un volcado no.
 */
function projectPlan(plan: {
    _id: string;
    state: string;
    template?: string | undefined;
    prompt: string;
    accounts: string[];
    publications: unknown[];
    credits_spent: number;
    creation_date: string;
    archived_date?: string | undefined;
}): PlanRow {
    return {
        id: plan._id,
        state: plan.state,
        template: plan.template ?? "standard",
        prompt: snippet(plan.prompt),
        accounts: plan.accounts.length,
        publications: plan.publications.length,
        credits_spent: plan.credits_spent,
        creation_date: plan.creation_date,
        archived: Boolean(plan.archived_date),
    };
}

/**
 * En qué estado está una tienda, en una palabra. El 2219 no es un fallo —la tienda se conectó con el
 * botón hace un momento y se está comprobando— y leerlo como `error 2219` manda al modelo a decirle
 * al usuario que algo se ha roto.
 */
function storeState(integration: Integration): string {
    if (!integration.enabled) return "disabled";
    if (integration.connected) return "connected";
    if (integration.error_code === 2219) return "being checked (connected moments ago)";
    return `error ${integration.error_code ?? ""}: a person has to reconnect it in the panel`.trim();
}

/**
 * La nota de los resultados. Va SIEMPRE: los dos errores que evita —leer un plan sin `ranked` como
 * «el peor» y leer una métrica ausente como un cero— son justo los que un modelo comete sin ella.
 */
const RESULTS_NOTE =
    "vs_your_average compares each plan with the organization's own posts on the same networks: 1x is " +
    "its usual level, so the first plan in the ranking can still be below 1x. " +
    "ranked false means too few measured posts to compare, not a bad plan. maturing true means the " +
    "numbers are still moving. Metrics a network does not measure are left out, never zero. " +
    "credits_per_engagement is absent when filtering by network, because the cost is the whole plan's.";

/**
 * Un plan con sus resultados, proyectado. Las métricas pasan por `compactNumbers` y viajan como
 * JSON en una línea: es lo mismo que hace `get_top_publications`, y por lo mismo.
 */
function projectPlanResult(result: AiPlanResult): Record<string, unknown> {
    return {
        id: result.id_ai_plan,
        template: result.template,
        prompt: snippet(result.prompt),
        week_start: result.week_start,
        networks: result.social_networks.join(", "),
        published_posts: result.publications.published,
        measured_posts: result.publications.measured,
        engagement_per_post: result.engagement_per_publication,
        //El cociente frente a sus propias publicaciones: es lo que dice si el plan es bueno, no sólo el primero
        vs_your_average:
            result.engagement_vs_average === undefined ? undefined : `${result.engagement_vs_average}x`,
        credits_spent: result.credits_spent,
        credits_per_engagement: result.credits_per_engagement,
        ranked: result.ranked,
        maturing: result.maturing,
        metrics: JSON.stringify(compactNumbers(result.metrics)),
    };
}

export function registerAiPlanTools(server: McpServer, ctx: Context): void {
    defineTool(
        server,
        ctx,
        {
            name: "get_planner_templates",
            title: "Get the AI planner templates",
            description:
                "What an AI plan can be generated FROM, with the credits each template costs. " +
                "Five of them: standard (a theme prompt, images generated by the model), " +
                "from_images (the user's own photos, each with a description), from_text (an " +
                "article by URL or pasted), from_catalog (products read live from a connected " +
                "shop) and campaign (a countdown to a date, with a narrative arc). Read this " +
                "before proposing a plan: the costs and the fields are prices, and they are not " +
                "to be guessed or remembered. The ones that do not generate images cost a " +
                "fraction — a week of 7 posts with a picture each is 519 credits on standard and " +
                "48 on from_images. " +
                GATE_NOTE,
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (_args, context) => {
            const templates = await context.pv.catalog.plannerTemplates();
            const rows = templates.map((template) => ({
                template: template.template ?? "standard",
                orchestration_cost: template.orchestration_cost ?? 0,
                cost_per_source_item: template.orchestration_cost_per_source_item ?? 0,
                generates_images: template.generates_images ?? false,
                max_source_items: template.max_source_items ?? 0,
                allows_shared: template.allows_shared ?? false,
                allows_gallery: template.allows_gallery ?? false,
                source_fields: (template.source_fields ?? [])
                    .map((field) => field.name ?? "")
                    .filter(Boolean)
                    .join(", "),
                source_requires_any: (template.source_requires_any ?? []).join(", "),
                //Las redes que no caben en un plan de esta plantilla (2120): sin la columna, el modelo
                //mete la cuenta de YouTube en una semana de fotos de producto y se come el rechazo
                unsupported_networks: (template.unsupported_networks ?? []).join(", "),
            }));
            return toolOk(
                `${rows.length} planner templates.\n\n${asLines(rows)}\n\n` +
                    "generates_images false means the pictures come from the source and the plan " +
                    "spends no image credits at all. Each generated image costs 70 credits. " +
                    "Accounts on a network listed in unsupported_networks cannot be in a plan of " +
                    "that template: leave them out of accounts. source_requires_any means exactly " +
                    "one of those fields is needed.",
                { templates: rows },
            );
        },
    );

    //LAS TIENDAS, y el motivo de que esta herramienta exista: `from_catalog` desde una tienda pide los
    //ids de SUS productos, y sin una forma de leerlos el modelo sólo puede inventárselos o pedirle al
    //usuario que los copie de su WordPress. Sin `id_integration` contesta con las tiendas conectadas,
    //igual que `list_destinations` sin tablero: el id de la tienda también hay que sacarlo de algún
    //sitio, y una herramienta de integraciones entera para eso sería una más en cada listado.
    //
    //Nombre, precio y si se puede elegir; nada de la descripción. Para ELEGIR productos basta, la
    //descripción la lee el servidor al generar el plan, y es texto de una web ajena que no hace falta
    //meter en el contexto del modelo.
    defineTool(
        server,
        ctx,
        {
            name: "list_store_products",
            title: "List the products of a connected shop",
            description:
                "The products of a shop connected to the organization (a WooCommerce store), to " +
                "choose the ones a from_catalog AI plan writes about. Without id_integration it " +
                "lists the organization's connected shops, with the id to pass back. With it, one " +
                "page of that shop's products, read live: search by text rather than walking the " +
                "whole catalogue, and pass next_cursor back exactly as given. Out-of-stock products " +
                "come marked and cannot be chosen. A product without a price has none to show, and " +
                "a price is text to repeat as is, never a number to do maths with. Connecting a " +
                "shop needs a person in the PlanVortex panel.",
            inputSchema: z.object({
                id_integration: z
                    .string()
                    .describe("A connected shop's id. Omit it to list the shops.")
                    .optional(),
                search: z.string().describe("Text to look for in the shop's catalogue.").optional(),
                cursor: z.string().describe("next_cursor from the previous page, as given.").optional(),
                limit: z.number().int().min(1).max(50).optional(),
                id_organization: OrganizationArg,
            }),
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);

            if (args.id_integration === undefined) {
                //Las tiendas son las integraciones de un proveedor con `catalog`, y eso lo dice el
                //catálogo de proveedores, no una lista de aquí: Shopify entrará sin tocar esto
                const providers = await context.pv.integrations.providers();
                const withCatalog = new Set<string>(
                    providers.filter((provider) => provider.catalog).map((provider) => provider.provider),
                );
                const page = await context.pv.integrations.list(idOrganization);
                const stores = page.data
                    .filter((integration) => withCatalog.has(integration.provider))
                    .map((integration) => ({
                        id_integration: integration._id,
                        name: integration.name,
                        provider: integration.provider,
                        url: integration.external_identifier,
                        state: storeState(integration),
                        prices: integration.config?.tax_location_missing
                            ? "missing on taxable products: the store's tax setting hides them from the API"
                            : undefined,
                    }));
                if (stores.length === 0) {
                    return toolOk(
                        "No shop is connected to this organization. Connecting one needs a person: " +
                            "it is done in the PlanVortex panel, under Integrations.",
                        { stores: [] },
                    );
                }
                return toolOk(
                    `${asLines(stores)}\n\nCall this tool again with one id_integration to read its products.`,
                    { stores },
                );
            }

            const page = await context.pv.integrations.products(idOrganization, args.id_integration, {
                limit: clampLimit(args.limit),
                ...(args.search === undefined ? {} : { search: args.search }),
                ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            });
            const products = page.items.map((product) => ({
                id: product.external_id,
                name: snippet(product.name),
                price: product.price,
                available: product.available ? "yes" : "NO, out of stock: cannot be chosen",
            }));
            const lines = [
                products.length === 0
                    ? args.search === undefined
                        ? "This shop has no published products."
                        : "No product matches that search."
                    : asLines(products),
            ];
            if (page.next_cursor !== undefined) {
                lines.push(
                    `There are more: call again with cursor ${page.next_cursor} (exactly as given), or narrow it with search.`,
                );
            }
            lines.push(
                `To plan a week with some of these, create_ai_plan takes template from_catalog and ` +
                    `source { id_integration_catalog: "${args.id_integration}", products: [their ids, in ` +
                    "the order of the week] }, up to the max_source_items of get_planner_templates.",
            );
            return toolOk(lines.join("\n\n"), {
                products,
                ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
            });
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "list_ai_plans",
            title: "List AI plans",
            description:
                "The AI-generated publication plans of an organization, newest first. States are " +
                "pending and generating (still being written), generated (drafts ready for a " +
                "person to review), validated (the drafts were scheduled), failed and cancelled. " +
                "Archived plans are a separate listing, never mixed in: pass archived true for " +
                "those. " +
                GATE_NOTE,
            inputSchema: z.object({
                id_organization: OrganizationArg,
                archived: z
                    .boolean()
                    .describe("true lists the archived plans INSTEAD of the active ones.")
                    .optional(),
                limit: z.number().int().min(1).max(50).optional(),
                offset: z.number().int().min(0).optional(),
            }),
            outputSchema: z.object({ ai_plans: z.array(PlanView), total: z.number() }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const idClient = await context.resolveClient(idOrganization);
            const page = await context.pv.aiPlans.list(idClient, idOrganization, {
                limit: clampLimit(args.limit),
                ...(args.offset === undefined ? {} : { offset: args.offset }),
                ...(args.archived === undefined ? {} : { archived: args.archived }),
            });
            const plans = page.data.map(projectPlan);
            if (plans.length === 0) {
                return toolOk(
                    args.archived === true
                        ? "No archived AI plans."
                        : "No AI plans yet in this organization.",
                    { ai_plans: [], total: 0 },
                );
            }
            return toolOk(
                `${asLines(plans)}\n\n${paginationNote(plans.length, page.total, args.offset ?? 0)}`,
                { ai_plans: plans, total: page.total ?? plans.length },
            );
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "get_ai_plan",
            title: "Get one AI plan",
            description:
                "One plan with its state, what it has spent, and the posts it generated. This is " +
                "what you poll after create_ai_plan: while the state is pending or generating " +
                "nothing exists yet, and generation can take minutes. Once it is generated, the " +
                "posts are ORDINARY publications in draft state — read them with get_publication " +
                "and edit or schedule them with update_publication, not with anything here. " +
                "A failed plan carries the reason in error, and a generated one may still carry " +
                "warnings worth reading out.",
            inputSchema: z.object({
                id_ai_plan: z.string().describe("The plan id, from list_ai_plans or create_ai_plan."),
                id_organization: OrganizationArg,
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const idClient = await context.resolveClient(idOrganization);
            const plan = await context.pv.aiPlans.get(idClient, idOrganization, args.id_ai_plan);
            const row = projectPlan(plan);

            //Los identificadores de las publicaciones se dan explícitos: es lo que el modelo
            //necesita para ir a `get_publication`, y sin ellos la herramienta cuenta siete
            //borradores que no sabe abrir. El tipo permite las dos formas, así que se normaliza.
            const publicationIds = plan.publications
                .map((publication) => (typeof publication === "string" ? publication : publication._id))
                .filter(Boolean);

            const lines = [asLines([row])];
            if (publicationIds.length > 0) {
                lines.push(`publication_ids: ${publicationIds.join(", ")}`);
            }
            if (plan.error) {
                lines.push(`error: ${plan.error.code} — ${plan.error.message}`);
            }
            for (const warning of plan.warnings ?? []) {
                lines.push(`warning: ${warning.code} — ${warning.message}`);
            }
            if (plan.state === "pending" || plan.state === "generating") {
                lines.push(
                    "Still being written. Poll this tool again in a minute or two rather than " +
                        "creating another plan.",
                );
            }
            return toolOk(lines.join("\n"), {
                ai_plan: row as unknown as Record<string, unknown>,
                publication_ids: publicationIds,
            });
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "get_ai_plan_results",
            title: "Compare the results of AI plans",
            description:
                "Which AI plans worked, and which template works best — the tool for 'which of my " +
                "AI plans did best?'. Each plan comes with what its published posts achieved, plus " +
                "an aggregate per template. Plans are ranked by interactions per MEASURED post, not " +
                "by the total (the total just rewards bigger plans), and only plans marked " +
                "ranked (at least 3 measured posts) compete; maturing means its numbers are still " +
                "moving, so say so before comparing it with an older plan. The range filters on the " +
                "week the plan published in. To compare plans fairly across networks, pass one " +
                "social_network. Missing metrics are not zeros.",
            inputSchema: z.object({
                id_organization: OrganizationArg,
                from_date: z.string().describe("ISO 8601 date. Defaults to the last 30 days.").optional(),
                to_date: z.string().describe("ISO 8601 date.").optional(),
                sort: z
                    .enum([
                        "engagement_per_publication",
                        "engagement",
                        "impressions",
                        "reach",
                        "credits_per_engagement",
                        "credits_spent",
                        "week_start",
                    ])
                    .describe(
                        "Defaults to engagement_per_publication. credits_per_engagement goes cheapest first.",
                    )
                    .optional(),
                template: z
                    .enum(["standard", "from_images", "from_text", "from_catalog", "campaign"])
                    .describe("Only plans generated from this template.")
                    .optional(),
                social_network: z
                    .array(z.string())
                    .describe("Recompute each plan with only its posts on these networks.")
                    .optional(),
                limit: z.number().int().min(1).max(50).optional(),
                offset: z.number().int().min(0).optional(),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const idClient = await context.resolveClient(idOrganization);
            const results = await context.pv.aiPlans.results(idClient, idOrganization, {
                ...(args.from_date === undefined ? {} : { from_date: args.from_date }),
                ...(args.to_date === undefined ? {} : { to_date: args.to_date }),
                ...(args.sort === undefined ? {} : { sort: args.sort }),
                ...(args.template === undefined ? {} : { template: args.template }),
                ...(args.social_network === undefined ? {} : { social_network: args.social_network }),
                limit: clampLimit(args.limit),
                ...(args.offset === undefined ? {} : { offset: args.offset }),
            });

            if (results.total === 0) {
                return toolOk(
                    "No AI plan published anything in that range. A plan counts from the week it " +
                        "publishes in, not from when it was created.",
                );
            }

            const plans = results.ai_plans.map(projectPlanResult);
            const templates = results.by_template.map((group) => ({
                template: group.template,
                plans: group.plans,
                measured_posts: group.publications.measured,
                engagement_per_post: group.engagement_per_publication,
                vs_your_average:
                    group.engagement_vs_average === undefined ? undefined : `${group.engagement_vs_average}x`,
                credits_per_engagement: group.credits_per_engagement,
            }));
            const totals = results.totals;
            const header = asLines([
                {
                    plans: totals.plans,
                    ranked_plans: totals.ranked_plans,
                    measured_posts: totals.publications.measured,
                    engagement_per_post: totals.engagement_per_publication,
                    vs_your_average:
                        totals.engagement_vs_average === undefined
                            ? undefined
                            : `${totals.engagement_vs_average}x`,
                    credits_per_engagement: totals.credits_per_engagement,
                },
            ]);
            return toolOk(
                [
                    header,
                    `By template:\n\n${asLines(templates)}`,
                    `Plans:\n\n${asLines(plans)}`,
                    paginationNote(plans.length, results.total, args.offset ?? 0),
                    RESULTS_NOTE,
                ].join("\n\n"),
            );
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "create_ai_plan",
            title: "Generate a week of posts with AI",
            description:
                "Ask PlanVortex's AI to write a week of posts for one or more connected accounts. " +
                "THIS SPENDS AI CREDITS and the user pays for them, so show them the estimate " +
                "from get_planner_templates and get their agreement before calling it. " +
                "It does NOT return posts: it queues the plan and returns the budget that was " +
                "approved — poll get_ai_plan until the state is generated. What comes out are " +
                "DRAFTS for a person to review, never anything published. " +
                "The plan is weekly and its size is (publish_days x accounts), at most one post " +
                "per day and account: three accounts on Monday, Wednesday and Friday is 9 posts, " +
                "not 21. Pick the template with get_planner_templates first; without one the plan " +
                "is standard, which generates its own images and is the most expensive. " +
                "With a Pinterest account in the plan, pass its board in destinations (read them " +
                "with list_destinations) and keep images on: a pin is never text alone, so a plan " +
                "that would leave pins without an image is refused (2119) before anything is charged. " +
                "Leave out accounts on a network in the template's unsupported_networks " +
                "(get_planner_templates): a YouTube account does not fit from_images or from_catalog, " +
                "and the plan is refused (2120). For from_catalog from a connected shop, take the " +
                "shop and the product ids from list_store_products.",
            inputSchema: z.object({
                prompt: z.string().min(1).describe("What the week is about, in the user's own words."),
                accounts: z
                    .array(z.string())
                    .min(1)
                    .describe("Connected account ids from list_accounts. They set the plan's size."),
                template: z
                    .enum(["standard", "from_images", "from_text", "from_catalog", "campaign"])
                    .describe("Where the content comes from. Defaults to standard.")
                    .optional(),
                source: z
                    .object({
                        images: z
                            .array(
                                z.object({
                                    id_upload: z.string(),
                                    description: z
                                        .string()
                                        .describe(
                                            "What is in the photo. Required: without it the model guesses.",
                                        ),
                                }),
                            )
                            .describe(
                                "from_images. The order IS the story: photo 3 the before, photo 7 the after.",
                            )
                            .optional(),
                        url: z.string().describe("from_text. The article, downloaded now.").optional(),
                        text: z
                            .string()
                            .describe("from_text. The article pasted by hand. Wins over url when both come.")
                            .optional(),
                        id_integration_catalog: z
                            .string()
                            .describe(
                                "from_catalog, from a connected shop: its id from list_store_products. " +
                                    "Exclusive with id_account_catalog.",
                            )
                            .optional(),
                        id_account_catalog: z
                            .string()
                            .describe(
                                "from_catalog, from a Meta catalogue: the account whose catalogue to read.",
                            )
                            .optional(),
                        product_catalog_id: z
                            .string()
                            .describe("from_catalog with id_account_catalog only: the Meta catalogue id.")
                            .optional(),
                        products: z
                            .array(z.string())
                            .describe(
                                "from_catalog. Product ids, in the order of the week (list_store_products " +
                                    "for a shop). Out-of-stock ones are refused.",
                            )
                            .optional(),
                        event_name: z
                            .string()
                            .describe("campaign. What the countdown is towards.")
                            .optional(),
                        event_date: z
                            .string()
                            .describe("campaign. A CALENDAR DAY, YYYY-MM-DD, never an ISO instant.")
                            .optional(),
                    })
                    .describe(
                        "The source, whose fields depend on template. Required for every template " +
                            "except standard, and validated in THIS call, so a broken URL or a " +
                            "missing product fails while the user is still there.",
                    )
                    .optional(),
                options: z
                    .object({
                        publish_days: z
                            .array(z.number().int().min(1).max(7))
                            .describe(
                                "ISO weekdays, 1 = Monday. Defaults to the whole week. This bounds the cost.",
                            )
                            .optional(),
                        timezone: z.string().describe("IANA timezone. Defaults to Europe/Madrid.").optional(),
                        language: z.string().describe("Language of the texts. Defaults to es.").optional(),
                        tone: z.string().describe("Optional tone, e.g. 'cercano', 'profesional'.").optional(),
                        allow_images: z
                            .boolean()
                            .describe("Whether images may be generated. Each one costs 70 credits.")
                            .optional(),
                        max_images: z.number().int().min(0).describe("Cap on generated images.").optional(),
                        shared: z
                            .boolean()
                            .describe(
                                "One post per day replicated across every account instead of one " +
                                    "per account and day. Cheaper. from_images and from_catalog " +
                                    "reject it.",
                            )
                            .optional(),
                        week_start: z
                            .string()
                            .describe("ISO 8601. The week to plan. Defaults to now.")
                            .optional(),
                        link: z
                            .string()
                            .describe(
                                "Pinterest: the URL every pin of the plan leads to. Dropped when the " +
                                    "plan has no Pinterest account.",
                            )
                            .optional(),
                    })
                    .optional(),
                destinations: z
                    .array(
                        z.object({
                            id_account: z.string().describe("A Pinterest account of the plan."),
                            destination_id: z.string().describe("A board id from list_destinations."),
                        }),
                    )
                    .describe(
                        "REQUIRED for every Pinterest account in the plan: the board where all its " +
                            "pins go, one entry per account. Without it the plan is refused (2118).",
                    )
                    .optional(),
                id_organization: OrganizationArg,
            }),
            annotations: { readOnlyHint: false, openWorldHint: true },
            write: true,
            ai: true,
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const idClient = await context.resolveClient(idOrganization);

            //Se comprueba aquí y no se deja al 2112 del servidor por lo mismo que la trampa 13 en
            //`create_publication`: un error nuestro es inmediato y dice qué falta; el suyo es un
            //viaje de ida y vuelta para decir lo mismo peor. Y este viaje además factura al final.
            const template = args.template ?? "standard";
            if (template !== "standard" && !args.source) {
                throw new ToolInputError(
                    `The "${template}" template needs a source. Call get_planner_templates to see ` +
                        "which fields it takes.",
                );
            }
            //Las dos fuentes de `from_catalog` son EXCLUYENTES, y ninguna es un 2112 del servidor: los
            //dos casos se dicen aquí con lo que hay que hacer, en vez de un viaje para decirlo peor
            if (template === "from_catalog" && args.source) {
                const store = args.source.id_integration_catalog !== undefined;
                const meta = args.source.id_account_catalog !== undefined;
                if (store && meta) {
                    throw new ToolInputError(
                        "from_catalog reads ONE catalogue: pass id_integration_catalog (a connected shop) " +
                            "or id_account_catalog (a Meta catalogue), not both.",
                    );
                }
                if (!store && !meta) {
                    throw new ToolInputError(
                        "from_catalog needs where the products come from: id_integration_catalog for a " +
                            "connected shop (call list_store_products to get it and the product ids), or " +
                            "id_account_catalog with product_catalog_id for a Meta catalogue.",
                    );
                }
            }
            if (args.options?.week_start && Number.isNaN(Date.parse(args.options.week_start))) {
                throw new ToolInputError(
                    `week_start is not a valid ISO 8601 date: "${args.options.week_start}".`,
                );
            }

            const body = {
                prompt: args.prompt,
                accounts: args.accounts,
                ...(args.template === undefined ? {} : { template: args.template }),
                ...(args.source === undefined ? {} : { source: args.source }),
                ...(args.options === undefined ? {} : { options: args.options }),
                ...(args.destinations === undefined
                    ? {}
                    : {
                          destinations: args.destinations.map((entry) => ({
                              id_account: entry.id_account,
                              destination: { id: entry.destination_id },
                          })),
                      }),
            } as AiPlanCreateRequest;

            //TRAMPA 4, y aquí es la que más cara sale: un reintento del cliente sobre una llamada
            //que ya encoló un plan cobra el plan dos veces. La huella lleva lo que define el plan,
            //no la petición entera.
            const key = fingerprint("create_ai_plan", [
                idOrganization,
                args.prompt,
                template,
                args.accounts.join(","),
                args.options?.week_start,
            ]);
            const [result, alreadyExisted] = await context.dedupe.run(key, () =>
                context.pv.aiPlans.create(idClient, idOrganization, body),
            );

            const row = projectPlan(result.ai_plan);
            const estimate = result.estimate;
            const preface = alreadyExisted
                ? "This plan already existed: an identical one was queued moments ago, so nothing " +
                  "was charged twice. Below is the one that exists."
                : "Plan queued. Nothing is generated yet.";

            return toolOk(
                [
                    preface,
                    "",
                    asLines([row]),
                    "",
                    `base_cost: ${estimate.base_cost} credits (mandatory: orchestration + texts)`,
                    `estimated_cost: ${estimate.estimated_cost} credits (upper bound, images included)`,
                    `available_credits: ${estimate.available_credits}`,
                    `texts: ${estimate.texts_target}, images: ${estimate.images_target}`,
                    "",
                    "Generation runs in a separate job and can take minutes. Poll get_ai_plan with " +
                        `id_ai_plan ${row.id} until the state is generated, then show the user the ` +
                        "drafts before anything is scheduled.",
                ].join("\n"),
                {
                    ai_plan: row as unknown as Record<string, unknown>,
                    estimate: estimate as unknown as Record<string, unknown>,
                    already_existed: alreadyExisted,
                },
            );
        },
    );
}
