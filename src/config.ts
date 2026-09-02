/**
 * El entorno entero, validado con zod, en un solo sitio.
 *
 * Un fallo aquí sale por `stderr` con una frase que explica qué falta, y esa frase dice lo de la
 * TRAMPA 15 —que las apps son exclusivas del plan Custom— porque un `401` a secas manda a esa
 * persona a abrir un ticket.
 *
 * Lo que ese fallo hace DESPUÉS depende del transporte, y la diferencia se pagó con una ficha rota
 * en un directorio: unas credenciales que faltan terminan el proceso en `--http` y **no** en stdio.
 * La razón entera está en `main`.
 */
import * as z from "zod";
import type { LogLevel } from "./log.js";

/** Cómo se anuncia el servidor. La versión la sube el release, no la mano. */
export const SERVER_NAME = "planvortex";
export const VERSION = "0.1.5";

/** El `User-Agent` con el que este servidor se distingue de la librería en los logs del API. */
export const USER_AGENT = `planvortex-mcp/${VERSION}`;

export type TransportMode = "stdio" | "http";

export interface Config {
    /**
     * La app del plan Custom. **Opcionales en stdio**, y no por descuido: ver
     * {@link CREDENTIALS_HELP}. Sin ellas el servidor arranca, lista sus herramientas y falla en la
     * primera que salga a la red.
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
    logLevel: LogLevel;
}

/** Lo que un fallo de configuración le enseña a quien arrancó el proceso. */
export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

/**
 * TRAMPA 15: las apps (`client_app`) son EXCLUSIVAS del plan Custom. Un cliente de otro plan ni
 * siquiera puede crear las credenciales que este servidor pide, y si el primer mensaje no lo dice,
 * esa persona se va a pasar la tarde buscando un fallo de configuración que no existe.
 */
export const CREDENTIALS_HELP = [
    "planvortex-mcp needs PLANVORTEX_CLIENT_ID and PLANVORTEX_CLIENT_SECRET.",
    "",
    "These come from an app in your PlanVortex account, and apps are part of the Custom plan.",
    "Create one in the PlanVortex panel (Settings -> Apps) and pass the credentials in the env",
    "block of your MCP client configuration. See https://planvortex.com/developers",
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
    PLANVORTEX_MCP_LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
});

export interface Flags {
    http: boolean;
    host: string | undefined;
    port: number | undefined;
    version: boolean;
    help: boolean;
}

/** `--http`, `--host`, `--port`, `--version`, `--help`. Sin librería: son cinco. */
export function parseArgs(argv: readonly string[]): Flags {
    const flags: Flags = { http: false, host: undefined, port: undefined, version: false, help: false };
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

    const mode: TransportMode = flags.http ? "http" : "stdio";
    const host = flags.host ?? "127.0.0.1";
    const port = flags.port ?? 3000;
    const hasCredentials = Boolean(value.PLANVORTEX_CLIENT_ID && value.PLANVORTEX_CLIENT_SECRET);

    if (mode === "http") {
        //En `--http` sí se termina el proceso: eso es un despliegue, nadie está mirando el
        //`stderr` de un contenedor que se queda arriba, y un servidor que contesta `200` a un
        //`tools/list` y falla en las veinticinco herramientas es peor que uno que no arranca. En
        //stdio es al revés, y por qué está en `main`.
        if (!hasCredentials) {
            throw new ConfigError(CREDENTIALS_HELP);
        }
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            throw new ConfigError(`--port must be a number between 1 and 65535, got "${port}".`);
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
        logLevel: value.PLANVORTEX_MCP_LOG_LEVEL ?? "info",
    };
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
  planvortex-mcp --version
  planvortex-mcp --help

Flags:
  --http           serve over HTTP instead of stdio
  --host <host>    HTTP bind address (default 127.0.0.1)
  --port <port>    HTTP port (default 3000)

Environment:
  PLANVORTEX_CLIENT_ID        required — an app from your Custom plan
  PLANVORTEX_CLIENT_SECRET    required — its secret
  PLANVORTEX_ORGANIZATION_ID  optional — the default organization
  PLANVORTEX_BASE_URL         optional — point at another PlanVortex deployment
  PLANVORTEX_MCP_UPLOAD_DIRS  optional — directories upload_media may read from
  PLANVORTEX_MCP_AUTH_TOKEN   required with --http outside loopback
  PLANVORTEX_MCP_READ_ONLY    optional — 1 disables every write tool
  PLANVORTEX_MCP_LOG_LEVEL    optional — debug | info | warn | error | silent

Docs: https://planvortex.com/developers`;
