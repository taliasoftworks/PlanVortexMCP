/**
 * CAPA 1 — los planes de IA, que son la única herramienta de este servidor que GASTA DINERO.
 *
 * Fichero propio y no un `describe` más en `tools.test.ts` por lo mismo que lo tienen las cuatro
 * suites de aquí: lo que se fija abajo no es que la herramienta funcione, es que **no se encienda
 * sola y que no cobre dos veces**. Son dos invariantes de producto, no de código, y el día que
 * alguien mueva el gate quiere encontrarlos juntos.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { BASE_URL, api, isError, textOf, withServer } from "./helpers.js";

beforeAll(() => api.listen({ onUnhandledRequest: "error" }));
afterEach(() => api.resetHandlers());
afterAll(() => api.close());

const ORG_A = { _id: "org-a", name: "Panadería Norte" };

function organizations(...items: object[]) {
    return http.get(`${BASE_URL}/clients_organizations`, () =>
        HttpResponse.json({
            clients: [{ _id: "client-1", name: "Panadería", organizations: items, total: items.length }],
            total: 1,
        }),
    );
}

const PLAN = {
    _id: "plan-1",
    state: "pending",
    template: "standard",
    prompt: "Pan de masa madre, horno de leña, barrio",
    accounts: ["acc-1"],
    publications: [],
    credits_spent: 0,
    creation_date: "2026-09-04T10:00:00.000Z",
};

const ESTIMATE = {
    available_credits: 2000,
    base_cost: 120,
    estimated_cost: 519,
    images_target: 7,
    texts_target: 7,
};

const createHandler = (onCall?: () => void) =>
    http.post(`${BASE_URL}/clients/client-1/organizations/org-a/ai_plans`, () => {
        onCall?.();
        return HttpResponse.json({ ai_plan: PLAN, estimate: ESTIMATE, estimated_cost: 519 });
    });

describe("el gate de PLANVORTEX_MCP_ALLOW_AI", () => {
    it("por defecto create_ai_plan NO está en el listado, y las tres de lectura sí", async () => {
        const harness = await withServer();
        const listed = (await harness.client.listTools()).tools.map((tool) => tool.name);
        expect(listed).not.toContain("create_ai_plan");
        expect(listed).toContain("get_planner_templates");
        expect(listed).toContain("list_ai_plans");
        expect(listed).toContain("get_ai_plan");
        await harness.close();
    });

    it("lo que no está en el listado no se puede llamar", async () => {
        const harness = await withServer();
        //Error de PROTOCOLO, y debe serlo: el gate actúa en el registro, no en el handler. Si esto
        //devolviera `isError` querría decir que la herramienta existe y algo la está rechazando,
        //que es justo la forma de apagado que este servidor decidió no usar.
        await expect(harness.client.callTool({ name: "create_ai_plan", arguments: {} })).rejects.toThrow();
        await harness.close();
    });

    it("con el gate encendido sí está, y son treinta y dos", async () => {
        const harness = await withServer({ allowAiPlans: true });
        const listed = (await harness.client.listTools()).tools.map((tool) => tool.name);
        expect(listed).toContain("create_ai_plan");
        expect(listed).toHaveLength(32);
        await harness.close();
    });

    it("READ_ONLY gana sobre ALLOW_AI: un servidor de sólo lectura no crea planes", async () => {
        //Las dos banderas juntas es el caso que un despliegue real acaba teniendo, y el orden
        //importa: `create_ai_plan` escribe, y un servidor declarado de sólo lectura no escribe.
        const harness = await withServer({ allowAiPlans: true, readOnly: true });
        const listed = (await harness.client.listTools()).tools.map((tool) => tool.name);
        expect(listed).not.toContain("create_ai_plan");
        expect(listed).toContain("list_ai_plans");
        await harness.close();
    });

    it("las de lectura dicen POR QUÉ no está la de crear", async () => {
        //Un modelo que encuentra el listado y no encuentra con qué crear concluye lo más barato
        //—que no se puede— y se pone a escribir la semana él mismo, que es exactamente lo que este
        //servidor existe para no tener que hacer.
        const harness = await withServer();
        const tools = (await harness.client.listTools()).tools;
        for (const name of ["get_planner_templates", "list_ai_plans"]) {
            const tool = tools.find((candidate) => candidate.name === name);
            expect(tool?.description, name).toContain("PLANVORTEX_MCP_ALLOW_AI");
        }
        await harness.close();
    });
});

describe("el ciclo de un plan", () => {
    const TEMPLATES = [
        {
            template: "standard",
            orchestration_cost: 30,
            orchestration_cost_per_source_item: 0,
            generates_images: true,
            max_source_items: 0,
            allows_shared: true,
            allows_gallery: true,
            source_fields: [],
        },
        {
            template: "from_images",
            orchestration_cost: 48,
            orchestration_cost_per_source_item: 4,
            generates_images: false,
            max_source_items: 20,
            allows_shared: false,
            allows_gallery: false,
            source_fields: [{ name: "images" }],
        },
    ];

    it("get_planner_templates publica los costes y dice cuál no gasta créditos de imagen", async () => {
        api.use(
            organizations(ORG_A),
            http.get(`${BASE_URL}/planner_templates`, () => HttpResponse.json({ templates: TEMPLATES })),
        );
        const harness = await withServer();
        const result = await harness.client.callTool({ name: "get_planner_templates", arguments: {} });
        expect(isError(result)).toBe(false);
        const text = textOf(result);
        expect(text).toContain("from_images");
        expect(text).toContain("orchestration_cost: 48");
        expect(text).toContain("generates_images: false");
        //El número que decide si el usuario elige una plantilla u otra.
        expect(text).toContain("70 credits");
        await harness.close();
    });

    it("saca el id_client de la organización, en vez de pedírselo al modelo", async () => {
        //Las rutas de planes cuelgan de los DOS identificadores y son las únicas de este servidor
        //que lo hacen. Un `id_client` pedido por parámetro es un id que el modelo se inventa.
        let path = "";
        api.use(
            organizations(ORG_A),
            http.get(`${BASE_URL}/clients/client-1/organizations/org-a/ai_plans`, ({ request }) => {
                path = new URL(request.url).pathname;
                return HttpResponse.json({ ai_plans: [], total: 0 });
            }),
        );
        const harness = await withServer();
        const result = await harness.client.callTool({ name: "list_ai_plans", arguments: {} });
        expect(isError(result)).toBe(false);
        expect(path).toContain("/clients/client-1/organizations/org-a/ai_plans");
        await harness.close();
    });

    it("crear devuelve el PRESUPUESTO y manda a sondear, porque no devuelve publicaciones", async () => {
        api.use(organizations(ORG_A), createHandler());
        const harness = await withServer({ allowAiPlans: true });
        const result = await harness.client.callTool({
            name: "create_ai_plan",
            arguments: { prompt: "Pan de masa madre, horno de leña, barrio", accounts: ["acc-1"] },
        });
        expect(isError(result)).toBe(false);
        const text = textOf(result);
        expect(text).toContain("base_cost: 120");
        expect(text).toContain("estimated_cost: 519");
        expect(text).toContain("state: pending");
        //Lo que evita que el modelo se quede esperando publicaciones que todavía no existen.
        expect(text).toContain("get_ai_plan");
        await harness.close();
    });

    it("TRAMPA 4, y aquí cuesta dinero: dos creaciones idénticas son UNA llamada", async () => {
        let posts = 0;
        api.use(
            organizations(ORG_A),
            createHandler(() => {
                posts += 1;
            }),
        );
        const harness = await withServer({ allowAiPlans: true });
        const args = { prompt: "Pan de masa madre, horno de leña, barrio", accounts: ["acc-1"] };
        await harness.client.callTool({ name: "create_ai_plan", arguments: args });
        const second = await harness.client.callTool({ name: "create_ai_plan", arguments: args });
        expect(posts).toBe(1);
        expect(textOf(second)).toContain("already existed");
        await harness.close();
    });

    it("una plantilla sin fuente falla AQUÍ, antes de salir a la red", async () => {
        //Sin este corte el viaje entero se hace para volver con un 2112, y ese viaje factura.
        api.use(organizations(ORG_A));
        const harness = await withServer({ allowAiPlans: true });
        const result = await harness.client.callTool({
            name: "create_ai_plan",
            arguments: { prompt: "La carta nueva", accounts: ["acc-1"], template: "from_text" },
        });
        expect(isError(result)).toBe(true);
        expect(textOf(result)).toContain("needs a source");
        await harness.close();
    });

    it("get_ai_plan da los IDS de las publicaciones, no un recuento a secas", async () => {
        api.use(
            organizations(ORG_A),
            http.get(`${BASE_URL}/clients/client-1/organizations/org-a/ai_plans/plan-1`, () =>
                HttpResponse.json({
                    ai_plan: {
                        ...PLAN,
                        state: "generated",
                        template: "from_images",
                        publications: [{ _id: "pub-1" }, { _id: "pub-2" }],
                        credits_spent: 96,
                        warnings: [{ code: 2117, message: "Some source items did not fit." }],
                    },
                }),
            ),
        );
        const harness = await withServer();
        const result = await harness.client.callTool({
            name: "get_ai_plan",
            arguments: { id_ai_plan: "plan-1" },
        });
        expect(isError(result)).toBe(false);
        const text = textOf(result);
        //Sin los ids, la herramienta cuenta dos borradores que el modelo no sabe abrir.
        expect(text).toContain("publication_ids: pub-1, pub-2");
        expect(text).toContain("credits_spent: 96");
        expect(text).toContain("warning: 2117");
        await harness.close();
    });

    it("un plan que sigue generándose se dice, para que el modelo no cree otro", async () => {
        api.use(
            organizations(ORG_A),
            http.get(`${BASE_URL}/clients/client-1/organizations/org-a/ai_plans/plan-1`, () =>
                HttpResponse.json({ ai_plan: { ...PLAN, state: "generating" } }),
            ),
        );
        const harness = await withServer();
        const result = await harness.client.callTool({
            name: "get_ai_plan",
            arguments: { id_ai_plan: "plan-1" },
        });
        expect(textOf(result)).toContain("Poll this tool again");
        await harness.close();
    });
});

/**
 * Las tiendas. `from_catalog` desde una tienda pide los ids de SUS productos, y sin esta herramienta
 * el modelo sólo podría inventárselos. Lo que se fija: que sin tienda contesta con las tiendas (y
 * sólo con las integraciones que tienen catálogo, según el catálogo de proveedores y no una lista de
 * aquí), que lo agotado se dice, que el cursor se devuelve tal cual, y que el 2219 no se lee como un
 * fallo.
 */
