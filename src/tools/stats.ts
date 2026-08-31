/**
 * Los números: cuatro herramientas, todas de lectura.
 *
 * TRAMPA 14 EN TODAS ELLAS: **las métricas que faltan no son ceros.** Telegram y Bluesky no tienen
 * impresiones ni alcance en ninguna parte de su API —su `engagement_base` es `followers`—, y Google
 * Business ni siquiera publica. Si la herramienta rellena esos huecos con `0`, el modelo dirá que
 * el post no lo vio nadie, y eso es peor que no decir nada. Las claves que no existen **se omiten**
 * (lo hace `compactNumbers`) y la respuesta lleva la nota que lo explica. Es la misma decisión que
 * ya tomó la pantalla de estadísticas del panel.
 */
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Context } from "../context.js";
import { toolOk } from "../errors.js";
import { asLines, compactNumbers, projectTopPublication } from "../format/project.js";
import { defineTool } from "./register.js";

const OrganizationArg = z.string().describe("The PlanVortex organization id. Optional.").optional();
const FromDate = z.string().describe("ISO 8601 date. Defaults to the last 30 days.").optional();
const ToDate = z.string().describe("ISO 8601 date.").optional();

/**
 * Las métricas comparables entre redes, que son las únicas por las que se puede ordenar. Es una
 * lista CERRADA a propósito: no vale cualquier clave de `PublicationStats`, porque un ranking suma
 * redes distintas y sólo estas doce significan lo mismo en todas.
 */
const METRIC_NAME = z.enum([
    "engagement",
    "impressions",
    "reach",
    "likes",
    "comments",
    "shares",
    "saves",
    "clicks",
    "video_views",
    "followers",
    "followers_gained",
    "profile_views",
]);

/**
 * La nota que acompaña a cualquier respuesta de métricas. Va SIEMPRE, no sólo cuando falta algo:
 * un modelo que no la lee no sabe distinguir «cero» de «esta red no lo mide».
 */
const MISSING_METRICS_NOTE =
    "Metrics a network does not measure are left out rather than reported as zero. Telegram and " +
    "Bluesky have no impressions or reach at all — their engagement is measured against followers " +
    "— so an absent key means 'not measured here', never 'nobody saw it'.";

