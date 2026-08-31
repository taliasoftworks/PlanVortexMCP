/**
 * Las cuatro herramientas de contexto: dónde estoy, con qué cuentas, cuánto plan me queda y qué
 * tengo hoy. Todas de lectura.
 *
 * `list_organizations` es la que desatasca la trampa 1, y por eso va la primera del catálogo: es la
 * herramienta a la que el modelo tiene que llegar solo cuando otra le dice que faltaba el id.
 */
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Context } from "../context.js";
import { toolOk } from "../errors.js";
import {
    asLines,
    clampLimit,
    paginationNote,
    projectAccount,
    projectOrganization,
} from "../format/project.js";
import { defineTool } from "./register.js";

const OrganizationArg = z
    .string()
    .describe(
        "The PlanVortex organization id. Optional: if this app reaches a single organization, or " +
            "the server was configured with a default one, it is resolved automatically.",
    )
    .optional();

export function registerContextTools(server: McpServer, ctx: Context): void {
    defineTool(
        server,
        ctx,
        {
            name: "list_organizations",
            title: "List organizations",
            description:
                "List the PlanVortex organizations this app can reach, with their ids. Call this " +
                "first when a tool says id_organization is required, or when the user names an " +
                "organization you do not have an id for.",
            inputSchema: z.object({}),
            outputSchema: z.object({
                organizations: z.array(z.object({ id: z.string(), name: z.string() })),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (_args, context) => {
            const organizations = (await context.listOrganizations()).map(projectOrganization);
            const text =
                organizations.length === 0
                    ? "This app does not reach any organization yet."
                    : asLines(organizations);
            return toolOk(text, { organizations });
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "list_accounts",
            title: "List connected accounts",
            description:
                "The social accounts connected to an organization: network, name, follower count " +
                "and whether the connection is broken. An account with error_code other than 0 " +
                "cannot publish until a person reconnects it, and that is usually the answer to " +
                "'why did this post not go out'.",
            inputSchema: z.object({
                id_organization: OrganizationArg,
                social_network: z
                    .array(z.string())
                    .describe("Filter by network, e.g. ['instagram', 'linkedin'].")
                    .optional(),
                capability: z
                    .enum(["publications", "messages", "products", "webhooks", "persistent_menu", "comments"])
                    .describe("Only accounts whose network supports this capability.")
                    .optional(),
                limit: z.number().int().min(1).max(50).optional(),
                offset: z.number().int().min(0).optional(),
            }),
            outputSchema: z.object({
                accounts: z.array(
                    z.object({
                        id: z.string(),
                        social_network: z.string(),
                        name: z.string(),
                        username: z.string().optional(),
                        followers: z.number().optional(),
                        error_code: z.number(),
                        healthy: z.boolean(),
                    }),
                ),
                total: z.number(),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const page = await context.pv.accounts.list(idOrganization, {
                limit: clampLimit(args.limit),
                ...(args.offset === undefined ? {} : { offset: args.offset }),
                ...(args.social_network === undefined ? {} : { social_network: args.social_network }),
                ...(args.capability === undefined ? {} : { capability: args.capability }),
            });
            const accounts = page.data.map(projectAccount);
            const broken = accounts.filter((account) => !account.healthy);
            const warning =
                broken.length === 0
                    ? ""
                    : `\n\n${broken.length} account(s) are in error and cannot publish: ` +
                      `${broken.map((account) => account.name).join(", ")}. ` +
                      "Reconnecting needs a person — use create_connect_link.";
            const note = paginationNote(accounts.length, page.total, args.offset ?? 0);
            return toolOk(`${asLines(accounts)}\n\n${note}${warning}`.trim(), {
                accounts,
                total: page.total,
            });
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "get_plan_use",
            title: "Get plan usage",
            description:
                "What the organization's plan allows and what it has already used: publications, " +
                "accounts, storage and integrations. Check this before promising the user a batch " +
                "of posts — a plan limit is not a transient error and retrying never fixes it.",
            inputSchema: z.object({ id_organization: OrganizationArg }),
            outputSchema: z.object({
                limits: z.record(z.string(), z.unknown()),
                used: z.record(z.string(), z.unknown()),
                assigned: z.record(z.string(), z.unknown()),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const use = await context.pv.dashboard.use(idOrganization);
            const rows = [
                { metric: "publications", used: use.actual_use.publications, limit: use.limits.publications },
                { metric: "accounts", used: use.actual_use.accounts, limit: use.limits.accounts },
                { metric: "storage_mb", used: use.actual_use.space, limit: use.limits.space },
                { metric: "integrations", used: use.actual_use.integrations, limit: use.limits.integrations },
            ];
            return toolOk(asLines(rows), {
                limits: use.limits,
                used: use.actual_use,
                assigned: use.actual_asigned,
            });
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "get_unread_counts",
            title: "Get unread counts",
            description:
                "How many comments and private messages are waiting, in one call. This is the " +
                "'what do I have today?' tool: start here, then use list_comments or " +
                "list_conversations to see what they are.",
            inputSchema: z.object({ id_organization: OrganizationArg }),
            outputSchema: z.object({ unread_comments: z.number(), unread_messages: z.number() }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            //Las dos a la vez: son independientes y el cubo de fichas las serializa igual.
            const [comments, messages] = await Promise.all([
                context.pv.comments.unreadCount(idOrganization),
                context.pv.messages.unreadCount(idOrganization),
            ]);
            return toolOk(`unread comments: ${comments}\nunread private messages: ${messages}`, {
                unread_comments: comments,
                unread_messages: messages,
            });
        },
    );
}
