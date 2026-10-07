/**
 * CAPA 1 — el modo alojado: `mcp.planvortex.com` (fase 2 de PlanVortexServer/.claude/roadmaps/chatgpt.md).
 *
 * Aquí está la barrera de esa fase, y el bloque que la sostiene es el de AISLAMIENTO: dos personas
 * a la vez, cada una con sus organizaciones, y ninguna ve las de la otra ni con la caché caliente.
 * Es la trampa 1 del roadmap —el fallo más caro de todos, porque sale con datos coherentes y sin un
 * solo error— y estos tests son lo único que la vigila.
 *
 * Todo es de verdad salvo la red: el servidor HTTP escucha en un puerto, un cliente MCP real habla
 * con él, el token va firmado con una clave RSA generada aquí, y Keycloak (JWKS y canje) y la API
 * son `msw`. Sin Docker, sin red y sin credenciales.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { SignJWT, UnsecuredJWT, decodeJwt, exportJWK, generateKeyPair } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { BASE_URL, api, isError, paged, testConfig, textOf } from "./helpers.js";
import { ConfigError, DEFAULT_CONNECTOR_CLIENTS, loadConfig, type Config } from "../src/config.js";
import { serveHosted, type HostedHandle } from "../src/hosted.js";
import { setLogLevel } from "../src/log.js";

const PORT = 39_281;
const PUBLIC_URL = `http://127.0.0.1:${PORT}/mcp`;
const ISSUER = "https://auth.test.planvortex.com/realms/PlanVortex";
const CERTS = `${ISSUER}/protocol/openid-connect/certs`;
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`;
const EXCHANGE_SECRET = "exchange-secret-del-test";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let realmKeys: KeyPair;
let foreignKeys: KeyPair;
let jwks: { keys: object[] };

beforeAll(async () => {
    realmKeys = await generateKeyPair("RS256", { extractable: true });
    foreignKeys = await generateKeyPair("RS256", { extractable: true });
    jwks = {
        keys: [{ ...(await exportJWK(realmKeys.publicKey)), kid: "realm-key", alg: "RS256", use: "sig" }],
    };
    //`bypass` y no `error`: el cliente MCP de los tests habla por `fetch` con el servidor de
    //verdad en 127.0.0.1, y msw también ve esas peticiones.
    api.listen({ onUnhandledRequest: "bypass" });
});
afterAll(() => api.close());

/** Lo que vieron Keycloak y la API durante un test. */
interface World {
    exchanges: number;
    /** Cada `Authorization` que llegó a la API, tal cual. */
    apiAuthorizations: string[];
    /** `persona:organización` de cada lista de cuentas pedida. */
    accountsAsked: string[];
    clientsAsked: Record<string, number>;
}
let world: World;
let handle: HostedHandle | undefined;
const clients: Client[] = [];

beforeEach(() => {
    setLogLevel("silent");
    world = { exchanges: 0, apiAuthorizations: [], accountsAsked: [], clientsAsked: {} };
    api.use(...keycloak(), ...apiFor(ORGS));
});

afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    await handle?.close();
    handle = undefined;
    //Todos los tests usan el mismo puerto, y el `fetch` de Node guarda los sockets keep-alive: si el
    //siguiente test sale antes de que el cliente procese el cierre del servidor anterior, reutiliza
    //un socket muerto y la petición acaba en ECONNRESET. Es del test, no del servidor.
    await new Promise((resolve) => setTimeout(resolve, 50));
    api.resetHandlers();
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Keycloak y la API, falsos
// ---------------------------------------------------------------------------------------------

/** El token que devuelve el canje: un JWT con el `sub` de la persona, como el de verdad. */
function exchangedToken(sub: string): string {
    return new UnsecuredJWT({ sub, azp: "planvortex_mcp" }).encode();
}

