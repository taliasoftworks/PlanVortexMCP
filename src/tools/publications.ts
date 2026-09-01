/**
 * Publicar: cinco herramientas, y lo caro no son las llamadas sino lo que las rodea —la validación
 * previa contra los límites (§ trampa 13) y la caché anti-duplicado (§ trampa 4)—.
 *
 * No hay `delete_publication` y no es un olvido: **decisión 6 del roadmap**. Borrar no existe en
 * este servidor, y el motivo es la trampa 2 — este servidor lee texto escrito por desconocidos con
 * una herramienta de publicar cargada en la misma conversación. Si el peor caso posible de un
 * comentario malicioso es «publica algo que el usuario ve y borra», es una molestia; si es «borra
 * 4.000 contactos», es un incidente.
 */
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PublicationInput } from "planvortex";
import type { Context } from "../context.js";
import { toolOk, ToolInputError } from "../errors.js";
import {
    asLines,
    clampLimit,
    paginationNote,
    projectPublication,
    projectPublicationDetail,
} from "../format/project.js";
import { fingerprint } from "../dedupe.js";
import { knownNetworks, validatePublication } from "../limits.js";
import { defineTool } from "./register.js";

const OrganizationArg = z.string().describe("The PlanVortex organization id. Optional.").optional();

const PublicationView = z.object({
    id: z.string(),
    social_network: z.string(),
    state: z.string(),
    publication_type: z.string(),
    publish_date: z.string().optional(),
    text: z.string(),
    id_account: z.string(),
    errors: z.number(),
    url: z.string().optional(),
});

