/**
 * El modo alojado visto como SERVIDOR DE RECURSOS de OAuth: qué token se acepta y por cuál se
 * cambia antes de hablar con la API. Fase 2 de `PlanVortexServer/.claude/roadmaps/chatgpt.md`.
 *
 * El servidor de autorización es Keycloak (decisión 3): aquí no se emite nada, sólo se verifica y
 * se canjea. Las tres reglas que no se pueden aflojar:
 *
 * 1. **El token entrante muere aquí** (decisión 5). Lleva `aud` = esta URL y `azp` = un cliente de
 *    conector, y a la API sólo llega el que devuelve el canje, emitido a `planvortex_mcp`. La API
 *    rechaza los `azp` de conector (`isMcpConnectorToken` en el Server), así que un token robado a
 *    Claude no abre `api.planvortex.com`. Pasárselo tal cual sería el *token passthrough* que la
 *    spec de MCP prohíbe con nombre y apellidos.
 * 2. **Se mira todo lo que el token dice de sí mismo**: firma con el JWKS del realm, `iss`, `aud`,
 *    `exp`, `azp` dentro de la lista de conectores y el scope de lectura. Uno firmado por el realm
 *    pero emitido a otra cosa (el panel, la app de un integrador) no vale aunque la firma sea buena.
 * 3. **Ningún token va a un log**, ni en `debug`. Los mensajes de error dicen qué claim falló,
 *    nunca su valor.
 *
 * Y una distinción que importa más de lo que parece: un token malo es un `401` (el asistente
 * renueva o pide iniciar sesión) y un Keycloak caído es un `503` (esperar). Confundirlos manda a
 * todos los usuarios a volver a conectar PlanVortex por una caída de cinco minutos.
 */