function keycloak(options: { expiresIn?: number } = {}) {
    return [
        http.get(CERTS, () => HttpResponse.json(jwks)),
        http.post(TOKEN_ENDPOINT, async ({ request }) => {
            world.exchanges += 1;
            const basic = Buffer.from(`planvortex_mcp:${EXCHANGE_SECRET}`).toString("base64");
            if (request.headers.get("authorization") !== `Basic ${basic}`) {
                return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
            }
            const form = new URLSearchParams(await request.text());
            if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange") {
                return HttpResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
            }
            const sub = String(decodeJwt(form.get("subject_token") ?? "").sub);
            return HttpResponse.json({
                access_token: exchangedToken(sub),
                expires_in: options.expiresIn ?? 1500,
                token_type: "Bearer",
            });
        }),
    ];
}

const ORGS: Record<string, { _id: string; name: string }[]> = {
    alice: [{ _id: "org-alice", name: "Panadería de Alicia" }],
    bob: [{ _id: "org-bob", name: "Estudio de Bruno" }],
};

/** Quién llama a la API, sacado del token que trae. Y se apunta, para ver que es el canjeado. */
function caller(request: Request): string {
    const header = request.headers.get("authorization") ?? "";
    world.apiAuthorizations.push(header);
    return String(decodeJwt(header.replace(/^Bearer /, "")).sub);
}

function apiFor(orgs: Record<string, { _id: string; name: string }[]>) {
    return [
        http.get(`${BASE_URL}/clients_organizations`, ({ request }) => {
            const sub = caller(request);
            world.clientsAsked[sub] = (world.clientsAsked[sub] ?? 0) + 1;
            const own = orgs[sub] ?? [];
            return HttpResponse.json({
                clients: [{ _id: `client-${sub}`, organizations: own, total: own.length }],
                total: 1,
            });
        }),
        http.get(`${BASE_URL}/organizations/:id/accounts`, ({ request, params }) => {
            const sub = caller(request);
            world.accountsAsked.push(`${sub}:${String(params["id"])}`);
            return HttpResponse.json(
                paged("accounts", [
                    {
                        _id: `acc-${sub}`,
                        name: `Cuenta de ${sub}`,
                        social_network: "instagram",
                        error_code: 0,
                        deleted: false,
                    },
                ]),
            );
        }),
    ];
}

// ---------------------------------------------------------------------------------------------
// Tokens, servidor y clientes
// ---------------------------------------------------------------------------------------------

interface Claims {
    sub?: string;
    azp?: string;
    scope?: string;
    aud?: string | string[];
    iss?: string;
    exp?: number | string;
    typ?: string;
}

/** Un token como el que manda Claude: firmado por el realm, para este servidor y su conector. */
async function assistantToken(
    claims: Claims = {},
    key: KeyPair["privateKey"] = realmKeys.privateKey,
): Promise<string> {
    return new SignJWT({
        azp: claims.azp ?? "mcp-claude-public",
        scope: claims.scope ?? "planvortex:write planvortex:read offline_access",
        typ: claims.typ ?? "Bearer",
    })
        .setProtectedHeader({ alg: "RS256", kid: "realm-key" })
        .setIssuer(claims.iss ?? ISSUER)
        .setAudience(claims.aud ?? [PUBLIC_URL, "planvortex_mcp"])
        .setSubject(claims.sub ?? "alice")
        .setIssuedAt()
        .setExpirationTime(claims.exp ?? "10m")
        .sign(key);
}

function hostedConfig(overrides: Partial<Config> = {}): Config {
    return testConfig({
        mode: "hosted",
        port: PORT,
        clientId: undefined,
        clientSecret: undefined,
        hosted: {
            publicUrl: PUBLIC_URL,
            issuer: ISSUER,
            issuerInternalUrl: ISSUER,
            exchangeClientId: "planvortex_mcp",
            exchangeClientSecret: EXCHANGE_SECRET,
            connectorClients: [...DEFAULT_CONNECTOR_CLIENTS],
        },
        ...overrides,
    });
}

