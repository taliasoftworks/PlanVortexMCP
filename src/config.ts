/**
 * El entorno entero, validado con zod, en un solo sitio.
 *
 * Un fallo aquí sale por `stderr` con una frase que explica qué falta, porque un `401` a secas
 * manda a esa persona a abrir un ticket.
 *
 * Lo que ese fallo hace DESPUÉS depende del transporte, y la diferencia se pagó con una ficha rota
 * en un directorio: unas credenciales que faltan terminan el proceso en `--http` y **no** en stdio.
 * La razón entera está en `main`.
 */
import * as z from "zod";
import type { LogLevel } from "./log.js";

/** Cómo se anuncia el servidor. La versión la sube el release, no la mano. */
export const SERVER_NAME = "planvortex";
export const VERSION = "0.11.1";

/** El `User-Agent` con el que este servidor se distingue de la librería en los logs del API. */
export const USER_AGENT = `planvortex-mcp/${VERSION}`;

/**
 * `hosted` es el `mcp.planvortex.com` de la fase 2 de `chatgpt.md`, y NO es un `--http` con más
 * cosas: en `--http` el proceso es de UN dueño y habla con la API con la app de ese dueño; en
 * `hosted` cada petición trae a una persona distinta, con su propio token, y no hay app ninguna.
 */
export type TransportMode = "stdio" | "http" | "hosted";

/** Lo que sólo existe en modo alojado: de quién se fía el servidor y con qué canjea. */
export interface HostedConfig {
    /**
     * La URL pública del endpoint, **tal cual**: es el `resource` de los metadatos y la audiencia
     * que tiene que traer el token. Una barra de más aquí y el token deja de valer, o quien tenga
     * conector y plugin ve dos juegos de herramientas iguales (trampa 27). Se compara byte a byte
     * y no se normaliza a propósito.
     */
    publicUrl: string;
    /** El `issuer` del realm, como sale en el `iss` de los tokens. Va en `authorization_servers`. */
    issuer: string;
    /**
     * El mismo realm, por donde lo alcanza ESTE proceso: la red interna del compose. De ahí salen
     * el JWKS y el canje. Con `KC_HOSTNAME` fijo, Keycloak calcula el mismo `issuer` entre por
     * donde entre la petición, así que el canje no rechaza el token por venir de «otro realm».
     */
    issuerInternalUrl: string;
    /** El cliente confidencial que canjea (`planvortex_mcp`): el único cuyo token llega a la API. */
    exchangeClientId: string;
    exchangeClientSecret: string;
    /**
     * Los `azp` que se aceptan: los clientes que representan a un asistente. Configurable y no una
     * constante, porque el de ChatGPT llega en la fase 9 y los de CIMD los decide Anthropic.
     */
    connectorClients: string[];
}

/**
 * Los conectores de Claude desde el primer día: los dos predefinidos y los dos documentos de CIMD
 * de Anthropic (decisión 4). `mcp-chatgpt` no está: entra en la fase 9, por configuración.
 */
export const DEFAULT_CONNECTOR_CLIENTS = [
    "mcp-claude",
    "mcp-claude-public",
    "https://claude.ai/oauth/mcp-oauth-client-metadata",
    "https://claude.ai/oauth/claude-code-client-metadata",
];