import { createRemoteJWKSet, decodeJwt, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { HostedConfig } from "./config.js";
import { log } from "./log.js";

/** Leer. Es el mínimo: un token sin él no entra. */
export const READ_SCOPE = "planvortex:read";
/** Escribir. Sin él, las herramientas de escritura no se registran (decisión 7). */
export const WRITE_SCOPE = "planvortex:write";
export const SCOPES = [READ_SCOPE, WRITE_SCOPE] as const;

/** Quién llama, sacado de un token ya verificado. Es lo único que sigue adelante. */
export interface Principal {
    /** El id del usuario en Keycloak: la clave de todas las cachés del modo alojado. */
    sub: string;
    /** El cliente de conector que lo pidió (Claude, Claude Code, ChatGPT…). */
    azp: string;
    scopes: string[];
    /** El `exp` del token entrante, en segundos. */
    expiresAt: number;
}

/**
 * Un fallo de autenticación, con el código HTTP que le toca.
 *
 * `code` vacío es «no vino ningún token»: la RFC 6750 (§3.1) pide no poner `error` en ese caso,
 * porque no hay nada malo en el token, sólo falta. Claude manda primero una petición sin token para
 * descubrir el servidor, así que es el caso más frecuente con diferencia y no es un error.
 */
export class AuthFailure extends Error {
    constructor(
        readonly status: 401 | 403 | 500 | 503,
        readonly code:
            "invalid_token" | "insufficient_scope" | "temporarily_unavailable" | "server_error" | undefined,
        message: string,
    ) {
        super(message);
        this.name = "AuthFailure";
    }
}

/** Las dos rutas de Keycloak que se usan, sobre la URL interna del realm. */
export function keycloakEndpoints(hosted: HostedConfig): { certs: string; token: string } {
    return {
        certs: `${hosted.issuerInternalUrl}/protocol/openid-connect/certs`,
        token: `${hosted.issuerInternalUrl}/protocol/openid-connect/token`,
    };
}

/**
 * La URL de los metadatos del recurso (RFC 9728), con la ruta del recurso detrás:
 * `https://mcp.planvortex.com/mcp` → `https://mcp.planvortex.com/.well-known/oauth-protected-resource/mcp`.
 */
export function protectedResourceMetadataUrl(publicUrl: string): string {
    const url = new URL(publicUrl);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/** El documento de metadatos del recurso. El `resource` es la URL configurada, byte a byte. */
export function protectedResourceMetadata(hosted: HostedConfig): Record<string, unknown> {
    return {
        resource: hosted.publicUrl,
        //Claude usa el PRIMERO y no prueba los siguientes: aquí sólo hay uno.
        authorization_servers: [hosted.issuer],
        scopes_supported: [...SCOPES],
        bearer_methods_supported: ["header"],
        resource_name: "PlanVortex",
        resource_documentation: "https://planvortex.com/developers",
    };
}

/**
 * La cabecera `WWW-Authenticate` de un `401` o un `403`.
 *
 * El `resource_metadata` es lo que importa: es por donde Claude y ChatGPT descubren a quién pedirle
 * el token. Y tiene que ir en un `401` de verdad, porque un `WWW-Authenticate` en un `200` lo
 * ignoran.
 */
export function wwwAuthenticate(hosted: HostedConfig, failure?: AuthFailure): string {
    const parts = [
        `resource_metadata="${protectedResourceMetadataUrl(hosted.publicUrl)}"`,
        `scope="${SCOPES.join(" ")}"`,
    ];
    if (failure?.code === "invalid_token" || failure?.code === "insufficient_scope") {
        parts.push(
            `error="${failure.code}"`,
            `error_description="${failure.message.replace(/["\\]/g, "'")}"`,
        );
    }
    return `Bearer ${parts.join(", ")}`;
}

export type TokenVerifier = (
    authorization: string | undefined,
) => Promise<{ principal: Principal; token: string }>;

/**
 * El verificador. `getKey` sólo lo pasan los tests: en producción es el JWKS remoto del realm, que
 * `jose` cachea y vuelve a pedir cuando llega un `kid` que no conoce (una rotación de claves).
 */
export function createTokenVerifier(hosted: HostedConfig, getKey?: JWTVerifyGetKey): TokenVerifier {
    const keys =
        getKey ??
        createRemoteJWKSet(new URL(keycloakEndpoints(hosted).certs), {
            timeoutDuration: 5_000,
            cooldownDuration: 30_000,
        });

    return async (authorization) => {
        const token = bearerToken(authorization);
        if (!token) throw new AuthFailure(401, undefined, "No bearer token was sent.");

        let payload;
        try {
            ({ payload } = await jwtVerify(token, keys, {
                issuer: hosted.issuer,
                audience: hosted.publicUrl,
                //Los tokens de acceso de Keycloak van en RS256. Los de refresco van en HS512 y
                //no deben colar aquí nunca.
                algorithms: ["RS256"],
                requiredClaims: ["exp", "sub", "azp"],
            }));
        } catch (error) {
            throw verificationFailure(error);
        }

        //Un token de identidad o de refresco firmado por el realm no es un token de acceso.
        if (payload["typ"] !== undefined && payload["typ"] !== "Bearer") {
            throw new AuthFailure(401, "invalid_token", "This is not an access token.");
        }
        const azp = typeof payload["azp"] === "string" ? payload["azp"] : "";
        if (!hosted.connectorClients.includes(azp)) {
            throw new AuthFailure(
                401,
                "invalid_token",
                "This token was not issued to an assistant connector.",
            );
        }
        const sub = typeof payload.sub === "string" ? payload.sub : "";
        if (!sub) throw new AuthFailure(401, "invalid_token", "The token has no subject.");

        const scopes =
            typeof payload["scope"] === "string" ? payload["scope"].split(" ").filter(Boolean) : [];
        if (!scopes.includes(READ_SCOPE)) {
            throw new AuthFailure(403, "insufficient_scope", `${READ_SCOPE} was not granted.`);
        }

        return { principal: { sub, azp, scopes, expiresAt: payload.exp as number }, token };
    };
}

/** `Bearer <token>`, con el esquema en cualquier caja (RFC 7235). Nada más se acepta. */
function bearerToken(header: string | undefined): string | undefined {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
    return match?.[1];
}

/**
 * De un fallo de `jose` a lo que se le contesta al asistente. La línea que importa es la que separa
 * «el token no vale» (401) de «no he podido preguntarle a Keycloak» (503).
 */
function verificationFailure(error: unknown): AuthFailure {
    if (error instanceof errors.JWTExpired) {
        return new AuthFailure(401, "invalid_token", "The access token has expired.");
    }
    if (error instanceof errors.JWTClaimValidationFailed) {
        return new AuthFailure(
            401,
            "invalid_token",
            `The access token was not issued for this server (${error.claim}).`,
        );
    }
    //El JWKS no llegó: tiempo agotado, un 5xx de Keycloak (que `jose` lanza como el `JOSEError`
    //genérico) o una respuesta que no es un JWKS. El token puede estar perfecto.
    const code = (error as { code?: unknown } | undefined)?.code;
    if (
        error instanceof errors.JWKSTimeout ||
        error instanceof errors.JWKSInvalid ||
        code === "ERR_JOSE_GENERIC" ||
        !(error instanceof errors.JOSEError)
    ) {
        return new AuthFailure(
            503,
            "temporarily_unavailable",
            "The authorization server could not be reached.",
        );
    }
    return new AuthFailure(401, "invalid_token", "The access token is not valid.");
}

/** Lo que devuelve un canje bueno: el token para la API y hasta cuándo vale, en milisegundos. */
export interface ExchangedToken {
    token: string;
    expiresAt: number;
}

/**
 * El canje de la decisión 5: el token del asistente por uno emitido a `planvortex_mcp` (RFC 8693,
 * el *standard token exchange* de Keycloak desde la 26.2).
 *
 * Probado en la fase 0 con tokens de verdad: el canjeado trae el `sub` y el `sid` del usuario,
 * `azp=planvortex_mcp`, ni `client_id` (la API lo toma por un usuario, no por una app: trampa 7) ni
 * roles del realm (un superadministrador conectado a Claude no es superadministrador en Claude:
 * trampa 18). Funciona igual con un token renovado contra la sesión offline.
 */
export async function exchangeToken(
    hosted: HostedConfig,
    subjectToken: string,
    expectedSub: string,
    now: () => number = () => Date.now(),
): Promise<ExchangedToken> {
    //RFC 6749 §2.3.1: id y secreto van form-urlencoded ANTES del base64.
    const basic = Buffer.from(
        `${encodeURIComponent(hosted.exchangeClientId)}:${encodeURIComponent(hosted.exchangeClientSecret)}`,
    ).toString("base64");

    let response: Response;
    try {
        response = await fetch(keycloakEndpoints(hosted).token, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                authorization: `Basic ${basic}`,
            },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                subject_token: subjectToken,
                subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
                requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
            }),
            //El plazo de Claude para el token es de 10 s (trampa 31): no se le puede comer entero.
            signal: AbortSignal.timeout(8_000),
        });
    } catch {
        throw new AuthFailure(
            503,
            "temporarily_unavailable",
            "The authorization server could not be reached.",
        );
    }

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status >= 500) {
        throw new AuthFailure(503, "temporarily_unavailable", "The authorization server failed.");
    }
    if (!response.ok) {
        const error = typeof body["error"] === "string" ? body["error"] : "";
        //Nuestro secreto o nuestro permiso de canje: es configuración NUESTRA, no la sesión de la
        //persona. Contestar 401 aquí mandaría a todo el mundo a reconectar en bucle.
        if (error === "invalid_client" || error === "unauthorized_client" || response.status === 403) {
            throw new ExchangeMisconfigured(response.status, error, describe(body));
        }
        //Lo demás es que Keycloak ya no da por buena esa sesión (cerrada, caducada, usuario
        //desactivado): el token entrante es válido como JWT pero no sirve. Eso es un 401. Se
        //apunta con lo que dijo Keycloak, por si un día es un permiso nuestro disfrazado de 400:
        //entonces el síntoma sería TODO el mundo reconectando, y esta línea, la pista.
        log.warn("Keycloak rechazó el canje", {
            status: response.status,
            error,
            description: describe(body),
        });
        throw new AuthFailure(
            401,
            "invalid_token",
            "PlanVortex no longer accepts this sign-in. Sign in again.",
        );
    }

    const token = typeof body["access_token"] === "string" ? body["access_token"] : "";
    const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 0;
    if (!token || expiresIn <= 0) {
        throw new ExchangeMisconfigured(response.status, "", "the exchange answered without a usable token");
    }
    //Defensa barata: el token que va a hablar en nombre de esta persona es de esta persona. Si un
    //día no lo es, es una configuración rota de Keycloak y se para aquí.
    let sub: unknown;
    try {
        sub = decodeJwt(token).sub;
    } catch {
        sub = undefined;
    }
    if (sub !== expectedSub) {
        throw new ExchangeMisconfigured(
            response.status,
            "",
            "the exchanged token belongs to another subject",
        );
    }
    return { token, expiresAt: now() + expiresIn * 1000 };
}

/**
 * El canje falló por algo NUESTRO (secreto, permiso de canje, mapper). Se contesta `500` y se
 * escribe en el log como error: es lo único de aquí que una persona de PlanVortex tiene que arreglar.
 */
export class ExchangeMisconfigured extends AuthFailure {
    constructor(
        readonly upstreamStatus: number,
        readonly upstreamError: string,
        readonly detail: string,
    ) {
        super(500, "server_error", "The PlanVortex connector is misconfigured.");
        this.name = "ExchangeMisconfigured";
    }
}

/** El `error_description` de Keycloak, que nunca lleva un token. */
function describe(body: Record<string, unknown>): string {
    return typeof body["error_description"] === "string" ? body["error_description"] : "";
}