async function start(overrides: Partial<Config> = {}): Promise<HostedHandle> {
    handle = await serveHosted(hostedConfig(overrides));
    return handle;
}

/** Un cliente MCP de verdad, con el token en la cabecera como lo manda un asistente. */
async function connect(bearer: string, options: { modern?: boolean } = {}): Promise<Client> {
    const client = new Client(
        { name: "test", version: "0.0.0" },
        options.modern ? { versionNegotiation: { mode: "auto" } } : {},
    );
    await client.connect(
        new StreamableHTTPClientTransport(new URL(PUBLIC_URL), {
            requestInit: { headers: { authorization: `Bearer ${bearer}` } },
        }),
    );
    clients.push(client);
    return client;
}

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

/** Un `initialize` a pelo, para mirar el código HTTP y las cabeceras de la respuesta. */
async function rawInitialize(authorization?: string): Promise<Response> {
    return fetch(PUBLIC_URL, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(authorization === undefined ? {} : { authorization }),
        },
        body: INITIALIZE,
    });
}

async function toolNames(client: Client): Promise<string[]> {
    return (await client.listTools()).tools.map((tool) => tool.name);
}

// ---------------------------------------------------------------------------------------------

describe("los cuatro caminos de autenticación", () => {
    it("sin token: 401 con el WWW-Authenticate que lleva a los metadatos, y sin `error`", async () => {
        await start();
        const response = await rawInitialize();
        expect(response.status).toBe(401);
        const challenge = response.headers.get("www-authenticate") ?? "";
        expect(challenge).toContain(
            `resource_metadata="http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource/mcp"`,
        );
        expect(challenge).toContain('scope="planvortex:read planvortex:write"');
        //RFC 6750 §3.1: si no vino token, no hay `error` que dar. Es el sondeo normal de Claude.
        expect(challenge).not.toContain("error=");
        expect(world.exchanges).toBe(0);
    });

    it("un token de otra audiencia: 401 invalid_token, aunque lo haya firmado el realm", async () => {
        await start();
        const token = await assistantToken({ aud: "account" });
        const response = await rawInitialize(`Bearer ${token}`);
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
        expect(world.exchanges).toBe(0);
    });

    it("sin el scope de lectura: 403 insufficient_scope", async () => {
        await start();
        const token = await assistantToken({ scope: "offline_access" });
        const response = await rawInitialize(`Bearer ${token}`);
        expect(response.status).toBe(403);
        expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
        expect(world.exchanges).toBe(0);
    });

    it("un token bueno: contesta MCP, y la API recibe a esa persona", async () => {
        await start();
        const client = await connect(await assistantToken({ sub: "alice" }));
        const result = await client.callTool({ name: "list_organizations", arguments: {} });
        expect(isError(result)).toBe(false);
        expect(textOf(result)).toContain("Panadería de Alicia");
    });

    it("y los demás que firma el realm tampoco pasan: otro emisor, otra clave, caducado, otro azp, otro tipo", async () => {
        await start();
        const rejected = [
            await assistantToken({ iss: "https://auth.test.planvortex.com/realms/Otro" }),
            await assistantToken({}, foreignKeys.privateKey),
            await assistantToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
            //El panel, o la app de un integrador: firmados por el realm, pero no son un conector.
            await assistantToken({ azp: "planvortex-web" }),
            await assistantToken({ typ: "Refresh" }),
        ];
        for (const token of rejected) {
            const response = await rawInitialize(`Bearer ${token}`);
            expect(response.status).toBe(401);
            expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
        }
        expect(await rawInitialize("Basic dXN1YXJpbzpjbGF2ZQ==").then((r) => r.status)).toBe(401);
        expect(world.exchanges).toBe(0);
    });

    it("acepta los dos clientes de CIMD de Anthropic, que es como conecta Claude sin escribir nada", async () => {
        await start();
        for (const azp of [
            "https://claude.ai/oauth/mcp-oauth-client-metadata",
            "https://claude.ai/oauth/claude-code-client-metadata",
        ]) {
            const response = await rawInitialize(`Bearer ${await assistantToken({ azp })}`);
            expect(response.status).toBe(200);
        }
    });
});

