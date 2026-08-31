/**
 * CAPA 2 — el modo `--http` autohospedado.
 *
 * Lo que se prueba aquí es la TRAMPA 12, que es la que se lleva la cuenta entera si falla: que un
 * `Origin` de fuera se rechaza (DNS rebinding), que el token es obligatorio cuando se configura, y
 * que el endpoint contesta MCP de verdad por `/mcp`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, testConfig } from "./helpers.js";
import { createContext } from "../src/context.js";
import { serveHttp, type HttpHandle } from "../src/http.js";
import { setLogLevel } from "../src/log.js";

beforeAll(() => api.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => api.resetHandlers());
afterAll(() => api.close());

/** Un puerto alto y fijo por suite: los tests de este fichero corren en serie. */
const PORT = 39_181;

async function start(overrides: Parameters<typeof testConfig>[0] = {}): Promise<HttpHandle> {
    setLogLevel("silent");
    const config = testConfig({ mode: "http", port: PORT, ...overrides });
    return serveHttp(createContext(config), config);
}

/** Una petición MCP mínima de la era 2025, que es lo que hablan casi todos los clientes de hoy. */
const INITIALIZE = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
    },
});

const HEADERS = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
};

describe("modo --http", () => {
    it("contesta MCP en /mcp", async () => {
        const handle = await start();
        const response = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
            method: "POST",
            headers: HEADERS,
            body: INITIALIZE,
        });
        expect(response.status).toBe(200);
        await handle.close();
    });

    it("cualquier otra ruta es un 404 que dice dónde está el endpoint", async () => {
        const handle = await start();
        const response = await fetch(`http://127.0.0.1:${PORT}/`);
        expect(response.status).toBe(404);
        expect(await response.text()).toContain("/mcp");
        await handle.close();
    });

    it("tiene un /health, que es lo que pide cualquier orquestador", async () => {
        const handle = await start();
        const response = await fetch(`http://127.0.0.1:${PORT}/health`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        await handle.close();
    });

    it("rechaza un Origin ajeno — sin esto, una web cualquiera publica por ti", async () => {
        const handle = await start();
        const response = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
            method: "POST",
            headers: { ...HEADERS, origin: "https://evil.example.com" },
            body: INITIALIZE,
        });
        expect(response.status).toBe(403);
        await handle.close();
    });

    it("acepta un Origin de loopback, que es el del Inspector", async () => {
        const handle = await start();
        const response = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
            method: "POST",
            headers: { ...HEADERS, origin: `http://127.0.0.1:${PORT}` },
            body: INITIALIZE,
        });
        expect(response.status).toBe(200);
        await handle.close();
    });

    it("con token configurado, sin cabecera es 401", async () => {
        const handle = await start({ authToken: "un-token-largo-y-aleatorio" });
        const withoutToken = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
            method: "POST",
            headers: HEADERS,
            body: INITIALIZE,
        });
        expect(withoutToken.status).toBe(401);

        const wrongToken = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
            method: "POST",
            headers: { ...HEADERS, authorization: "Bearer otro-token-distinto" },
            body: INITIALIZE,
        });
        expect(wrongToken.status).toBe(401);

        const good = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
            method: "POST",
            headers: { ...HEADERS, authorization: "Bearer un-token-largo-y-aleatorio" },
            body: INITIALIZE,
        });
        expect(good.status).toBe(200);
        await handle.close();
    });
});
