/**
 * El modo `--http` autohospedado.
 *
 * TRAMPA 12 DEL ROADMAP, y es la que más caro sale si se ignora: **este proceso lleva DENTRO el
 * `client_secret` de la app**. Cualquiera que alcance el puerto publica en las redes del cliente
 * sin más credencial que un `curl`. De ahí las cuatro defensas, que no son opcionales:
 *
 * 1. Por defecto se ata a `127.0.0.1`. Atarlo a otra cosa **exige** `PLANVORTEX_MCP_AUTH_TOKEN` y
 *    el proceso se niega a arrancar sin él — eso lo decide `config.ts`, antes de abrir el puerto.
 * 2. Se valida la cabecera `Origin` en cada petición: sin eso, una página web cualquiera que el
 *    usuario visite puede hablar con este servidor desde su navegador (DNS rebinding).
 * 3. HTTPS lo pone quien lo despliegue, detrás de su proxy. Aquí no se termina TLS.
 * 4. **Jamás** se acepta un token de la petición para pasárselo a la API. Eso es *token
 *    passthrough*, y la spec lo prohíbe con nombre y apellidos: el token del cliente MCP autentica
 *    contra ESTE servidor y muere aquí; contra PlanVortex se habla siempre con la app del dueño.
 *
 * Lo que NO es esto: un servidor remoto multi-inquilino. Aquí las credenciales son las del dueño
 * del proceso, y cada cliente levanta el suyo. Un `mcp.planvortex.com` donde vivan las credenciales
 * de todos es otra cosa entera y no está en la v1.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Config } from "./config.js";
import { isLoopback } from "./config.js";
import type { Context } from "./context.js";
import { createServer as createMcpServer } from "./server.js";
import { log } from "./log.js";

/** La ruta única. Un servidor MCP por HTTP no tiene más superficie que ésta. */
const MCP_PATH = "/mcp";

export interface HttpHandle {
    port: number;
    close(): Promise<void>;
}

export async function serveHttp(ctx: Context, config: Config): Promise<HttpHandle> {
    //`legacy: 'stateless'` es lo que atiende a los clientes de la era 2025, que hoy son la mayoría
    //de los instalados. Y se usa el punto de entrada en vez de montar el transporte a mano porque
    //es lo que activa el protocolo 2026-07-28 (§ trampa 10).
    const handler = createMcpHandler(() => createMcpServer(ctx), {
        legacy: "stateless",
        onerror: (error) => log.error("fallo del manejador HTTP", { error: error.message }),
    });
    const mcp = toNodeHandler(handler);

    const server = createHttpServer((req, res) => {
        void handleRequest(req, res, config, mcp);
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
            server.removeListener("error", reject);
            resolve();
        });
    });

    log.info(`escuchando en http://${config.host}:${config.port}${MCP_PATH}`);
    if (!isLoopback(config.host)) {
        log.warn(
            "atado fuera de loopback: el token de PLANVORTEX_MCP_AUTH_TOKEN es obligatorio en cada petición",
        );
    }

    return {
        port: config.port,
        close: async () => {
            await handler.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    config: Config,
    mcp: ReturnType<typeof toNodeHandler>,
): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    if (path !== MCP_PATH) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Not found. The MCP endpoint is ${MCP_PATH}.` }));
        return;
    }
    if (!originAllowed(req, config)) {
        //DNS rebinding: sin esto, cualquier página que el usuario visite puede hablar con este
        //servidor desde su navegador, con las credenciales del dueño ya dentro del proceso.
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Origin not allowed." }));
        return;
    }
    if (!authorised(req, config)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Missing or invalid Authorization bearer token." }));
        return;
    }
    //El adaptador declara `method?: string` y el `IncomingMessage` de Node lo tiene como
    //`string | undefined`: con `exactOptionalPropertyTypes` eso no encaja, aunque en tiempo de
    //ejecución sea exactamente lo mismo. El `as` es por esa diferencia y por ninguna otra.
    await mcp(req as unknown as Parameters<typeof mcp>[0], res);
}

/**
 * En loopback se acepta que no venga `Origin` —un cliente de escritorio no manda ninguno—, pero un
 * `Origin` que exista tiene que ser de loopback: eso es justo lo que un navegador sí manda.
 */
function originAllowed(req: IncomingMessage, config: Config): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
        const hostname = new URL(origin).hostname;
        if (isLoopback(hostname)) return true;
        return !isLoopback(config.host) && hostname === config.host;
    } catch {
        return false;
    }
}

/**
 * El token del despliegue, comparado en tiempo constante.
 *
 * Y una cosa que NO hace: este token no viaja a PlanVortex. Autentica contra este proceso y se
 * queda aquí; hacia la API se habla siempre con las credenciales de la app del dueño.
 */
function authorised(req: IncomingMessage, config: Config): boolean {
    if (!config.authToken) return true;
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expected = Buffer.from(config.authToken);
    const given = Buffer.from(presented);
    return given.length === expected.length && timingSafeEqual(given, expected);
}