describe("el canje: el token del asistente muere aquí (decisión 5)", () => {
    it("a la API sólo llega el token canjeado, nunca el que trajo el asistente", async () => {
        await start();
        const incoming = await assistantToken({ sub: "alice" });
        const client = await connect(incoming);
        await client.callTool({ name: "list_accounts", arguments: {} });
        expect(world.apiAuthorizations.length).toBeGreaterThan(0);
        for (const header of world.apiAuthorizations) {
            expect(header).toBe(`Bearer ${exchangedToken("alice")}`);
            expect(header).not.toContain(incoming);
        }
    });

    it("se canjea una vez por persona y se reutiliza, también con peticiones a la vez", async () => {
        await start();
        const token = await assistantToken({ sub: "alice" });
        const statuses = await Promise.all(
            Array.from({ length: 5 }, () => rawInitialize(`Bearer ${token}`).then((r) => r.status)),
        );
        expect(statuses).toEqual([200, 200, 200, 200, 200]);
        const client = await connect(token);
        await client.callTool({ name: "list_organizations", arguments: {} });
        expect(world.exchanges).toBe(1);
    });

    it("vuelve a canjear cuando al canjeado le queda poco", async () => {
        api.use(...keycloak({ expiresIn: 30 }));
        await start();
        const token = await assistantToken({ sub: "alice" });
        await rawInitialize(`Bearer ${token}`);
        await rawInitialize(`Bearer ${token}`);
        expect(world.exchanges).toBe(2);
    });

    it("si Keycloak ya no da por buena la sesión, es un 401: el asistente renueva o pide entrar", async () => {
        api.use(
            http.post(TOKEN_ENDPOINT, () =>
                HttpResponse.json(
                    { error: "invalid_token", error_description: "Invalid token" },
                    { status: 400 },
                ),
            ),
        );
        await start();
        const response = await rawInitialize(`Bearer ${await assistantToken()}`);
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    });

    it("si el que falla es NUESTRO secreto, es un 500 y no un 401 que mandaría a todos a reconectar", async () => {
        await start({
            hosted: { ...hostedConfig().hosted!, exchangeClientSecret: "secreto-equivocado" },
        });
        const response = await rawInitialize(`Bearer ${await assistantToken()}`);
        expect(response.status).toBe(500);
        expect(response.headers.get("www-authenticate")).toBeNull();
    });

    it("con Keycloak caído es un 503 con Retry-After, no un 401", async () => {
        api.use(http.post(TOKEN_ENDPOINT, () => HttpResponse.error()));
        await start();
        const response = await rawInitialize(`Bearer ${await assistantToken()}`);
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
    });

    it("y sin JWKS también: el token puede estar perfecto", async () => {
        api.use(http.get(CERTS, () => new HttpResponse("upstream down", { status: 502 })));
        await start();
        const response = await rawInitialize(`Bearer ${await assistantToken()}`);
        expect(response.status).toBe(503);
    });
});

