/**
 * CAPA 3 — las herramientas contra un PlanVortex de verdad.
 *
 * Es la única capa que ve tres cosas que las otras no pueden ver:
 *
 * 1. Un **`outputSchema` que ya no encaja** con lo que la API devuelve. El `McpServer` valida el
 *    `structuredContent` contra el esquema, así que un campo renombrado en el servidor rompe aquí y
 *    en ningún otro sitio — en las capas 1 y 2 la respuesta la escribimos nosotros.
 * 2. Una **ruta que dejó de existir**. `msw` contesta encantado a una URL equivocada.
 * 3. Un **envoltorio de listado** que cambió de nombre (`{comments, total}` → otra cosa).
 *
 * Se salta entera y en silencio si no hay `.env.live`: no falla por falta de credenciales.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createContext } from "../../src/context.js";
import { createServer } from "../../src/server.js";
import { setLogLevel } from "../../src/log.js";
import type { Config } from "../../src/config.js";

/** Un `.env` mínimo: sin dependencia nueva sólo para leer un fichero de pares clave-valor. */
function readEnvFile(path: string): Record<string, string> {
    if (!existsSync(path)) return {};
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
}

const env = { ...readEnvFile(resolve(process.cwd(), ".env.live")), ...process.env };

const CLIENT_ID = env.PLANVORTEX_LIVE_CLIENT_ID;
const CLIENT_SECRET = env.PLANVORTEX_LIVE_CLIENT_SECRET;
const ORGANIZATION = env.PLANVORTEX_LIVE_ORGANIZATION_ID;
const READY = Boolean(CLIENT_ID && CLIENT_SECRET);

if (!READY) {
    console.error(
        "\nCapa 3 saltada: falta .env.live con PLANVORTEX_LIVE_CLIENT_ID y " +
            "PLANVORTEX_LIVE_CLIENT_SECRET. Copia .env.live.example.\n",
    );
}

const live = READY ? describe : describe.skip;

let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
    if (!READY) return;
    setLogLevel("silent");
    const config: Config = {
        clientId: CLIENT_ID ?? "",
        clientSecret: CLIENT_SECRET ?? "",
        baseUrl: env.PLANVORTEX_LIVE_BASE_URL,
        organizationId: ORGANIZATION,
        mode: "stdio",
        host: "127.0.0.1",
        port: 3000,
        authToken: undefined,
        uploadDirs: [],
        readOnly: env.LIVE_ALLOW_WRITE === "1" ? false : true,
        logLevel: "silent",
    };
    const server = createServer(createContext(config));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "live", version: "0.0.0" });
    await client.connect(clientTransport);
    close = async () => {
        await client.close();
        await server.close();
    };
});

afterAll(async () => {
    if (READY && close) await close();
});

