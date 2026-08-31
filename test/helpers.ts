/**
 * El arnés de las dos capas de test.
 *
 * `withServer` levanta el servidor **a través de un cliente MCP de verdad** por un transporte en
 * memoria: no se llama a los handlers a mano, porque entonces no se probaría ni el esquema, ni la
 * validación de argumentos, ni que un fallo salga como `isError` y no como error de protocolo.
 *
 * La API se moquea con `msw`, igual que en PlanVortexNode, de forma que se ejercita el cliente
 * `planvortex` de verdad —su transporte, su OAuth, su traducción de errores— y sólo la red es
 * falsa.
 */
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { Config } from "../src/config.js";
import { createContext } from "../src/context.js";
import { createServer } from "../src/server.js";
import { setLogLevel } from "../src/log.js";

export const BASE_URL = "https://api.test.planvortex.com/v1.0.0";

/** El token que devuelve el `/oauth/token` falso. Todas las suites lo comparten. */
export const TOKEN_HANDLER = http.post(`${BASE_URL}/oauth/token`, () =>
    HttpResponse.json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 }),
);

export const api = setupServer(TOKEN_HANDLER);

export function testConfig(overrides: Partial<Config> = {}): Config {
    return {
        clientId: "test-client",
        clientSecret: "test-secret",
        baseUrl: BASE_URL,
        organizationId: undefined,
        mode: "stdio",
        host: "127.0.0.1",
        port: 3000,
        authToken: undefined,
        uploadDirs: [],
        readOnly: false,
        logLevel: "silent",
        ...overrides,
    };
}

export interface Harness {
    client: Client;
    close(): Promise<void>;
}

/** Un servidor conectado a un cliente MCP real, listo para `listTools` y `callTool`. */
export async function withServer(overrides: Partial<Config> = {}): Promise<Harness> {
    setLogLevel("silent");
    const ctx = createContext(testConfig(overrides));
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    return {
        client,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
}

/** El texto que devolvió una herramienta, que es lo que de verdad lee el modelo. */
export function textOf(result: unknown): string {
    const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
    return content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
}

export function isError(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
}

/** El envoltorio de una lista paginada, tal y como la manda la API. */
export function paged<T>(key: string, items: T[], total = items.length): Record<string, unknown> {
    return { [key]: items, total };
}