describe("list_store_products", () => {
    const PROVIDERS = [
        { provider: "google_drive", catalog: false },
        { provider: "rss", catalog: false },
        { provider: "woocommerce", catalog: true },
    ];
    const STORE = {
        _id: "int-woo",
        id_organization: "org-a",
        id_client: "client-1",
        provider: "woocommerce",
        name: "Tienda Norte",
        external_identifier: "https://tienda.example.com",
        config: { url: "https://tienda.example.com", key_ending: "3f9a2c1", tax_location_missing: true },
        enabled: true,
        connected: true,
        creation_date: "2026-09-28T10:00:00.000Z",
    };

    function catalog(integrations: object[]) {
        return [
            http.get(`${BASE_URL}/integration_providers`, () => HttpResponse.json({ providers: PROVIDERS })),
            http.get(`${BASE_URL}/organizations/org-a/integrations`, () =>
                HttpResponse.json({ integrations, total: integrations.length }),
            ),
        ];
    }

    it("es de lectura: está en el listado sin encender el gate", async () => {
        const harness = await withServer();
        const listed = (await harness.client.listTools()).tools.map((tool) => tool.name);
        expect(listed).toContain("list_store_products");
        await harness.close();
    });

    it("sin id_integration lista las TIENDAS, y ni un Drive ni un feed", async () => {
        api.use(
            organizations(ORG_A),
            ...catalog([
                STORE,
                { ...STORE, _id: "int-drive", provider: "google_drive", name: "Drive" },
                { ...STORE, _id: "int-new", name: "Tienda Sur", connected: false, error_code: 2219 },
            ]),
        );
        const harness = await withServer();
        const result = await harness.client.callTool({ name: "list_store_products", arguments: {} });
        expect(isError(result)).toBe(false);
        const text = textOf(result);
        expect(text).toContain("id_integration: int-woo");
        expect(text).not.toContain("int-drive");
        //El 2219 no es un fallo: la tienda se conectó hace un momento
        expect(text).toContain("being checked");
        //Y los precios que la tienda esconde por su ajuste de impuestos se avisan antes de elegir
        expect(text).toContain("tax setting");
        await harness.close();
    });

    it("sin tiendas dice que conectar una necesita a una persona", async () => {
        api.use(organizations(ORG_A), ...catalog([]));
        const harness = await withServer();
        const result = await harness.client.callTool({ name: "list_store_products", arguments: {} });
        expect(textOf(result)).toContain("needs a person");
        await harness.close();
    });

    it("con id_integration lee una página, marca lo agotado y devuelve el cursor tal cual", async () => {
        let query = new URLSearchParams();
        api.use(
            organizations(ORG_A),
            http.get(`${BASE_URL}/organizations/org-a/integrations/int-woo/products`, ({ request }) => {
                query = new URL(request.url).searchParams;
                return HttpResponse.json({
                    items: [
                        {
                            external_id: "68",
                            name: "Taza de cerámica",
                            price: "14,52 € IVA incluido",
                            available: true,
                        },
                        { external_id: "71", name: "Zapatillas", available: false },
                    ],
                    next_cursor: "p3",
                });
            }),
        );
        const harness = await withServer();
        const result = await harness.client.callTool({
            name: "list_store_products",
            arguments: { id_integration: "int-woo", search: "taza", cursor: "p2" },
        });
        expect(isError(result)).toBe(false);
        const text = textOf(result);
        expect(query.get("search")).toBe("taza");
        expect(query.get("cursor")).toBe("p2");
        expect(text).toContain("id: 68");
        expect(text).toContain("price: 14,52 € IVA incluido");
        expect(text).toContain("NO, out of stock");
        expect(text).toContain("cursor p3");
        //Lo que hace útil la lista: cómo se pasa al plan
        expect(text).toContain('id_integration_catalog: "int-woo"');
        await harness.close();
    });

    it("un cortafuegos delante de la tienda no se lee como una clave mala", async () => {
        api.use(
            organizations(ORG_A),
            http.get(`${BASE_URL}/organizations/org-a/integrations/int-woo/products`, () =>
                HttpResponse.json(
                    {
                        code: 2212,
                        message: "A firewall or security plugin in front of the store blocked the request",
                    },
                    { status: 400 },
                ),
            ),
        );
        const harness = await withServer();
        const result = await harness.client.callTool({
            name: "list_store_products",
            arguments: { id_integration: "int-woo" },
        });
        expect(isError(result)).toBe(true);
        const text = textOf(result);
        expect(text).toContain("2212");
        expect(text).toContain("hosting has to let PlanVortex's server through");
        expect(text).not.toContain("reconnect the shop");
        await harness.close();
    });
});