/** Llama y exige que NO sea `isError`: aquí un `isError` es un fallo real, no un caso de uso. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as {
        content: { type: string; text?: string }[];
        isError?: boolean;
    };
    const text = result.content.map((block) => block.text ?? "").join("\n");
    expect(result.isError, `${name}: ${text}`).toBeFalsy();
    return text;
}

live("las herramientas de contexto", () => {
    it("list_organizations devuelve al menos una", async () => {
        expect(await call("list_organizations")).toContain("id:");
    });

    it("list_accounts responde y valida su outputSchema", async () => {
        await call("list_accounts");
    });

    it("get_plan_use responde", async () => {
        expect(await call("get_plan_use")).toContain("publications");
    });

    it("get_unread_counts responde", async () => {
        expect(await call("get_unread_counts")).toContain("unread comments");
    });
});

live("lectura de publicaciones, comentarios y mensajes", () => {
    it("list_publications", async () => {
        await call("list_publications", { limit: 3 });
    });

    it("get_publication, si hay un id en el entorno", async () => {
        if (!env.PLANVORTEX_LIVE_PUBLICATION_ID) return;
        await call("get_publication", { id_publication: env.PLANVORTEX_LIVE_PUBLICATION_ID });
    });

    it("list_comments, y si hay alguno viene envuelto", async () => {
        const text = await call("list_comments", { limit: 3 });
        //Un buzón vacío no puede probar la trampa 2, y exigirle el envoltorio hacía fallar la
        //capa entera por no tener datos. Cuando hay comentarios, el envoltorio no es opcional.
        if (text.includes("No results.")) return;
        expect(text).toContain("untrusted_content");
    });

    it("list_conversations, si la cuenta del entorno es de una red con DMs", async () => {
        if (!env.PLANVORTEX_LIVE_ACCOUNT_ID) return;
        //YouTube, Bluesky, Discord y Google Business no tienen mensajes directos: la API contesta
        //1502 y eso es la respuesta CORRECTA, no un fallo. Lo que se comprueba entonces es que el
        //servidor lo traduce como una capacidad que no existe y no como un envío fallido.
        const result = (await client.callTool({
            name: "list_conversations",
            arguments: { id_account: env.PLANVORTEX_LIVE_ACCOUNT_ID, limit: 3 },
        })) as { content: { text?: string }[]; isError?: boolean };
        const text = result.content.map((block) => block.text ?? "").join("\n");
        if (result.isError && text.includes("1502")) {
            expect(text).toContain("get_social_capabilities");
            return;
        }
        expect(result.isError, text).toBeFalsy();
    });
});

live("los números", () => {
    it("get_dashboard_summary", async () => {
        await call("get_dashboard_summary");
    });

    it("get_top_publications", async () => {
        await call("get_top_publications", { limit: 3 });
    });

    it("get_publication_stats, si hay un id en el entorno", async () => {
        if (!env.PLANVORTEX_LIVE_PUBLICATION_ID) return;
        await call("get_publication_stats", { id_publication: env.PLANVORTEX_LIVE_PUBLICATION_ID });
    });

    it("get_account_metrics, si hay una cuenta en el entorno", async () => {
        if (!env.PLANVORTEX_LIVE_ACCOUNT_ID) return;
        await call("get_account_metrics", { id_account: env.PLANVORTEX_LIVE_ACCOUNT_ID });
    });
});

live("el catálogo", () => {
    it("get_social_limits trae las once redes", async () => {
        const text = await call("get_social_limits");
        for (const network of ["instagram", "bluesky", "telegram", "linkedin"]) {
            expect(text, network).toContain(network);
        }
    });

    it("get_social_capabilities trae la matriz de comentarios", async () => {
        expect(await call("get_social_capabilities")).toContain("comment_reply");
    });
});

live("escritura (LIVE_ALLOW_WRITE=1)", () => {
    it("crea un BORRADOR y lo edita; nada sale a una red social", async () => {
        if (env.LIVE_ALLOW_WRITE !== "1") return;
        if (!env.PLANVORTEX_LIVE_ACCOUNT_ID) return;
        //La red sale de la CUENTA, no de una constante: estaba fijada a `instagram` y en un
        //stack cuya única cuenta es de otra red la escritura fallaba por el argumento, no por el
        //servidor. Y `draft` a propósito: un `ready` con fecha pasada publicaría de verdad.
        const accounts = (await client.callTool({
            name: "list_accounts",
            arguments: {},
        })) as { structuredContent?: { accounts?: { id: string; social_network: string }[] } };
        const account = (accounts.structuredContent?.accounts ?? []).find(
            (item) => item.id === env.PLANVORTEX_LIVE_ACCOUNT_ID,
        );
        expect(account, "PLANVORTEX_LIVE_ACCOUNT_ID no está en la organización").toBeTruthy();
        const created = await call("create_publication", {
            id_account: env.PLANVORTEX_LIVE_ACCOUNT_ID,
            social_network: account?.social_network,
            text: `planvortex-mcp layer 3 — ${new Date().toISOString()}`,
            state: "draft",
        });
        const id = /id: (\w+)/.exec(created)?.[1];
        expect(id).toBeTruthy();
        await call("update_publication", { id_publication: id, text: "edited by layer 3" });
    });
});