export function registerPublicationTools(server: McpServer, ctx: Context): void {
    defineTool(
        server,
        ctx,
        {
            name: "list_publications",
            title: "List publications",
            description:
                "Posts of an organization, newest first, as a short projection: id, network, " +
                "state, date and the first words of the text. States are draft, ready (scheduled), " +
                "publishing, sended (published) and withErrors. Use get_publication for the full " +
                "record of one, including why it failed.",
            inputSchema: z.object({
                id_organization: OrganizationArg,
                state: z
                    .array(z.enum(["draft", "ready", "publishing", "sended", "withErrors"]))
                    .describe("Filter by state. 'ready' is what a user calls 'scheduled'.")
                    .optional(),
                social_network: z.array(z.string()).optional(),
                from_date: z.string().describe("ISO 8601 date, inclusive.").optional(),
                to_date: z.string().describe("ISO 8601 date, inclusive.").optional(),
                search: z.string().describe("Free text search over the post text.").optional(),
                limit: z.number().int().min(1).max(50).optional(),
                offset: z.number().int().min(0).optional(),
            }),
            outputSchema: z.object({ publications: z.array(PublicationView), total: z.number() }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const page = await context.pv.publications.list(idOrganization, {
                limit: clampLimit(args.limit),
                ...(args.offset === undefined ? {} : { offset: args.offset }),
                ...(args.state === undefined ? {} : { state: args.state }),
                ...(args.social_network === undefined ? {} : { social_network: args.social_network }),
                ...(args.from_date === undefined ? {} : { from_date: args.from_date }),
                ...(args.to_date === undefined ? {} : { to_date: args.to_date }),
                ...(args.search === undefined ? {} : { search: args.search }),
            });
            const publications = page.data.map(projectPublication);
            const note = paginationNote(publications.length, page.total, args.offset ?? 0);
            return toolOk(`${asLines(publications)}\n\n${note}`.trim(), {
                publications,
                total: page.total,
            });
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "get_publication",
            title: "Get one publication",
            description:
                "The full record of one post, including publication_errors — the list of reasons " +
                "it did not go out. This is the tool to call when the user asks why a post failed.",
            inputSchema: z.object({
                id_publication: z.string(),
                id_organization: OrganizationArg,
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const publication = await context.pv.publications.get(idOrganization, args.id_publication);
            const detail = projectPublicationDetail(publication);
            return toolOk(asLines([detail]));
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "create_publication",
            title: "Create or schedule a post",
            description:
                "Publish now or schedule a post on ONE connected account. Pass state 'ready' with " +
                "a future publish_date to schedule, or 'draft' to leave it for a person to review. " +
                "Media has to be uploaded first with upload_media; pass the returned ids in files. " +
                "The text is validated against the network's limits before anything is sent. " +
                "Always show the user what you are about to publish and let them confirm it: this " +
                "posts publicly under their brand.",
            inputSchema: z.object({
                id_account: z
                    .string()
                    .describe("The connected account to publish on. One post, one account."),
                social_network: z
                    .string()
                    .describe("The account's network: instagram, facebook, linkedin, telegram…"),
                text: z.string().describe("The post body.").optional(),
                title: z
                    .string()
                    .describe("Only on networks with a title field, such as YouTube.")
                    .optional(),
                files: z.array(z.string()).describe("Upload ids from upload_media.").optional(),
                publish_date: z.string().describe("ISO 8601. Leave empty to publish immediately.").optional(),
                state: z
                    .enum(["draft", "ready"])
                    .describe(
                        "'ready' publishes or schedules it; 'draft' just saves it. A post with " +
                            "problems is stored as 'withErrors' either way, and does not go out.",
                    )
                    .default("ready"),
                publication_type: z.enum(["profile", "page", "group", "reels", "stories"]).default("profile"),
                id_organization: OrganizationArg,
            }),
            outputSchema: z.object({ publication: PublicationView, already_existed: z.boolean() }),
            annotations: { readOnlyHint: false, openWorldHint: true },
            write: true,
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);

            //TRAMPA 13: la validación previa es la única de las tres copias de los límites que no
            //se puede saltar. Un error nuestro es inmediato y dice qué cambiar; un 907 del
            //servidor es un viaje de ida y vuelta para decir lo mismo peor.
            const limits = await context.pv.catalog.socialLimits();
            const networks = knownNetworks(limits);
            if (networks.length > 0 && !networks.includes(args.social_network)) {
                throw new ToolInputError(
                    `"${args.social_network}" is not a PlanVortex network. Known networks: ` +
                        `${networks.join(", ")}. Call list_accounts to see which ones are connected.`,
                );
            }
            const problems = validatePublication(limits, {
                social_network: args.social_network,
                text: args.text,
                title: args.title,
                files: args.files,
            });
            if (problems.length > 0) {
                throw new ToolInputError(
                    `This post cannot be published as it is:\n${problems
                        .map((problem) => `- ${problem.message}`)
                        .join("\n")}`,
                );
            }

            if (args.publish_date && Number.isNaN(Date.parse(args.publish_date))) {
                throw new ToolInputError(
                    `publish_date is not a valid ISO 8601 date: "${args.publish_date}".`,
                );
            }

            const body: PublicationInput = {
                social_network: args.social_network,
                state: args.state,
                publication_type: args.publication_type,
                ...(args.text === undefined ? {} : { text: args.text }),
                ...(args.title === undefined ? {} : { title: args.title }),
                ...(args.files === undefined ? {} : { files: args.files }),
                ...(args.publish_date === undefined ? {} : { publish_date: args.publish_date }),
            } as PublicationInput;

            //TRAMPA 4: si el cliente MCP se cansó de esperar, el modelo vuelve a llamar. Sin esto,
            //eso son dos publicaciones idénticas en Instagram y la API no tiene clave de
            //idempotencia que lo impida.
            const key = fingerprint("create_publication", [
                idOrganization,
                args.id_account,
                args.text,
                args.publish_date,
            ]);
            const [publication, alreadyExisted] = await context.dedupe.run(key, () =>
                context.pv.publications.create(idOrganization, args.id_account, body),
            );

            const view = projectPublication(publication);
            const preface = alreadyExisted
                ? "This post already existed: an identical one was created moments ago, so nothing " +
                  "was published twice. Here it is.\n\n"
                : "";
            //Una publicación puede CREARSE bien y no salir: el servidor la guarda en `withErrors`
            //con el motivo dentro, y eso llega como respuesta correcta, no como excepción. Sin
            //esto el modelo leía `state: withErrors, errors: 2` y tenía que ir a `get_publication`
            //a preguntar por qué, o —peor— daba el post por publicado. Lo vio la capa 3 al crear
            //un borrador de YouTube sin título ni vídeo. Ni siquiera `draft` gana a esto: una
            //publicación con problemas se guarda en `withErrors` aunque se pidiera borrador.
            const details = publication.publication_errors ?? [];
            const why =
                details.length === 0
                    ? ""
                    : `\n\nIt was SAVED but it will NOT go out as it is:\n` +
                      details.map((detail) => `- [${detail.code}] ${detail.message}`).join("\n") +
                      `\n\nFix it with update_publication; nothing has been sent to the network.`;
            return toolOk(`${preface}${asLines([view])}${why}`, {
                publication: view,
                already_existed: alreadyExisted,
            });
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "update_publication",
            title: "Update a pending post",
            description:
                "Change the text, media or scheduled date of a post that has NOT gone out yet " +
                "(state draft or ready). A published post cannot be edited through PlanVortex; if " +
                "you try, the error will say so.",
            inputSchema: z.object({
                id_publication: z.string(),
                text: z.string().optional(),
                title: z.string().optional(),
                files: z.array(z.string()).optional(),
                publish_date: z.string().describe("ISO 8601.").optional(),
                state: z.enum(["draft", "ready"]).optional(),
                id_organization: OrganizationArg,
            }),
            outputSchema: z.object({ publication: PublicationView }),
            annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
            write: true,
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const current = await context.pv.publications.get(idOrganization, args.id_publication);
            if (current.state === "sended" || current.state === "publishing") {
                throw new ToolInputError(
                    `This post is already ${current.state === "sended" ? "published" : "being published"} ` +
                        "and cannot be edited. Create a new post instead.",
                );
            }
            if (args.text !== undefined) {
                const limits = await context.pv.catalog.socialLimits();
                const problems = validatePublication(limits, {
                    social_network: String(current.social_network),
                    text: args.text,
                    title: args.title ?? current.title,
                    files: args.files,
                });
                if (problems.length > 0) {
                    throw new ToolInputError(
                        `This edit cannot be saved:\n${problems
                            .map((problem) => `- ${problem.message}`)
                            .join("\n")}`,
                    );
                }
            }
            const publication = await context.pv.publications.update(idOrganization, args.id_publication, {
                ...(args.text === undefined ? {} : { text: args.text }),
                ...(args.title === undefined ? {} : { title: args.title }),
                ...(args.files === undefined ? {} : { files: args.files }),
                ...(args.publish_date === undefined ? {} : { publish_date: args.publish_date }),
                ...(args.state === undefined ? {} : { state: args.state }),
            });
            const view = projectPublication(publication);
            return toolOk(asLines([view]), { publication: view });
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "retry_publication",
            title: "Retry a failed post",
            description:
                "Ask PlanVortex to try a failed post again. Read get_publication first: if it " +
                "failed because the text is too long or the account is disconnected, retrying " +
                "changes nothing until that is fixed.",
            inputSchema: z.object({
                id_publication: z.string(),
                id_organization: OrganizationArg,
            }),
            outputSchema: z.object({ publication: PublicationView, max_retries: z.number() }),
            annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
            write: true,
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const result = await context.pv.publications.retry(idOrganization, args.id_publication);
            const view = projectPublication(result.publication);
            return toolOk(`${asLines([view])}\n\nretries allowed: ${result.max_retries}`, {
                publication: view,
                max_retries: result.max_retries,
            });
        },
    );
}