export interface Config {
    /**
     * La app. **Opcionales en stdio**, y no por descuido: ver {@link CREDENTIALS_HELP}. Sin ellas
     * el servidor arranca, lista sus herramientas y falla en la primera que salga a la red.
     */
    clientId: string | undefined;
    clientSecret: string | undefined;
    /** Para apuntar a un stack local. Ausente = la nube. */
    baseUrl: string | undefined;
    /** La organización por defecto (§ trampa 1). Ahorra una llamada por conversación. */
    organizationId: string | undefined;
    mode: TransportMode;
    /** Sólo en `--http`. */
    host: string;
    port: number;
    /** Obligatorio si el `--http` se ata fuera de loopback (§ trampa 12). */
    authToken: string | undefined;
    /** Directorios desde los que `upload_media` puede leer un fichero (§ trampa 6). */
    uploadDirs: string[];
    /** Apaga las nueve herramientas de escritura. */
    readOnly: boolean;
    /**
     * Enciende `create_ai_plan`, que es la única herramienta de este servidor que GASTA CRÉDITOS.
     *
     * Apagada por defecto, y al revés que {@link readOnly}: aquí no se apaga algo que existía, se
     * enciende algo que no. El roadmap del servidor dejó los planes de IA fuera de la v1 con un
     * motivo que sigue siendo cierto —«un agente en bucle es justo el peor cliente posible para un
     * endpoint que factura»— y lo fiaba a la MRTR, que hoy casi ningún cliente implementa.
     *
     * Esto es la confirmación humana que la MRTR no da: la escribe una persona en su fichero de
     * configuración, una vez, ANTES de que ningún agente arranque. Y como el gate actúa en el
     * registro —igual que `readOnly`—, con él apagado la herramienta no está en `tools/list` y no
     * hay forma de llamarla.
     *
     * Las tres de lectura (`get_planner_templates`, `list_ai_plans`, `get_ai_plan`) no dependen de
     * esto: no facturan nada, y sin ellas el modelo no puede ni explicar lo que costaría.
     */
    allowAiPlans: boolean;
    logLevel: LogLevel;
    /** Sólo en modo `hosted`; `undefined` en los otros dos. */
    hosted: HostedConfig | undefined;
}

/** Lo que un fallo de configuración le enseña a quien arrancó el proceso. */
export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

/**
 * LA TRAMPA 15 SE MURIÓ, y este texto es lo último que quedaba de ella.
 *
 * Decía que las apps (`client_app`) eran EXCLUSIVAS del plan Custom, y fue cierto hasta el
 * 02-09-2026: la fase 2 de `cambios-planvortex.md` quitó `requireCustomPlan` de las rutas de apps
 * y las abrió a los cuatro planes, el gratuito incluido. Lo que queda ahí es `requireAppQuota`
 * —1 app en Free, 2 en Basic, 5 en Pro, 10 en Custom—, que es un cupo y no una puerta.
 *
 * Dejarlo escrito era peor que un dato viejo: es el PRIMER mensaje que lee quien instala esto sin
 * credenciales, y mandaba a pagar a quien ya podía usarlo gratis — exactamente al revés de lo que
 * la fase 2 abrió y de lo que la fase 11 va a salir a contar.
 */
export const CREDENTIALS_HELP = [
    "planvortex-mcp needs PLANVORTEX_CLIENT_ID and PLANVORTEX_CLIENT_SECRET.",
    "",
    "These come from an app in your PlanVortex account, and every plan has apps — the free one",
    "included. Create one in the PlanVortex panel (Settings -> Apps) and pass the credentials in",
    "the env block of your MCP client configuration. See https://planvortex.com/developers",
].join("\n");

const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

const EnvSchema = z.object({
    PLANVORTEX_CLIENT_ID: z.string().min(1).optional(),
    PLANVORTEX_CLIENT_SECRET: z.string().min(1).optional(),
    PLANVORTEX_BASE_URL: z.string().url().optional(),
    PLANVORTEX_ORGANIZATION_ID: z.string().min(1).optional(),
    PLANVORTEX_MCP_UPLOAD_DIRS: z.string().optional(),
    PLANVORTEX_MCP_AUTH_TOKEN: z.string().min(1).optional(),
    PLANVORTEX_MCP_READ_ONLY: z.string().optional(),
    PLANVORTEX_MCP_ALLOW_AI: z.string().optional(),
    PLANVORTEX_MCP_LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
    PLANVORTEX_MCP_MODE: z.enum(["stdio", "http", "hosted"]).optional(),
    PLANVORTEX_MCP_PUBLIC_URL: z.string().url().optional(),
    PLANVORTEX_MCP_ISSUER: z.string().url().optional(),
    PLANVORTEX_MCP_ISSUER_INTERNAL_URL: z.string().url().optional(),
    PLANVORTEX_MCP_EXCHANGE_CLIENT_ID: z.string().min(1).optional(),
    PLANVORTEX_MCP_EXCHANGE_CLIENT_SECRET: z.string().min(1).optional(),
    PLANVORTEX_MCP_CONNECTOR_CLIENTS: z.string().optional(),
});

