/**
 * Los cuatro resources del catálogo.
 *
 * TRAMPA 13, la otra mitad: son datos estáticos y cacheables, así que son un `resource` de libro y
 * llevan un `ttlMs` alto. Pero **la lógica no depende nunca de ellos**, porque muchos clientes MCP
 * no los leen por su cuenta — los ofrecen para que el *usuario* los adjunte a mano—. Aquí están
 * como comodidad para ese usuario; quien de verdad valida es `limits.ts`, y quien deja preguntar al
 * modelo son `get_social_limits` y `get_social_capabilities`.
 *
 * `cacheScope: "private"` en los cuatro: aunque los límites sean iguales para todos, las
 * organizaciones son de este cliente y una caché compartida no tiene por qué distinguirlo.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { Context } from "../context.js";
import { projectOrganization } from "../format/project.js";

/** Una hora. Los límites de una red no cambian en una conversación. */
const CATALOG_TTL_MS = 60 * 60 * 1000;

/** Las organizaciones sí pueden aparecer mientras se trabaja; cinco minutos. */
const ORGANIZATIONS_TTL_MS = 5 * 60 * 1000;

export function registerCatalogResources(server: McpServer, ctx: Context): void {
    server.registerResource(
        "social-limits",
        "planvortex://catalog/social-limits",
        {
            title: "Social network limits",
            description:
                "Characters, post bytes, title length, image count, video duration and file size, " +
                "per network.",
            mimeType: "application/json",
            cacheHint: { ttlMs: CATALOG_TTL_MS, cacheScope: "private" },
        },
        async (uri) => {
            const limits = await ctx.pv.catalog.socialLimits();
            return {
                contents: [
                    { uri: uri.href, mimeType: "application/json", text: JSON.stringify(limits, null, 2) },
                ],
            };
        },
    );

    server.registerResource(
        "capabilities",
        "planvortex://catalog/capabilities",
        {
            title: "Social network capabilities",
            description: "What each network can do: publish, message, comment, products, webhooks.",
            mimeType: "application/json",
            cacheHint: { ttlMs: CATALOG_TTL_MS, cacheScope: "private" },
        },
        async (uri) => {
            const capabilities = await ctx.pv.catalog.socialCapabilities();
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: "application/json",
                        text: JSON.stringify(capabilities, null, 2),
                    },
                ],
            };
        },
    );

    server.registerResource(
        "comment-actions",
        "planvortex://catalog/comment-actions",
        {
            title: "Comment moderation matrix",
            description: "Whether reply, hide, delete_own and delete_others are possible on each network.",
            mimeType: "application/json",
            cacheHint: { ttlMs: CATALOG_TTL_MS, cacheScope: "private" },
        },
        async (uri) => {
            const actions = await ctx.pv.catalog.socialCommentActions();
            return {
                contents: [
                    { uri: uri.href, mimeType: "application/json", text: JSON.stringify(actions, null, 2) },
                ],
            };
        },
    );

    server.registerResource(
        "organizations",
        "planvortex://organizations",
        {
            title: "Organizations",
            description: "The PlanVortex organizations this app reaches, with their ids.",
            mimeType: "application/json",
            cacheHint: { ttlMs: ORGANIZATIONS_TTL_MS, cacheScope: "private" },
        },
        async (uri) => {
            const organizations = (await ctx.listOrganizations()).map(projectOrganization);
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: "application/json",
                        text: JSON.stringify(organizations, null, 2),
                    },
                ],
            };
        },
    );
}