describe("AISLAMIENTO: nadie ve lo de otro (decisión 6, trampa 1)", () => {
    it("dos personas, una detrás de otra y con la caché caliente: cada una ve sólo lo suyo", async () => {
        await start();
        const alice = await connect(await assistantToken({ sub: "alice" }));
        const bob = await connect(await assistantToken({ sub: "bob" }));

        const first = textOf(await alice.callTool({ name: "list_organizations", arguments: {} }));
        //La segunda de Alicia sale de su caché: no vuelve a preguntar a la API.
        const again = textOf(await alice.callTool({ name: "list_organizations", arguments: {} }));
        const bobs = textOf(await bob.callTool({ name: "list_organizations", arguments: {} }));
        const third = textOf(await alice.callTool({ name: "list_organizations", arguments: {} }));

        for (const text of [first, again, third]) {
            expect(text).toContain("Panadería de Alicia");
            expect(text).not.toContain("Estudio de Bruno");
        }
        expect(bobs).toContain("Estudio de Bruno");
        expect(bobs).not.toContain("Panadería de Alicia");
        expect(world.clientsAsked).toEqual({ alice: 1, bob: 1 });
        expect(handle?.registry.size).toBe(2);
    });

    it("a la vez, mezcladas: ninguna respuesta lleva lo del otro", async () => {
        await start();
        const alice = await connect(await assistantToken({ sub: "alice" }));
        const bob = await connect(await assistantToken({ sub: "bob" }));
        const calls = Array.from({ length: 12 }, (_, i) => {
            const who = i % 2 === 0 ? "alice" : "bob";
            const client = who === "alice" ? alice : bob;
            return client
                .callTool({ name: "list_organizations", arguments: {} })
                .then((r) => [who, textOf(r)] as const);
        });
        for (const [who, text] of await Promise.all(calls)) {
            expect(text).toContain(who === "alice" ? "Panadería de Alicia" : "Estudio de Bruno");
            expect(text).not.toContain(who === "alice" ? "Estudio de Bruno" : "Panadería de Alicia");
        }
    });

    it("la organización que se resuelve sola es la de quien llama", async () => {
        await start();
        const alice = await connect(await assistantToken({ sub: "alice" }));
        const bob = await connect(await assistantToken({ sub: "bob" }));
        await Promise.all([
            alice.callTool({ name: "list_accounts", arguments: {} }),
            bob.callTool({ name: "list_accounts", arguments: {} }),
            alice.callTool({ name: "list_accounts", arguments: {} }),
        ]);
        expect([...world.accountsAsked].sort()).toEqual([
            "alice:org-alice",
            "alice:org-alice",
            "bob:org-bob",
        ]);
    });

    it("el anti-duplicado es de cada persona: dos miembros de la misma organización publican dos veces", async () => {
        let created = 0;
        api.use(
            ...apiFor({
                alice: [{ _id: "org-shared", name: "Compartida" }],
                bob: [{ _id: "org-shared", name: "Compartida" }],
            }),
            http.get(`${BASE_URL}/social_limits`, () =>
                HttpResponse.json({ characters: { instagram: 2200 } }),
            ),
            http.get(`${BASE_URL}/social_capabilities`, () =>
                HttpResponse.json({ instagram: { publications: true, destinations: false, link: false } }),
            ),
            http.post(`${BASE_URL}/organizations/org-shared/accounts/acc-1/publish`, ({ request }) => {
                created += 1;
                return HttpResponse.json({
                    publication: {
                        _id: `pub-${created}-${caller(request)}`,
                        creation_date: "2026-10-06T10:00:00.000Z",
                        files: [],
                        id_account: "acc-1",
                        id_organization: "org-shared",
                        publication_errors: [],
                        publication_type: "profile",
                        retries: 0,
                        social_network: "instagram",
                        state: "ready",
                        text: "Pan recién hecho",
                    },
                });
            }),
        );
        await start();
        const args = { id_account: "acc-1", social_network: "instagram", text: "Pan recién hecho" };
        const alice = await connect(await assistantToken({ sub: "alice" }));
        const bob = await connect(await assistantToken({ sub: "bob" }));

        const fromAlice = textOf(await alice.callTool({ name: "create_publication", arguments: args }));
        const fromBob = textOf(await bob.callTool({ name: "create_publication", arguments: args }));
        //El reintento de la MISMA persona sí se reconoce: el anti-duplicado sigue funcionando.
        const retry = textOf(await alice.callTool({ name: "create_publication", arguments: args }));

        expect(created).toBe(2);
        expect(fromAlice).toContain("alice");
        expect(fromBob).toContain("bob");
        expect(fromBob).not.toContain("already existed");
        expect(retry).toContain("already existed");
        expect(retry).toContain("alice");
    });
});

