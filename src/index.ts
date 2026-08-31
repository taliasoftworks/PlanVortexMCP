/**
 * El `bin`: banderas, entorno y arranque.
 *
 * Todo lo que este fichero escribe va por `stderr` (§ trampa 11): en stdio el protocolo viaja por
 * `stdout` y una línea suelta ahí corrompe el JSON-RPC. `--version` y `--help` son la excepción
 * razonada — para cuando se piden, no hay ninguna sesión MCP que romper y quien las pide es una
 * persona en una terminal.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigError, HELP_TEXT, VERSION, loadConfig, parseArgs } from "./config.js";
import { createContext } from "./context.js";
import { createServer } from "./server.js";
import { log, setLogLevel } from "./log.js";

export { createServer } from "./server.js";
export { createContext } from "./context.js";
export { loadConfig } from "./config.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    //Las dos banderas que se contestan sin credenciales: si `--help` exigiera un `client_id`, la
    //única forma de averiguar qué variables hacen falta sería leer el código.
    let early;
    try {
        early = parseArgs(argv);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
        return;
    }
    if (early.version) {
        process.stdout.write(`${VERSION}\n`);
        return;
    }
    if (early.help) {
        process.stdout.write(`${HELP_TEXT}\n`);
        return;
    }

    let config;
    try {
        config = loadConfig(process.env, argv);
    } catch (error) {
        //Un fallo de configuración sale entero y el proceso termina: no se arranca a medias. El
        //texto lleva lo del plan Custom (§ trampa 15), porque un 401 a secas manda a esa persona a
        //abrir un ticket.
        const message = error instanceof ConfigError ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
        return;
    }

    setLogLevel(config.logLevel);
    const ctx = createContext(config);

    if (config.mode === "http") {
        const { serveHttp } = await import("./http.js");
        await serveHttp(ctx, config);
        return;
    }

    //`serveStdio` trae `legacy: 'serve'` por defecto, así que atiende a los clientes de la era 2025
    //sin hacer nada — y son la mayoría de los instalados hoy. Se usa el punto de entrada y no un
    //transporte montado a mano porque es lo que activa el protocolo 2026-07-28 (§ trampa 10).
    serveStdio(() => createServer(ctx), {
        onerror: (error) => log.error("fallo del transporte stdio", { error: error.message }),
    });
    log.info(`servidor listo (v${VERSION}, ${config.readOnly ? "sólo lectura" : "lectura y escritura"})`);
}

//Aqui NO se arranca nada. Quien ejecuta es `cli.ts`, que es el `bin`, y ahi esta explicado por
//que estan separados: adivinar si a un modulo lo han ejecutado o importado no tiene una respuesta
//fiable, y cuando falla, falla en silencio.