/**
 * TRAMPA 2 DE `chatgpt.md`, y las que vienen con ella: en un servidor de todos, lo que es de UN
 * dueño no puede existir. `PLANVORTEX_ORGANIZATION_ID` sería la organización por defecto de todo el
 * mundo (y la API contestaría 520 a quien no tenga rol en ella, que el modelo traduciría por «no
 * tienes permisos» en su propia cuenta); las credenciales de app darían a cada persona el acceso de
 * esa app; `ALLOW_AI` es una confirmación que da quien arranca el proceso y aquí no la puede dar
 * nadie (trampa 17); y el bearer fijo y los directorios de subida son del `--http` de un dueño.
 * No se ignoran: el proceso se niega a arrancar, porque ignorarlas en silencio es justo cómo un
 * despliegue mal copiado acaba en producción.
 */
const HOSTED_FORBIDDEN = [
    "PLANVORTEX_CLIENT_ID",
    "PLANVORTEX_CLIENT_SECRET",
    "PLANVORTEX_ORGANIZATION_ID",
    "PLANVORTEX_MCP_ALLOW_AI",
    "PLANVORTEX_MCP_AUTH_TOKEN",
    "PLANVORTEX_MCP_UPLOAD_DIRS",
] as const;

export interface Flags {
    http: boolean;
    hosted: boolean;
    host: string | undefined;
    port: number | undefined;
    version: boolean;
    help: boolean;
}

/** `--http`, `--hosted`, `--host`, `--port`, `--version`, `--help`. Sin librería: son seis. */
export function parseArgs(argv: readonly string[]): Flags {
    const flags: Flags = {
        http: false,
        hosted: false,
        host: undefined,
        port: undefined,
        version: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i] ?? "";
        const [name, inlineValue] = splitFlag(arg);
        const next = (): string => {
            if (inlineValue !== undefined) return inlineValue;
            i += 1;
            const value = argv[i];
            if (value === undefined) throw new ConfigError(`${name} needs a value.`);
            return value;
        };
        switch (name) {
            case "--http":
                flags.http = true;
                break;
            case "--hosted":
                flags.hosted = true;
                break;
            case "--host":
                flags.host = next();
                break;
            case "--port":
                flags.port = Number(next());
                break;
            case "--version":
            case "-v":
                flags.version = true;
                break;
            case "--help":
            case "-h":
                flags.help = true;
                break;
            default:
                throw new ConfigError(`Unknown flag: ${arg}. Run planvortex-mcp --help.`);
        }
    }
    return flags;
}

function splitFlag(arg: string): [string, string | undefined] {
    const eq = arg.indexOf("=");
    return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

/**
 * El entorno y las banderas, juntos y validados. Lanza {@link ConfigError} con la frase completa.
 */
export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
    const flags = parseArgs(argv);
    const parsed = EnvSchema.safeParse(env);
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ConfigError(
            `Bad configuration: ${first?.path.join(".") ?? "env"} — ${first?.message ?? "invalid"}`,
        );
    }
    const value = parsed.data;

    if (flags.http && flags.hosted) {
        throw new ConfigError("--http and --hosted are two different servers: pick one.");
    }
    const mode: TransportMode = flags.hosted
        ? "hosted"
        : flags.http
          ? "http"
          : (value.PLANVORTEX_MCP_MODE ?? "stdio");
    const host = flags.host ?? "127.0.0.1";
    const port = flags.port ?? 3000;
    const hasCredentials = Boolean(value.PLANVORTEX_CLIENT_ID && value.PLANVORTEX_CLIENT_SECRET);

    if (mode !== "stdio" && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
        throw new ConfigError(`--port must be a number between 1 and 65535, got "${port}".`);
    }

    const hosted = mode === "hosted" ? loadHostedConfig(env, value) : undefined;

    if (mode === "http") {
        //En `--http` sí se termina el proceso: eso es un despliegue, nadie está mirando el
        //`stderr` de un contenedor que se queda arriba, y un servidor que contesta `200` a un
        //`tools/list` y falla en todas las herramientas es peor que uno que no arranca. En
        //stdio es al revés, y por qué está en `main`.
        if (!hasCredentials) {
            throw new ConfigError(CREDENTIALS_HELP);
        }
        //TRAMPA 12: este proceso lleva DENTRO el client_secret de la app. Cualquiera que alcance el
        //puerto publica en las redes del cliente sin más credencial que un `curl`. Atarlo fuera de
        //loopback sin token no se avisa: se rechaza.
        if (!isLoopback(host) && !value.PLANVORTEX_MCP_AUTH_TOKEN) {
            throw new ConfigError(
                [
                    `Refusing to bind to ${host} without PLANVORTEX_MCP_AUTH_TOKEN.`,
                    "",
                    "This process holds your app's client_secret. Anything that can reach the port",
                    "can publish to your social accounts with a plain curl, with no credential of",
                    "its own. Set PLANVORTEX_MCP_AUTH_TOKEN to a long random string and send it as",
                    "'Authorization: Bearer <token>', or bind to 127.0.0.1 instead.",
                ].join("\n"),
            );
        }
    }

    return {
        clientId: value.PLANVORTEX_CLIENT_ID,
        clientSecret: value.PLANVORTEX_CLIENT_SECRET,
        baseUrl: value.PLANVORTEX_BASE_URL,
        organizationId: value.PLANVORTEX_ORGANIZATION_ID,
        mode,
        host,
        port,
        authToken: value.PLANVORTEX_MCP_AUTH_TOKEN,
        uploadDirs: splitList(value.PLANVORTEX_MCP_UPLOAD_DIRS),
        readOnly: isTruthy(value.PLANVORTEX_MCP_READ_ONLY),
        //Un `PLANVORTEX_MCP_READ_ONLY` encendido gana: es un servidor declarado de solo lectura, y
        //`create_ai_plan` escribe. No se cruzan aquí sino en `defineTool`, donde se cruzan las dos
        //banderas con una sola regla.
        allowAiPlans: isTruthy(value.PLANVORTEX_MCP_ALLOW_AI),
        logLevel: value.PLANVORTEX_MCP_LOG_LEVEL ?? "info",
        hosted,
    };
}