describe("los scopes: leer y escribir (decisión 7)", () => {
    it("quien sólo concede lectura no ve ninguna herramienta de escritura", async () => {
        await start();
        const client = await connect(await assistantToken({ scope: "planvortex:read" }));
        const names = await toolNames(client);
        expect(names).toContain("list_accounts");
        for (const write of [
            "create_publication",
            "update_publication",
            "send_message",
            "reply_to_comment",
            "upload_media",
        ]) {
            expect(names).not.toContain(write);
        }
        expect(client.getInstructions()).toContain("READ access only");
    });

    it("y no puede llamarlas aunque se sepa el nombre", async () => {
        let published = 0;
        api.use(
            http.post(`${BASE_URL}/organizations/:id/accounts/:account/publish`, () => {
                published += 1;
                return HttpResponse.json({});
            }),
        );
        await start();
        const client = await connect(await assistantToken({ scope: "planvortex:read" }));
        const refused = await client
            .callTool({
                name: "create_publication",
                arguments: { id_account: "acc-1", social_network: "instagram", text: "hola" },
            })
            .then(
                (result) => isError(result),
                () => true,
            );
        expect(refused).toBe(true);
        expect(published).toBe(0);
    });

    it("con escritura las tiene, y crear planes de IA no está nunca (decisión 7)", async () => {
        await start();
        const names = await toolNames(await connect(await assistantToken()));
        expect(names).toContain("create_publication");
        expect(names).toContain("list_ai_plans");
        expect(names).not.toContain("create_ai_plan");
    });
});

describe("lo que cambia cuando detrás hay una persona y no una app", () => {
    it("las instrucciones lo dicen, y no mandan a tocar ninguna variable de entorno", async () => {
        await start();
        const client = await connect(await assistantToken());
        const instructions = client.getInstructions() ?? "";
        expect(instructions).toContain("hosted connection");
        expect(instructions).not.toContain("READ access only");
    });

    //Un enlace de conexión sólo se emite a una app (la API contesta 514 a una persona), y una
    //herramienta que falla SIEMPRE con parámetros válidos es lo que la revisión de Claude rechaza. Así
    //que no está, y todo lo que mandaba a ella manda al panel.
    it("create_connect_link no está, y nada manda a ella: las cuentas se conectan en el panel", async () => {
        await start();
        const client = await connect(await assistantToken());
        expect(await toolNames(client)).not.toContain("create_connect_link");
        const instructions = client.getInstructions() ?? "";
        expect(instructions).toContain("Accounts page");
        expect(instructions).not.toContain("create_connect_link");
        expect(instructions).not.toContain("PLANVORTEX_MCP_ALLOW_AI");
    });

    it("una cuenta en error manda al panel, no a una herramienta que no está en el listado", async () => {
        api.use(
            http.get(`${BASE_URL}/organizations/:id/accounts`, () =>
                HttpResponse.json(
                    { code: 703, message: "The account has no permissions on the network", data: {} },
                    { status: 400 },
                ),
            ),
        );
        await start();
        const client = await connect(await assistantToken());
        const text = textOf(await client.callTool({ name: "list_accounts", arguments: {} }));
        expect(text).toContain("Accounts page");
        expect(text).not.toContain("create_connect_link");
    });

    it("un 520 habla del rol de la persona, no de la app ni de su configuración", async () => {
        api.use(
            http.get(`${BASE_URL}/organizations/:id/accounts`, () =>
                HttpResponse.json(
                    {
                        code: 520,
                        message: "Insufficient permissions, required:",
                        data: { permissions: ["accounts:read"] },
                    },
                    { status: 401 },
                ),
            ),
        );
        await start();
        const client = await connect(await assistantToken());
        const text = textOf(await client.callTool({ name: "list_accounts", arguments: {} }));
        expect(text).toContain("their role does not allow");
        expect(text).toContain("accounts:read");
        expect(text).not.toMatch(/PLANVORTEX_CLIENT|to the app/);
    });

    it("con varias organizaciones pide el id, sin mencionar PLANVORTEX_ORGANIZATION_ID", async () => {
        api.use(
            ...apiFor({
                alice: [
                    { _id: "org-1", name: "Una" },
                    { _id: "org-2", name: "Otra" },
                ],
            }),
        );
        await start();
        const client = await connect(await assistantToken({ sub: "alice" }));
        const text = textOf(await client.callTool({ name: "list_accounts", arguments: {} }));
        expect(text).toContain("This user reaches 2 organizations");
        expect(text).not.toContain("PLANVORTEX_ORGANIZATION_ID");
    });

    it("habla también el protocolo 2026-07-28, que es el que usa Claude con token", async () => {
        await start();
        const client = await connect(await assistantToken({ sub: "bob" }), { modern: true });
        const text = textOf(await client.callTool({ name: "list_organizations", arguments: {} }));
        expect(text).toContain("Estudio de Bruno");
    });
});

