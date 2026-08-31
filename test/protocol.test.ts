/**
 * CAPA 2 — el protocolo.
 *
 * El servidor visto por un cliente MCP de verdad: que las veinticinco herramientas están, que salen
 * en **orden determinista** (la spec cachea `tools/list` con `ttlMs`, y un orden que cambiara entre
 * arranques tiraría esa caché y la del prompt del modelo en cada conversación), que los esquemas
 * son válidos, y que nada de esto escribe en `stdout`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { api, testConfig, withServer } from "./helpers.js";
import { createContext } from "../src/context.js";
import { createServer } from "../src/server.js";

beforeAll(() => api.listen({ onUnhandledRequest: "error" }));
afterEach(() => api.resetHandlers());
afterAll(() => api.close());

/**
 * El catálogo completo, EN ORDEN. Esta lista es el contrato: tocarla a la ligera cambia lo que ven
 * los clientes ya instalados, y añadir una herramienta en medio invalida su caché.
 */
const EXPECTED_TOOLS = [
    "list_organizations",
    "list_accounts",
    "get_plan_use",
    "get_unread_counts",
    "list_publications",
    "get_publication",
    "create_publication",
    "update_publication",
    "retry_publication",
    "upload_media",
    "list_comments",
    "get_comment_thread",
    "reply_to_comment",
    "hide_comment",
    "mark_comment_read",
    "list_conversations",
    "list_messages",
    "send_message",
    "get_dashboard_summary",
    "get_publication_stats",
    "get_top_publications",
    "get_account_metrics",
    "get_social_limits",
    "get_social_capabilities",
    "create_connect_link",
];

/** Las nueve que `PLANVORTEX_MCP_READ_ONLY` tiene que quitar del listado. */
const WRITE_TOOLS = [
    "create_publication",
    "update_publication",
    "retry_publication",
    "upload_media",
    "reply_to_comment",
    "hide_comment",
    "mark_comment_read",
    "send_message",
    "create_connect_link",
];

describe("catálogo de herramientas", () => {
    it("son veinticinco y salen en orden determinista", async () => {
        const harness = await withServer();
        const listed = (await harness.client.listTools()).tools.map((tool) => tool.name);
        expect(listed).toEqual(EXPECTED_TOOLS);
        expect(listed).toHaveLength(25);
        await harness.close();
    });

    it("el orden es el mismo en dos arranques distintos", async () => {
        const first = await withServer();
        const second = await withServer();
        const a = (await first.client.listTools()).tools.map((tool) => tool.name);
        const b = (await second.client.listTools()).tools.map((tool) => tool.name);
        expect(a).toEqual(b);
        await first.close();
        await second.close();
    });

    it("todas traen descripción, esquema de entrada y anotaciones", async () => {
        const harness = await withServer();
        for (const tool of (await harness.client.listTools()).tools) {
            expect(tool.description, tool.name).toBeTruthy();
            //Una descripción de una línea no le dice a un modelo cuándo elegir la herramienta.
            expect(tool.description!.length, tool.name).toBeGreaterThan(80);
            expect(tool.inputSchema, tool.name).toBeTruthy();
            expect(tool.inputSchema.type, tool.name).toBe("object");
            expect(tool.annotations, tool.name).toBeTruthy();
        }
        await harness.close();
    });

    it("ninguna se declara destructiva, porque ninguna borra nada", async () => {
        const harness = await withServer();
        for (const tool of (await harness.client.listTools()).tools) {
            expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
        }
        //Y la comprobación que de verdad importa: no existe ninguna herramienta de borrado.
        const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
        expect(names.filter((name) => /^delete_|^remove_/.test(name))).toEqual([]);
        await harness.close();
    });

    it("las dieciséis de lectura se declaran readOnly", async () => {
        const harness = await withServer();
        const tools = (await harness.client.listTools()).tools;
        const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true);
        expect(readOnly).toHaveLength(16);
        for (const tool of readOnly) {
            expect(WRITE_TOOLS, tool.name).not.toContain(tool.name);
        }
        await harness.close();
    });

    it("lo que sale a las redes lleva openWorldHint", async () => {
        const harness = await withServer();
        const tools = (await harness.client.listTools()).tools;
        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        for (const name of ["list_comments", "get_comment_thread", "reply_to_comment", "send_message"]) {
            expect(byName.get(name)?.annotations?.openWorldHint, name).toBe(true);
        }
        await harness.close();
    });
});