export function registerStatsTools(server: McpServer, ctx: Context): void {
    defineTool(
        server,
        ctx,
        {
            name: "get_dashboard_summary",
            title: "Get dashboard summary",
            description:
                "The aggregate for a date range: totals by network, plan usage, unread messages, " +
                "accounts in error and posts that failed. This is the one call for 'how did this " +
                "month go?' — prefer it over stitching several tools together.",
            inputSchema: z.object({
                id_organization: OrganizationArg,
                from_date: FromDate,
                to_date: ToDate,
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const dashboard = await context.pv.dashboard.summary(idOrganization, {
                ...(args.from_date === undefined ? {} : { from_date: args.from_date }),
                ...(args.to_date === undefined ? {} : { to_date: args.to_date }),
            });

            const rows: Record<string, unknown>[] = [
                {
                    range: `${dashboard.range.from_date} to ${dashboard.range.to_date}`,
                    published: dashboard.publications?.total,
                    unread_messages: dashboard.messages?.unread,
                    accounts_in_error: dashboard.health?.accounts_with_errors?.length,
                    failed_publications: dashboard.health?.publications_with_errors?.length,
                    drafts: dashboard.health?.total_drafts,
                },
            ];
            const totals = compactNumbers(dashboard.publication_metrics?.total);
            if (Object.keys(totals).length > 0) rows.push({ totals: JSON.stringify(totals) });

            for (const entry of dashboard.publication_metrics?.by_network ?? []) {
                rows.push({
                    network: String(entry.social_network ?? "unknown"),
                    publications: entry.publications,
                    metrics: JSON.stringify(compactNumbers(entry.metrics)),
                });
            }
            return toolOk(`${asLines(rows)}\n\n${MISSING_METRICS_NOTE}`);
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "get_publication_stats",
            title: "Get one post's stats",
            description:
                "The measurements of a single post over time. Each point is the CUMULATIVE value " +
                "at that date, not that day's increment. Keys a network does not measure are " +
                "absent, never zero.",
            inputSchema: z.object({
                id_publication: z.string(),
                id_organization: OrganizationArg,
            }),
            outputSchema: z.object({
                id_publication: z.string(),
                social_network: z.string(),
                engagement_base: z.string().optional(),
                latest: z.record(z.string(), z.number()),
                series: z.array(z.object({ date: z.string(), metrics: z.record(z.string(), z.number()) })),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const stats = await context.pv.publications.stats(idOrganization, args.id_publication);
            const latest = compactNumbers(stats.latest?.metrics ?? stats.metrics);
            const series = stats.series.map((point) => ({
                date: point.collected_date,
                metrics: compactNumbers(point.metrics),
            }));
            const payload = {
                id_publication: stats.id_publication,
                social_network: String(stats.social_network),
                ...(stats.engagement_base === undefined
                    ? {}
                    : { engagement_base: String(stats.engagement_base) }),
                latest,
                series,
            };
            const body =
                Object.keys(latest).length === 0
                    ? "This post has no measurements yet. Stats are collected on a schedule, so a " +
                      "post published minutes ago will be empty."
                    : asLines([{ network: payload.social_network, latest: JSON.stringify(latest) }]);
            return toolOk(`${body}\n\n${MISSING_METRICS_NOTE}`, payload);
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "get_top_publications",
            title: "Get best performing posts",
            description:
                "The best performing posts of a range, ranked by one metric. This is the tool for " +
                "'what worked?'. Networks measure different things, so a ranking by impressions " +
                "silently leaves out the networks that have none — rank by engagement to compare " +
                "across all of them.",
            inputSchema: z.object({
                id_organization: OrganizationArg,
                from_date: FromDate,
                to_date: ToDate,
                metric: METRIC_NAME.describe(
                    "Which metric to rank by. Defaults to engagement, the one every network reports.",
                ).optional(),
                limit: z.number().int().min(1).max(50).optional(),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const result = await context.pv.dashboard.topPublications(idOrganization, {
                ...(args.from_date === undefined ? {} : { from_date: args.from_date }),
                ...(args.to_date === undefined ? {} : { to_date: args.to_date }),
                ...(args.metric === undefined ? {} : { metric: args.metric }),
                limit: Math.min(50, Math.max(1, args.limit ?? 10)),
            });
            const rows = (result.publications ?? []).map(projectTopPublication).map((row) => ({
                ...row,
                metrics: JSON.stringify(row.metrics),
            }));
            const body = rows.length === 0 ? "No posts with measurements in that range." : asLines(rows);
            return toolOk(`${body}\n\n${MISSING_METRICS_NOTE}`);
        },
    );

    defineTool(
        server,
        ctx,
        {
            name: "get_account_metrics",
            title: "Get account metrics",
            description:
                "Followers and how they moved over time for one connected account. Which series " +
                "exist depends on the network, so ask for a range and read what comes back rather " +
                "than assuming a metric is there.",
            inputSchema: z.object({
                id_account: z.string(),
                id_organization: OrganizationArg,
                from_date: FromDate,
                to_date: ToDate,
                names: z.array(z.string()).describe("Limit to these metric names.").optional(),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const metrics = await context.pv.accounts.metrics(idOrganization, args.id_account, {
                ...(args.from_date === undefined ? {} : { from_date: args.from_date }),
                ...(args.to_date === undefined ? {} : { to_date: args.to_date }),
                ...(args.names === undefined ? {} : { names: args.names }),
            });
            const rows = (metrics.stats ?? []).map((row) => ({
                name: row.name,
                date: row.date,
                value: row.value,
            }));
            const body =
                rows.length === 0
                    ? "This account has no metrics in that range. Stats are collected on a " +
                      "schedule and some networks publish none at all."
                    : asLines(rows);
            return toolOk(`${body}\n\n${MISSING_METRICS_NOTE}`);
        },
    );
}