describe("los metadatos del recurso (RFC 9728)", () => {
    it("en las dos rutas, con el resource IGUAL a la URL configurada (trampa 27)", async () => {
        await start();
        for (const path of [
            "/.well-known/oauth-protected-resource/mcp",
            "/.well-known/oauth-protected-resource",
        ]) {
            const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
            expect(response.status).toBe(200);
            const body = (await response.json()) as Record<string, unknown>;
            expect(body["resource"]).toBe(PUBLIC_URL);
            expect(body["authorization_servers"]).toEqual([ISSUER]);
            expect(body["scopes_supported"]).toEqual(["planvortex:read", "planvortex:write"]);
        }
    });

    it("tiene /health y nada más fuera del endpoint", async () => {
        await start();
        expect((await fetch(`http://127.0.0.1:${PORT}/health`)).status).toBe(200);
        expect((await fetch(`http://127.0.0.1:${PORT}/otra-cosa`)).status).toBe(404);
    });
});

describe("ni un token en los logs (trampa 3 de oauth.ts)", () => {
    it("ni el del asistente, ni el canjeado, ni el secreto del canje, aunque el nivel sea debug", async () => {
        const written: string[] = [];
        vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
            written.push(String(chunk));
            return true;
        });
        await start({ logLevel: "debug" });
        setLogLevel("debug");

        const good = await assistantToken({ sub: "alice" });
        const wrongAudience = await assistantToken({ aud: "account" });
        await rawInitialize();
        await rawInitialize(`Bearer ${wrongAudience}`);
        const client = await connect(good);
        await client.callTool({ name: "list_accounts", arguments: {} });
        api.use(
            http.post(TOKEN_ENDPOINT, () => HttpResponse.json({ error: "invalid_grant" }, { status: 400 })),
        );
        await rawInitialize(`Bearer ${await assistantToken({ sub: "carol" })}`);
        setLogLevel("silent");

        const log = written.join("");
        expect(log).toContain("token rechazado");
        for (const secret of [good, wrongAudience, exchangedToken("alice"), EXCHANGE_SECRET]) {
            expect(log).not.toContain(secret);
        }
    });
});