/**
 * Lo del modo alojado, validado entero antes de abrir el puerto: un `mcp.planvortex.com` que
 * arranca a medias contesta `401` a todo el mundo con cara de normalidad.
 */
function loadHostedConfig(env: NodeJS.ProcessEnv, value: z.infer<typeof EnvSchema>): HostedConfig {
    //Se mira el entorno crudo y no el valor parseado: una variable puesta a "" también es alguien
    //que copió el `.env` de otro despliegue, y el esquema la habría dado por ausente.
    const present = HOSTED_FORBIDDEN.filter((name) => env[name] !== undefined);
    if (present.length > 0) {
        throw new ConfigError(
            [
                `Refusing to start in hosted mode with ${present.join(", ")} set.`,
                "",
                "The hosted server is shared by every PlanVortex user: each request brings its own",
                "person and its own token. App credentials, a default organization, ALLOW_AI, a",
                "fixed bearer token or upload directories belong to a server with ONE owner (stdio",
                "or --http) and would leak that owner's settings to everybody. Remove them.",
            ].join("\n"),
        );
    }

    const missing = (
        [
            ["PLANVORTEX_MCP_PUBLIC_URL", value.PLANVORTEX_MCP_PUBLIC_URL],
            ["PLANVORTEX_MCP_ISSUER", value.PLANVORTEX_MCP_ISSUER],
            ["PLANVORTEX_MCP_EXCHANGE_CLIENT_SECRET", value.PLANVORTEX_MCP_EXCHANGE_CLIENT_SECRET],
        ] as const
    )
        .filter(([, setting]) => !setting)
        .map(([name]) => name);
    if (missing.length > 0) {
        throw new ConfigError(`Hosted mode needs ${missing.join(", ")}. Run planvortex-mcp --help.`);
    }

    const publicUrl = value.PLANVORTEX_MCP_PUBLIC_URL as string;
    const issuer = value.PLANVORTEX_MCP_ISSUER as string;
    assertSecureUrl("PLANVORTEX_MCP_PUBLIC_URL", publicUrl);
    assertSecureUrl("PLANVORTEX_MCP_ISSUER", issuer);
    const parsedPublic = new URL(publicUrl);
    if (parsedPublic.search || parsedPublic.hash) {
        throw new ConfigError("PLANVORTEX_MCP_PUBLIC_URL cannot carry a query or a fragment.");
    }

    const connectorClients = value.PLANVORTEX_MCP_CONNECTOR_CLIENTS
        ? value.PLANVORTEX_MCP_CONNECTOR_CLIENTS.split(",")
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
        : [...DEFAULT_CONNECTOR_CLIENTS];
    if (connectorClients.length === 0) {
        throw new ConfigError("PLANVORTEX_MCP_CONNECTOR_CLIENTS is set but lists no client.");
    }

    return {
        publicUrl,
        issuer,
        //Sin barra final: se le pegan rutas de Keycloak (`/protocol/openid-connect/...`).
        issuerInternalUrl: (value.PLANVORTEX_MCP_ISSUER_INTERNAL_URL ?? issuer).replace(/\/+$/, ""),
        exchangeClientId: value.PLANVORTEX_MCP_EXCHANGE_CLIENT_ID ?? "planvortex_mcp",
        exchangeClientSecret: value.PLANVORTEX_MCP_EXCHANGE_CLIENT_SECRET as string,
        connectorClients,
    };
}

