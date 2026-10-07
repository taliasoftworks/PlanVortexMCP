/**
 * El modo alojado: el servidor de `mcp.planvortex.com`, multi-inquilino y con OAuth contra Keycloak.
 * Fase 2 de `PlanVortexServer/.claude/roadmaps/chatgpt.md`.
 *
 * No es el `--http` con más cosas: aquel es de UN dueño, lleva dentro las credenciales de su app y
 * guarda sus cachés en el proceso. Aquí cada petición trae a una persona distinta, y la TRAMPA 1
 * de ese roadmap es la que se paga si se olvida: con las cachés de `createContext`, el segundo
 * usuario recibiría las organizaciones del primero, con datos coherentes y sin ningún error.
 *
 * Por eso aquí no hay ni un `Context` compartido. Cada petición:
 *
 * 1. verifica el token del asistente (`oauth.ts`) y, si no vale, contesta `401` con el
 *    `WWW-Authenticate` que hace aparecer el botón de iniciar sesión;
 * 2. lo canjea por uno de `planvortex_mcp`, cacheado por persona (decisión 5);
 * 3. construye su propio `McpServer` con un contexto de ESA persona (decisión 6): su cliente de la
 *    librería, su lista de organizaciones, su anti-duplicado y su cubo de fichas, además del cubo
 *    de todos. Lo único que se recuerda entre peticiones vive en un {@link PrincipalState}, que va
 *    indexado por `sub` y no se comparte con nadie.
 *
 * El protocolo 2026-07-28 no tiene sesiones y la era 2025 se sirve sin estado, así que construir el
 * servidor por petición no es un precio: es como el SDK quiere que se haga (`createMcpHandler`).
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { PlanVortex, type ClientWithOrganizations } from "planvortex";
import type { JWTVerifyGetKey } from "jose";
import type { Config, HostedConfig } from "./config.js";
import { USER_AGENT } from "./config.js";
import { assembleContext, rateLimitedFetch, type Context } from "./context.js";
import { DedupeCache } from "./dedupe.js";
import type { HttpHandle } from "./http.js";
import { log } from "./log.js";
import {
    AuthFailure,
    ExchangeMisconfigured,
    WRITE_SCOPE,
    createTokenVerifier,
    exchangeToken,
    protectedResourceMetadata,
    protectedResourceMetadataUrl,
    wwwAuthenticate,
    type ExchangedToken,
    type Principal,
} from "./oauth.js";
import { HOSTED_GLOBAL_BURST, HOSTED_GLOBAL_RATE_PER_SECOND, TokenBucket } from "./ratelimit.js";
import { createServer as createMcpServer } from "./server.js";

/**
 * Lo que vale la lista de clientes y organizaciones de una persona. Un minuto: lo justo para no
 * pedirla en cada herramienta de una misma conversación, y poco para que una organización recién
 * creada en el panel aparezca sin que nadie tenga que reconectar nada.
 */
export const HOSTED_CLIENTS_TTL_MS = 60_000;

/** El canje se repite cuando al token canjeado le queda menos que esto. */
export const EXCHANGE_REFRESH_MARGIN_MS = 60_000;

/**
 * Cuántas personas se recuerdan a la vez. Pasado el tope se olvida la que lleva más tiempo sin
 * llamar, y olvidar sólo cuesta un canje y una lista de organizaciones la próxima vez.
 */
export const MAX_PRINCIPALS = 10_000;

/**
 * Lo que el servidor recuerda de UNA persona entre peticiones, y nada más.
 *
 * Cada campo es la versión por persona de algo que en stdio vive en el proceso: el cubo de fichas,
 * el anti-duplicado (dos miembros de una organización que piden el mismo post a la vez no deben
 * recibir el uno el del otro como «ya existía»), el token canjeado y la lista de organizaciones.
 */
export class PrincipalState {
    readonly bucket = new TokenBucket();
    readonly dedupe = new DedupeCache();
    private exchanged: ExchangedToken | undefined;
    private exchanging: Promise<ExchangedToken> | undefined;
    private clients: { value: ClientWithOrganizations[]; expiresAt: number } | undefined;
    private loadingClients: Promise<ClientWithOrganizations[]> | undefined;

    constructor(
        readonly sub: string,
        private readonly now: () => number = () => Date.now(),
    ) {}

    /** El token para la API: canjeado una vez y reutilizado hasta poco antes de que caduque. */
    async apiToken(exchange: () => Promise<ExchangedToken>): Promise<string> {
        const current = this.exchanged;
        if (current && current.expiresAt - EXCHANGE_REFRESH_MARGIN_MS > this.now()) return current.token;
        //Dos peticiones a la vez de la misma persona hacen UN canje, no dos. Claude llega a mandar
        //`server/discover` y la llamada casi juntas.
        this.exchanging ??= exchange().finally(() => {
            this.exchanging = undefined;
        });
        const fresh = await this.exchanging;
        this.exchanged = fresh;
        return fresh.token;
    }