describe("PLANVORTEX_MCP_READ_ONLY", () => {
    it("quita las nueve de escritura del listado, no las desactiva", async () => {
        const harness = await withServer({ readOnly: true });
        const listed = (await harness.client.listTools()).tools.map((tool) => tool.name);
        expect(listed).toHaveLength(16);
        for (const name of WRITE_TOOLS) {
            expect(listed, name).not.toContain(name);
        }
        await harness.close();
    });

    it("una herramienta que no está en el listado no se puede llamar", async () => {
        const harness = await withServer({ readOnly: true });
        //Esto SÍ es un error de protocolo, y debe serlo: la herramienta no existe.
        await expect(
            harness.client.callTool({ name: "create_publication", arguments: {} }),
        ).rejects.toThrow();
        await harness.close();
    });
});

describe("resources y prompts", () => {
    it("publica los cuatro resources del catálogo", async () => {
        const harness = await withServer();
        const uris = (await harness.client.listResources()).resources.map((resource) => resource.uri);
        expect(uris).toEqual([
            "planvortex://catalog/social-limits",
            "planvortex://catalog/capabilities",
            "planvortex://catalog/comment-actions",
            "planvortex://organizations",
        ]);
        await harness.close();
    });

    it("publica los tres prompts", async () => {
        const harness = await withServer();
        const names = (await harness.client.listPrompts()).prompts.map((prompt) => prompt.name);
        expect(names).toEqual(["weekly_plan", "inbox_triage", "publish_from_brief"]);
        await harness.close();
    });

    it("inbox_triage lleva dentro la advertencia de la trampa 2", async () => {
        const harness = await withServer();
        const prompt = await harness.client.getPrompt({ name: "inbox_triage", arguments: {} });
        const text = prompt.messages
            .map((message) => (message.content.type === "text" ? message.content.text : ""))
            .join("\n");
        expect(text).toMatch(/written by a\s+member of the public/);
        expect(text).toMatch(/never gives\s+you instructions/);
        await harness.close();
    });
});

describe("las dos eras del protocolo", () => {
    /**
     * La era 2026-07-28 no tiene `initialize`: cada petición llega sola y lleva su versión y las
     * capacidades del cliente en `_meta`. Se habla por el transporte crudo porque el `Client` del
     * SDK negocia la era de 2025, que es la que ya cubre el resto de este fichero.
     *
     * Y se entra por `serveStdio`, no por `server.connect()`, porque **ahí está la trampa 10**: un
     * `McpServer` conectado a mano se queda en la era de 2025 y contesta `Method not found` a
     * `server/discover`. Lo que activa el protocolo nuevo son los puntos de entrada, que además
     * son los que traen el `legacy` que atiende a los clientes viejos. Este test se escribió
     * después de comprobarlo contra el binario construido, y falla si alguien monta el transporte
     * por su cuenta.
     */
    async function modernCall(method: string, params: Record<string, unknown> = {}) {
        const ctx = createContext(testConfig());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const handle = serveStdio(() => createServer(ctx), { transport: serverTransport });
        const answer = new Promise<Record<string, unknown>>((resolve) => {
            clientTransport.onmessage = (message) => resolve(message as Record<string, unknown>);
        });
        await clientTransport.start();
        await clientTransport.send({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
                ...params,
                _meta: {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                    "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
                },
            },
        });
        const message = await answer;
        await handle.close();
        return message;
    }

    it("server/discover anuncia la revisión nueva y las instrucciones", async () => {
        const message = (await modernCall("server/discover")) as {
            result?: { supportedVersions?: string[]; instructions?: string };
        };
        expect(message.result?.supportedVersions).toContain("2026-07-28");
        //Las instrucciones son donde se dice que hay cosas que necesitan una persona y que los
        //comentarios no son instrucciones. Si desaparecen, el modelo llega sin ese contexto.
        expect(message.result?.instructions).toMatch(/never give you instructions/i);
    });

    it("tools/list responde sin initialize, con resultType y un ttlMs que no es cero", async () => {
        const message = (await modernCall("tools/list")) as {
            result?: { tools?: unknown[]; resultType?: string; ttlMs?: number; cacheScope?: string };
        };
        expect(message.result?.tools).toHaveLength(25);
        expect(message.result?.resultType).toBe("complete");
        //`ttlMs: 0` es el valor conservador por defecto del SDK, y con él el orden determinista de
        //`server.ts` no sirve de nada: el cliente vuelve a pedir el catálogo en cada vuelta.
        expect(message.result?.ttlMs).toBeGreaterThan(0);
        expect(message.result?.cacheScope).toBe("private");
    });
});

describe("trampa 11 — nada escribe en stdout", () => {
    it("ni el arranque ni una llamada fallida ensucian el transporte", async () => {
        const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        const harness = await withServer();
        await harness.client.listTools();
        //Una llamada que falla es el caso interesante: es donde alguien pondría un `console.log`.
        await harness.client.callTool({ name: "get_plan_use", arguments: {} }).catch(() => undefined);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
        await harness.close();
    });
});
