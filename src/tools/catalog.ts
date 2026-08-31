/**
 * El catálogo —qué sabe hacer cada red y hasta dónde llega— y el enlace de conexión.
 *
 * Las dos primeras existen por la TRAMPA 13: los límites viven en tres sitios a la vez y no es
 * duplicación. El `resource` es para el usuario que lo adjunta, **estas herramientas son para que
 * el modelo pueda preguntar**, y `limits.ts` es la copia que no se puede saltar. Muchos clientes
 * MCP no leen los resources por su cuenta, así que sin estas dos el modelo se quedaría sin forma de
 * consultar un límite antes de escribir un texto de 3.000 caracteres para X.
 *
 * `create_connect_link` es la TRAMPA 9, y en MCP escuece más que en la librería: conectar Instagram
 * es un OAuth **con una persona delante** pulsando «autorizar» en una pantalla de Meta, y una app
 * con `client_credentials` no puede hacerlo. Pero es literalmente lo primero que el usuario le va a
 * pedir al agente («conéctame la cuenta de Instagram»), y si la herramienta no existe, el modelo da
 * vueltas o —peor— se inventa que lo ha hecho. Así que existe, y lo que devuelve es un enlace de
 * quince minutos para que lo abra una persona. La descripción lo dice en la primera línea.
 */
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Context } from "../context.js";
import { toolOk } from "../errors.js";
import { asLines } from "../format/project.js";
import { defineTool } from "./register.js";

const OrganizationArg = z.string().describe("The PlanVortex organization id. Optional.").optional();

export function registerCatalogTools(server: McpServer, ctx: Context): void {
    defineTool(
        server,
        ctx,
        {
            name: "get_social_limits",
            title: "Get per-network limits",
            description:
                "The hard limits of every network: characters, post bytes, title length, number " +
                "of images, video duration and file size. Check these before writing a post — the " +
                "same text is fine on LinkedIn and rejected on X. Two of them are not " +
                "interchangeable: Bluesky counts BOTH 300 characters and 3000 bytes, and an emoji " +
                "is one character but several bytes.",
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (_args, context) => {
            const limits = await context.pv.catalog.socialLimits();
            const networks = Object.keys(limits.characters ?? {}).sort();
            const rows = networks.map((network) => ({
                network,
                characters: limits.characters?.[network],
                max_post_bytes: limits.max_post_bytes?.[network],
                title_characters: limits.title_characters?.[network],
                total_images: limits.total_images?.[network],
                video_seconds: limits.video_duration_in_seconds?.[network],
                max_file_mb: limits.max_file_size_mb?.[network],
                comment_characters: limits.comment_characters?.[network],
            }));
            return toolOk(
                `${asLines(rows)}\n\ntitle_characters 0 means the network has no title field at all.`,
            );
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "get_social_capabilities",
            title: "Get per-network capabilities",
            description:
                "What each network can actually do — publish, private messages, comments, " +
                "products, webhooks — plus the comment moderation matrix: whether a reply, a hide " +
                "or a delete is possible there. Not every network does everything: WhatsApp has " +
                "no wall, Google Business does not publish at all, and LinkedIn cannot hide a " +
                "comment. Check here before promising the user something.",
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (_args, context) => {
            const [capabilities, actions] = await Promise.all([
                context.pv.catalog.socialCapabilities(),
                context.pv.catalog.socialCommentActions(),
            ]);
            const rows = Object.keys(capabilities)
                .sort()
                .map((network) => {
                    const capability = capabilities[network];
                    const matrix = actions[network];
                    return {
                        network,
                        publications: capability?.publications,
                        messages: capability?.messages,
                        comments: capability?.comments,
                        products: capability?.products,
                        comment_reply: matrix?.reply,
                        comment_hide: matrix?.hide,
                        comment_delete_own: matrix?.delete_own,
                        comment_delete_others: matrix?.delete_others,
                    };
                });
            return toolOk(
                `${asLines(rows)}\n\nThis MCP server never deletes anything, so the delete columns ` +
                    "describe what the network allows, not what these tools do.",
            );
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "create_connect_link",
            title: "Create an account connection link",
            description:
                "Connecting a social account CANNOT be done by you: it is an OAuth flow with a " +
                "person clicking 'authorize' on the network's own screen. This tool returns a " +
                "single-use link that expires in fifteen minutes — give it to the user and ask " +
                "them to open it in their browser. Do not claim an account is connected until " +
                "list_accounts shows it.",
            inputSchema: z.object({
                social_network: z
                    .string()
                    .describe(
                        "The network to connect. It travels inside the token, so the link only " +
                            "works for this one.",
                    )
                    .optional(),
                id_organization: OrganizationArg,
            }),
            outputSchema: z.object({ url: z.string(), expires_at: z.string() }),
            annotations: { readOnlyHint: false, openWorldHint: false },
            write: true,
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const token = await context.pv.organizations.createConnectToken(idOrganization, {
                ...(args.social_network === undefined ? {} : { social_network: args.social_network }),
            });
            return toolOk(
                `Give this link to the user and ask them to open it in a browser. It works once ` +
                    `and expires at ${token.expires_at}:\n\n${token.url}\n\n` +
                    "You cannot open it yourself, and the account will not appear until a person " +
                    "finishes the authorization on the network's site.",
                { url: token.url, expires_at: token.expires_at },
            );
        },
    );
}