describe("loadConfig en modo alojado", () => {
    const BASE_ENV = {
        PLANVORTEX_MCP_PUBLIC_URL: "https://mcp.planvortex.com/mcp",
        PLANVORTEX_MCP_ISSUER: "https://auth.planvortex.com/realms/PlanVortex",
        PLANVORTEX_MCP_EXCHANGE_CLIENT_SECRET: "s3cr3t",
    };

    it("con --hosted, o con PLANVORTEX_MCP_MODE=hosted, y lo mínimo, arranca", () => {
        for (const [env, argv] of [
            [BASE_ENV, ["--hosted"]],
            [{ ...BASE_ENV, PLANVORTEX_MCP_MODE: "hosted" }, []],
        ] as const) {
            const config = loadConfig({ ...env }, [...argv]);
            expect(config.mode).toBe("hosted");
            expect(config.hosted?.publicUrl).toBe("https://mcp.planvortex.com/mcp");
            expect(config.hosted?.issuerInternalUrl).toBe("https://auth.planvortex.com/realms/PlanVortex");
            expect(config.hosted?.exchangeClientId).toBe("planvortex_mcp");
            expect(config.hosted?.connectorClients).toEqual(DEFAULT_CONNECTOR_CLIENTS);
        }
    });

    it("se niega a arrancar con lo que es de UN dueño (trampa 2)", () => {
        for (const name of [
            "PLANVORTEX_CLIENT_ID",
            "PLANVORTEX_CLIENT_SECRET",
            "PLANVORTEX_ORGANIZATION_ID",
            "PLANVORTEX_MCP_ALLOW_AI",
            "PLANVORTEX_MCP_AUTH_TOKEN",
            "PLANVORTEX_MCP_UPLOAD_DIRS",
        ]) {
            expect(() => loadConfig({ ...BASE_ENV, [name]: "x" }, ["--hosted"]), name).toThrow(ConfigError);
            expect(() => loadConfig({ ...BASE_ENV, [name]: "x" }, ["--hosted"]), name).toThrow(name);
        }
    });

    it("dice qué falta", () => {
        expect(() => loadConfig({}, ["--hosted"])).toThrow(
            /PLANVORTEX_MCP_PUBLIC_URL.*PLANVORTEX_MCP_ISSUER.*SECRET/,
        );
    });

    it("no publica en claro fuera de localhost, ni con una URL con query", () => {
        expect(() =>
            loadConfig({ ...BASE_ENV, PLANVORTEX_MCP_PUBLIC_URL: "http://mcp.planvortex.com/mcp" }, [
                "--hosted",
            ]),
        ).toThrow(/https/);
        expect(() =>
            loadConfig({ ...BASE_ENV, PLANVORTEX_MCP_ISSUER: "http://auth.planvortex.com/realms/x" }, [
                "--hosted",
            ]),
        ).toThrow(/https/);
        expect(() =>
            loadConfig({ ...BASE_ENV, PLANVORTEX_MCP_PUBLIC_URL: "https://mcp.planvortex.com/mcp?x=1" }, [
                "--hosted",
            ]),
        ).toThrow(/query/);
        expect(
            loadConfig({ ...BASE_ENV, PLANVORTEX_MCP_PUBLIC_URL: "http://127.0.0.1:3000/mcp" }, ["--hosted"])
                .hosted?.publicUrl,
        ).toBe("http://127.0.0.1:3000/mcp");
    });

    it("la lista de conectores y la URL interna se pueden dar", () => {
        const config = loadConfig(
            {
                ...BASE_ENV,
                PLANVORTEX_MCP_CONNECTOR_CLIENTS: "mcp-claude, mcp-chatgpt ,",
                PLANVORTEX_MCP_ISSUER_INTERNAL_URL: "http://planvortex_keycloak:8080/realms/PlanVortex/",
            },
            ["--hosted"],
        );
        expect(config.hosted?.connectorClients).toEqual(["mcp-claude", "mcp-chatgpt"]);
        expect(config.hosted?.issuerInternalUrl).toBe("http://planvortex_keycloak:8080/realms/PlanVortex");
    });

    it("--http y --hosted a la vez es un error, no una elección", () => {
        expect(() => loadConfig(BASE_ENV, ["--http", "--hosted"])).toThrow(/pick one/);
    });
});