    /** Clientes y organizaciones de esta persona, con la caducidad de {@link HOSTED_CLIENTS_TTL_MS}. */
    async loadClients(fetcher: () => Promise<ClientWithOrganizations[]>): Promise<ClientWithOrganizations[]> {
        const cached = this.clients;
        if (cached && cached.expiresAt > this.now()) return cached.value;
        this.loadingClients ??= fetcher()
            .then((value) => {
                this.clients = { value, expiresAt: this.now() + HOSTED_CLIENTS_TTL_MS };
                return value;
            })
            .finally(() => {
                this.loadingClients = undefined;
            });
        return this.loadingClients;
    }
}

/** El estado de todas las personas, indexado por `sub`, con el tope de {@link MAX_PRINCIPALS}. */
export class PrincipalRegistry {
    private readonly states = new Map<string, PrincipalState>();

    constructor(
        private readonly max: number = MAX_PRINCIPALS,
        private readonly now: () => number = () => Date.now(),
    ) {}

    get(sub: string): PrincipalState {
        const existing = this.states.get(sub);
        //Se saca y se vuelve a meter para que quede la última: `Map` conserva el orden de inserción,
        //así que la primera clave es siempre la que lleva más tiempo sin llamar.
        if (existing) this.states.delete(sub);
        const state = existing ?? new PrincipalState(sub, this.now);
        this.states.set(sub, state);
        while (this.states.size > this.max) {
            const oldest = this.states.keys().next().value;
            if (oldest === undefined) break;
            this.states.delete(oldest);
        }
        return state;
    }

    get size(): number {
        return this.states.size;
    }
}

/**
 * Lo que la capa HTTP le pasa a la fábrica del servidor MCP, dentro de `authInfo.extra`. Una clase y
 * no un objeto suelto para que la fábrica pueda comprobar con `instanceof` que viene de aquí.
 */
export class HostedSession {
    constructor(
        readonly principal: Principal,
        /** El token CANJEADO. El del asistente no sale de la capa HTTP. */
        readonly apiToken: string,
        readonly state: PrincipalState,
    ) {}
}

/**
 * El contexto de UNA petición: el mismo `Context` que ven las herramientas en stdio, construido
 * con las piezas de esta persona. Las herramientas no cambian (decisión 2).
 */
export function createHostedContext(base: Config, session: HostedSession, global: TokenBucket): Context {
    const config: Config = {
        ...base,
        //`PLANVORTEX_MCP_READ_ONLY` por persona (decisión 7): sin `planvortex:write`, las
        //herramientas de escritura no se registran en el servidor de ESTA petición, así que ni una
        //lista de herramientas cacheada por el asistente permite llamarlas.
        readOnly: base.readOnly || !session.principal.scopes.includes(WRITE_SCOPE),
        //Los planes de IA no se crean en la v1 alojada (decisión 7). `loadConfig` ya rechaza
        //`ALLOW_AI` en este modo; esto es el cinturón.
        allowAiPlans: false,
        organizationId: undefined,
        clientId: undefined,
        clientSecret: undefined,
        authToken: undefined,
        uploadDirs: [],
    };
    const fetchWithLimits = rateLimitedFetch([session.state.bucket, global], `${USER_AGENT} (hosted)`);

    let client: PlanVortex | undefined;
    const pv = (): PlanVortex => {
        client ??= new PlanVortex({
            accessToken: session.apiToken,
            ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
            fetch: fetchWithLimits,
        });
        return client;
    };

    return assembleContext({
        config,
        pv,
        dedupe: session.state.dedupe,
        loadClients: () =>
            session.state.loadClients(async () => (await pv().clients.withOrganizations()).data),
    });
}

export interface HostedOptions {
    /** Sólo para los tests: las claves con que se verifica, en vez del JWKS remoto del realm. */
    getKey?: JWTVerifyGetKey;
    now?: () => number;
}

export interface HostedHandle extends HttpHandle {
    /** Para los tests de aislamiento: cuántas personas recuerda el proceso. */
    registry: PrincipalRegistry;
}