describe("create_ai_plan desde una tienda", () => {
    it("manda id_integration_catalog y los productos en el orden de la semana", async () => {
        let body: Record<string, unknown> = {};
        api.use(
            organizations(ORG_A),
            http.post(`${BASE_URL}/clients/client-1/organizations/org-a/ai_plans`, async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json({
                    ai_plan: { ...PLAN, template: "from_catalog" },
                    estimate: ESTIMATE,
                });
            }),
        );
        const harness = await withServer({ allowAiPlans: true });
        const result = await harness.client.callTool({
            name: "create_ai_plan",
            arguments: {
                prompt: "Lo nuevo de la tienda",
                accounts: ["acc-1"],
                template: "from_catalog",
                source: { id_integration_catalog: "int-woo", products: ["68", "71"] },
            },
        });
        expect(isError(result)).toBe(false);
        expect(body["source"]).toEqual({ id_integration_catalog: "int-woo", products: ["68", "71"] });
        await harness.close();
    });

    it("las dos fuentes a la vez, o ninguna, fallan AQUÍ y dicen qué hacer", async () => {
        api.use(organizations(ORG_A));
        const harness = await withServer({ allowAiPlans: true });
        const both = await harness.client.callTool({
            name: "create_ai_plan",
            arguments: {
                prompt: "Lo nuevo",
                accounts: ["acc-1"],
                template: "from_catalog",
                source: { id_integration_catalog: "int-woo", id_account_catalog: "acc-1", products: ["68"] },
            },
        });
        expect(isError(both)).toBe(true);
        expect(textOf(both)).toContain("not both");

        const neither = await harness.client.callTool({
            name: "create_ai_plan",
            arguments: {
                prompt: "Lo nuevo",
                accounts: ["acc-1"],
                template: "from_catalog",
                source: { products: ["68"] },
            },
        });
        expect(isError(neither)).toBe(true);
        expect(textOf(neither)).toContain("list_store_products");
        await harness.close();
    });

    it("el 2120 dice qué cuentas sobran, y que no se ha cobrado nada", async () => {
        api.use(
            organizations(ORG_A),
            http.post(`${BASE_URL}/clients/client-1/organizations/org-a/ai_plans`, () =>
                HttpResponse.json(
                    {
                        code: 2120,
                        message:
                            "An account of the AI plan is on a social network this planner template cannot publish to",
                        data: {
                            template: "from_catalog",
                            accounts: [{ _id: "acc-yt", social_network: "youtube" }],
                        },
                    },
                    { status: 400 },
                ),
            ),
        );
        const harness = await withServer({ allowAiPlans: true });
        const result = await harness.client.callTool({
            name: "create_ai_plan",
            arguments: {
                prompt: "Lo nuevo",
                accounts: ["acc-1", "acc-yt"],
                template: "from_catalog",
                source: { id_integration_catalog: "int-woo", products: ["68"] },
            },
        });
        expect(isError(result)).toBe(true);
        const text = textOf(result);
        expect(text).toContain("acc-yt (youtube)");
        expect(text).toContain("Nothing was charged");
        expect(text).toContain("unsupported_networks");
        await harness.close();
    });
});