/** `https`, salvo en loopback: así se puede probar en local y nunca publicar en claro. */
function assertSecureUrl(name: string, url: string): void {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return;
    if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) return;
    throw new ConfigError(`${name} has to be an https URL (plain http only on localhost), got "${url}".`);
}

/** `127.0.0.1`, `::1` y `localhost`. Lo demás es la red, aunque parezca de casa. */
export function isLoopback(host: string): boolean {
    const clean = host.replace(/^\[|\]$/g, "").toLowerCase();
    return clean === "127.0.0.1" || clean === "::1" || clean === "localhost";
}

function splitList(value: string | undefined): string[] {
    if (!value) return [];
    //Coma y `path.delimiter` a la vez: en Windows el separador natural es `;` y en POSIX `:`, pero
    //`:` parte una ruta `C:\...` por la mitad, así que ahí no se acepta.
    const parts = process.platform === "win32" ? value.split(/[;,]/) : value.split(/[:,]/);
    return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function isTruthy(value: string | undefined): boolean {
    if (!value) return false;
    const clean = value.trim().toLowerCase();
    return clean === "1" || clean === "true" || clean === "yes" || clean === "on";
}

export const HELP_TEXT = `planvortex-mcp ${VERSION} — the official MCP server for PlanVortex.

Usage:
  planvortex-mcp                 speak MCP over stdio (what an MCP client starts)
  planvortex-mcp --http          serve MCP over HTTP, for a self-hosted deployment
  planvortex-mcp --hosted        the multi-user server PlanVortex hosts itself (OAuth)
  planvortex-mcp --version
  planvortex-mcp --help

Flags:
  --http           serve over HTTP instead of stdio
  --hosted         serve many users over HTTP, each signed in with OAuth
  --host <host>    HTTP bind address (default 127.0.0.1)
  --port <port>    HTTP port (default 3000)

Environment:
  PLANVORTEX_CLIENT_ID        required — an app from your account (every plan has them)
  PLANVORTEX_CLIENT_SECRET    required — its secret
  PLANVORTEX_ORGANIZATION_ID  optional — the default organization
  PLANVORTEX_BASE_URL         optional — point at another PlanVortex deployment
  PLANVORTEX_MCP_UPLOAD_DIRS  optional — directories upload_media may read from
  PLANVORTEX_MCP_AUTH_TOKEN   required with --http outside loopback
  PLANVORTEX_MCP_READ_ONLY    optional — 1 disables every write tool
  PLANVORTEX_MCP_ALLOW_AI     optional — 1 enables create_ai_plan, which spends AI credits
  PLANVORTEX_MCP_LOG_LEVEL    optional — debug | info | warn | error | silent

Hosted mode (--hosted, or PLANVORTEX_MCP_MODE=hosted) refuses the app credentials, the default
organization, ALLOW_AI, AUTH_TOKEN and UPLOAD_DIRS, and needs instead:
  PLANVORTEX_MCP_PUBLIC_URL             required — this endpoint's public URL, exactly
  PLANVORTEX_MCP_ISSUER                 required — the Keycloak realm, as tokens name it in iss
  PLANVORTEX_MCP_ISSUER_INTERNAL_URL    optional — the same realm as this process reaches it
  PLANVORTEX_MCP_EXCHANGE_CLIENT_ID     optional — the client that exchanges (planvortex_mcp)
  PLANVORTEX_MCP_EXCHANGE_CLIENT_SECRET required — its secret
  PLANVORTEX_MCP_CONNECTOR_CLIENTS      optional — comma list of accepted azp

Docs: https://planvortex.com/developers`;