export async function serveHosted(config: Config, options: HostedOptions = {}): Promise<HostedHandle> {
    if (!config.hosted)
        throw new Error("serveHosted needs the hosted configuration (loadConfig in hosted mode).");
    const hosted: HostedConfig = config.hosted;
    const now = options.now ?? (() => Date.now());

    const verify = createTokenVerifier(hosted, options.getKey);
    const registry = new PrincipalRegistry(MAX_PRINCIPALS, now);
    const global = new TokenBucket(HOSTED_GLOBAL_RATE_PER_SECOND, HOSTED_GLOBAL_BURST);

    const handler = createMcpHandler(
        ({ authInfo }) => {
            const session = authInfo?.extra?.["session"];
            //No puede pasar: la capa HTTP no deja llegar aquí ninguna petición sin sesión. Si un día
            //pasa, se para en seco en vez de servir un contexto sin dueño.
            if (!(session instanceof HostedSession)) {
                throw new Error("hosted request reached the MCP handler without a verified session");
            }
            return createMcpServer(createHostedContext(config, session, global));
        },
        {
            legacy: "stateless",
            onerror: (error) => log.error("fallo del manejador HTTP", { error: error.message }),
        },
    );
    const mcp = toNodeHandler(handler);

    const routes = {
        mcp: new URL(hosted.publicUrl).pathname,
        metadata: new URL(protectedResourceMetadataUrl(hosted.publicUrl)).pathname,
    };
    const metadata = JSON.stringify(protectedResourceMetadata(hosted));

    const server = createHttpServer((req, res) => {
        void handleRequest(req, res).catch((error: unknown) => {
            log.error("fallo inesperado del modo alojado", {
                error: error instanceof Error ? error.message : error,
            });
            if (!res.headersSent) {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "server_error" }));
            }
        });
    });

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const path = (req.url ?? "/").split("?")[0];
        if (path === "/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        //Las dos rutas: la de la RFC 9728 con la ruta del recurso detrás, que es la que anuncia el
        //`WWW-Authenticate`, y la raíz, que es la que prueban los clientes que no leen la cabecera.
        if (path === routes.metadata || path === "/.well-known/oauth-protected-resource") {
            serveMetadata(req, res, metadata);
            return;
        }
        if (path !== routes.mcp) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: `Not found. The MCP endpoint is ${routes.mcp}.` }));
            return;
        }

        //Sin validación de `Origin`, y es deliberado: aquí no hay nada ambiental que robar. En
        //`--http` la defensa existe porque el proceso lleva dentro el secreto del dueño y cualquier
        //página podría hablarle desde el navegador; aquí cada petición tiene que traer un token
        //propio, ni hay cookies ni red privada detrás, y Claude y ChatGPT llaman desde sus servidores.
        let session: HostedSession;
        try {
            const { principal, token } = await verify(req.headers.authorization);
            const state = registry.get(principal.sub);
            const apiToken = await state.apiToken(() => exchangeToken(hosted, token, principal.sub, now));
            session = new HostedSession(principal, apiToken, state);
        } catch (error) {
            refuse(res, hosted, error);
            return;
        }

        const auth: AuthInfo = {
            //El CANJEADO, a propósito: si algún día alguien lee `authInfo.token` para llamar a la
            //API, que lo que encuentre sea el token que la API acepta y no el del asistente.
            token: session.apiToken,
            clientId: session.principal.azp,
            scopes: session.principal.scopes,
            expiresAt: session.principal.expiresAt,
            resource: new URL(hosted.publicUrl),
            extra: { session },
        };
        //`toNodeHandler` reenvía `req.auth` como el `authInfo` de la fábrica.
        (req as IncomingMessage & { auth?: AuthInfo }).auth = auth;
        //El `as` es el de `http.ts`: `exactOptionalPropertyTypes` contra el `method?` del adaptador.
        await mcp(req as unknown as Parameters<typeof mcp>[0], res);
    }

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
            server.removeListener("error", reject);
            resolve();
        });
    });

    log.info(`modo alojado escuchando en http://${config.host}:${config.port}${routes.mcp}`, {
        resource: hosted.publicUrl,
        issuer: hosted.issuer,
        connectors: hosted.connectorClients,
    });

    return {
        port: config.port,
        registry,
        close: async () => {
            await handler.close();
            //Las `subscriptions/listen` de Claude dejan streams abiertos minutos: sin esto, cerrar
            //espera a que terminen.
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/** Los metadatos del recurso: públicos, cacheables y con CORS, como los de cualquier servidor OAuth. */
function serveMetadata(req: IncomingMessage, res: ServerResponse, body: string): void {
    const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "mcp-protocol-version",
    };
    if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { ...cors, allow: "GET, OPTIONS" });
        res.end();
        return;
    }
    res.writeHead(200, {
        ...cors,
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",
    });
    res.end(req.method === "HEAD" ? undefined : body);
}

/**
 * La respuesta a una petición que no pasa. El log separa los casos, porque cada uno lo arregla
 * alguien distinto: sin token es lo normal (el primer sondeo de Claude), un token malo lo arregla
 * el asistente renovando, un Keycloak caído se arregla solo y un canje mal configurado es nuestro.
 */
function refuse(res: ServerResponse, hosted: HostedConfig, error: unknown): void {
    const failure =
        error instanceof AuthFailure ? error : new AuthFailure(500, "server_error", "Internal error.");
    if (failure instanceof ExchangeMisconfigured) {
        log.error("el canje está mal configurado: lo arregla una persona de PlanVortex", {
            status: failure.upstreamStatus,
            error: failure.upstreamError,
            detail: failure.detail,
        });
    } else if (!(error instanceof AuthFailure)) {
        log.error("fallo inesperado al autenticar", {
            error: error instanceof Error ? error.message : error,
        });
    } else if (failure.status === 503) {
        log.warn("Keycloak no contesta", { reason: failure.message });
    } else if (failure.code) {
        log.info("token rechazado", { status: failure.status, reason: failure.message });
    } else {
        log.debug("petición sin token");
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (failure.status === 401 || failure.status === 403)
        headers["www-authenticate"] = wwwAuthenticate(hosted, failure);
    if (failure.status === 503) headers["retry-after"] = "5";
    res.writeHead(failure.status, headers);
    res.end(JSON.stringify({ error: failure.code ?? "unauthorized", error_description: failure.message }));
}