describe("los resultados de los planes", () => {
    const GROUP = {
        plans: 2,
        ranked_plans: 1,
        publications: { published: 10, measured: 8 },
        metrics: { engagement: 400 },
        engagement_per_publication: 50,
        credits_spent: 567,
        credits_per_engagement: 1.42,
    };
    const RESULT = {
        id_ai_plan: "plan-1",
        id_organization: "org-a",
        prompt: "Pan de masa madre, horno de leña, barrio",
        template: "from_images",
        state: "validated",
        week_start: "2026-08-24T00:00:00.000Z",
        creation_date: "2026-08-23T09:00:00.000Z",
        accounts: 1,
        social_networks: ["instagram"],
        credits_spent: 48,
        publications: { total: 7, published: 7, measured: 7, scheduled: 0, failed: 0 },
        metrics: { engagement: 350 },
        engagement_per_publication: 50,
        expected_engagement_per_publication: 31.25,
        engagement_vs_average: 1.6,
        ranked: true,
        maturing: false,
    };

    it("es de lectura: está en el listado sin encender el gate", async () => {
        const harness = await withServer();
        const listed = (await harness.client.listTools()).tools.map((tool) => tool.name);
        expect(listed).toContain("get_ai_plan_results");
        await harness.close();
    });

    it("dice qué plan y qué plantilla funcionan, y avisa de que ausente no es cero", async () => {
        let query = new URLSearchParams();
        api.use(
            organizations(ORG_A),
            http.get(`${BASE_URL}/clients/client-1/organizations/org-a/ai_plans/results`, ({ request }) => {
                query = new URL(request.url).searchParams;
                return HttpResponse.json({
                    range: { from_date: "2026-07-25T00:00:00.000Z", to_date: "2026-08-24T00:00:00.000Z" },
                    sort: "engagement_per_publication",
                    totals: GROUP,
                    by_template: [{ ...GROUP, template: "from_images" }],
                    ai_plans: [RESULT, { ...RESULT, id_ai_plan: "plan-2", ranked: false, maturing: true }],
                    total: 2,
                });
            }),
        );
        const harness = await withServer();
        const result = await harness.client.callTool({
            name: "get_ai_plan_results",
            arguments: { social_network: ["instagram"] },
        });
        expect(isError(result)).toBe(false);
        const text = textOf(result);
        expect(query.getAll("social_network")).toEqual(["instagram"]);
        expect(text).toContain("template: from_images");
        expect(text).toContain("engagement_per_post: 50");
        //Primero no es bueno: el cociente frente a sus propias publicaciones va en cada fila, y la nota lo explica
        expect(text).toContain("vs_your_average: 1.6x");
        expect(text).toContain("can still be below 1x");
        expect(text).toContain("ranked: false");
        //Lo que impide que el modelo lea un plan sin medir como «el peor»
        expect(text).toContain("not a bad plan");
        expect(text).toContain("never zero");
        //Sin `reach` en la fila: no se inventa un 0
        expect(text).not.toContain("reach");
        await harness.close();
    });

    it("sin resultados explica que cuenta la semana del plan, no su creación", async () => {
        api.use(
            organizations(ORG_A),
            http.get(`${BASE_URL}/clients/client-1/organizations/org-a/ai_plans/results`, () =>
                HttpResponse.json({
                    range: { from_date: "2026-07-25T00:00:00.000Z", to_date: "2026-08-24T00:00:00.000Z" },
                    sort: "engagement_per_publication",
                    totals: { ...GROUP, plans: 0, ranked_plans: 0 },
                    by_template: [],
                    ai_plans: [],
                    total: 0,
                }),
            ),
        );
        const harness = await withServer();
        const result = await harness.client.callTool({ name: "get_ai_plan_results", arguments: {} });
        expect(textOf(result)).toContain("the week it publishes in");
        await harness.close();
    });
});
