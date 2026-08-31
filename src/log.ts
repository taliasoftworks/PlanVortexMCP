/**
 * El único fichero del servidor que escribe en una consola, y escribe **siempre en `stderr`**.
 *
 * TRAMPA 11 DEL ROADMAP, y no es una preferencia de estilo: en stdio el protocolo VIAJA por
 * `stdout`. Un `console.log` de depuración se mete en medio del JSON-RPC, el cliente ve un mensaje
 * corrupto y el síntoma es un servidor que «no arranca» sin ningún error en ninguna parte. Por eso
 * la regla la vigilan dos cosas a la vez: la regla `no-console` de ESLint —desactivada aquí y sólo
 * aquí— y un test que llama a todas las herramientas con `process.stdout.write` espiado.
 *
 * Encaja además con la spec 2026-07-28, que dejó `logging` DEPRECADO y recomienda exactamente esto:
 * `stderr` en stdio, u OpenTelemetry.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let current: LogLevel = "info";

/** `PLANVORTEX_MCP_LOG_LEVEL`, o `info`. `silent` calla del todo: útil dentro de los tests. */
export function setLogLevel(level: LogLevel): void {
    current = level;
}

export function getLogLevel(): LogLevel {
    return current;
}

function write(level: Exclude<LogLevel, "silent">, message: string, extra?: unknown): void {
    if (ORDER[level] < ORDER[current]) return;
    const line = extra === undefined ? message : `${message} ${safeJson(extra)}`;
    //`process.stderr.write` y no `console.error`: los dos acaban en el mismo sitio, pero escribir
    //en el descriptor a mano deja la garantía a la vista de quien lea este fichero.
    process.stderr.write(`[planvortex-mcp] ${level}: ${line}\n`);
}

/** Un `JSON.stringify` que no tumba el proceso por una referencia circular en un objeto de error. */
function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export const log = {
    debug: (message: string, extra?: unknown) => write("debug", message, extra),
    info: (message: string, extra?: unknown) => write("info", message, extra),
    warn: (message: string, extra?: unknown) => write("warn", message, extra),
    error: (message: string, extra?: unknown) => write("error", message, extra),
};
