/**
 * Levanta el servidor COMO LO LEVANTA UN DIRECTORIO y le pide su catalogo.
 *
 * Existe porque el 2026-09-02 la ficha de Glama salio rota con «Container exited with code 1
 * before responding to ping», y debajo habia tres fallos encadenados que **ningun test podia ver**:
 * las cuatro capas prueban el servidor, y nada ejecutaba la imagen ni el binario por stdio de
 * verdad. Los tres:
 *
 * 1. El `ENTRYPOINT` apuntaba a `dist/index.js`, que solo EXPORTA. El contenedor terminaba con
 *    codigo 0, en silencio, sin haber servido una linea de MCP.
 * 2. La imagen estaba clavada en `--http`, y un contenedor de un servidor MCP se arranca por stdio.
 * 3. Sin credenciales el proceso se negaba a arrancar, y un directorio introspecciona **sin
 *    ninguna variable de entorno**.
 *
 * Asi que esto es el test que faltaba, y es de caja negra a proposito: se le pasa un comando —el
 * que sea— y hace el saludo completo contra su `stdin`/`stdout`.
 *
 *   node scripts/introspect.mjs -- node dist/cli.js
 *   node scripts/introspect.mjs -- docker run -i --rm planvortex-mcp:ci
 *
 * Con `--expect-no-credentials` ademas exige lo que hace falta para que una ficha salga entera:
 * que el catalogo NO venga vacio sin credenciales, y que la primera herramienta que sale a la red
 * falle con la frase del plan Custom en vez de con un 401 sin explicacion.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator === -1 || separator === argv.length - 1) {
    process.stderr.write("Uso: node scripts/introspect.mjs [--expect-no-credentials] -- <comando...>\n");
    process.exit(2);
}
const flags = argv.slice(0, separator);
const [command, ...commandArgs] = argv.slice(separator + 1);
const expectNoCredentials = flags.includes("--expect-no-credentials");

/** Treinta segundos: un `docker run` tira de la imagen antes de arrancar nada. */
const TIMEOUT_MS = 30_000;

//Con `--expect-no-credentials` el entorno se limpia de `PLANVORTEX_*`: si no, la comprobacion pasa
//o falla segun lo que tenga exportado quien la ejecuta, que es justo lo contrario de lo que se
//quiere fijar.
const env = { ...process.env };
if (expectNoCredentials) {
    for (const name of Object.keys(env)) if (name.startsWith("PLANVORTEX_")) delete env[name];
}

const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"], env });
let stderrText = "";
child.stderr.on("data", (chunk) => {
    stderrText += chunk;
    process.stderr.write(`  [servidor] ${chunk}`);
});
child.on("error", (error) => fail(`no se pudo ejecutar "${command}": ${error.message}`));
child.on("exit", (code) => {
    //El fallo original, exactamente: el proceso se muere antes de contestar. Si ya hemos terminado
    //el saludo, `done` esta puesto y esto no dice nada.
    if (!done) fail(`el proceso termino con codigo ${code} antes de contestar al saludo`);
});

let done = false;
const timer = setTimeout(() => fail(`sin respuesta en ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS);

function fail(message) {
    done = true;
    clearTimeout(timer);
    process.stderr.write(`\nFALLO: ${message}\n`);
    child.kill();
    process.exit(1);
}

function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
}

const REQUESTS = [
    { id: 2, method: "tools/list", key: "tools" },
    { id: 3, method: "resources/list", key: "resources" },
    { id: 4, method: "prompts/list", key: "prompts" },
];
const counts = {};

createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        //TRAMPA 11: en stdio el protocolo viaja por `stdout`, asi que una linea que no sea JSON ahi
        //es exactamente la averia que esa trampa describe.
        return fail(`llego una linea que no es JSON-RPC por stdout: ${line.slice(0, 200)}`);
    }
    if (message.error)
        return fail(`${message.method ?? `id ${message.id}`}: ${JSON.stringify(message.error)}`);

    if (message.id === 1) {
        const info = message.result?.serverInfo;
        if (info?.name !== "planvortex") return fail(`serverInfo inesperado: ${JSON.stringify(info)}`);
        process.stdout.write(
            `initialize     OK  ${info.name} v${info.version}, protocolo ${message.result.protocolVersion}\n`,
        );
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        for (const request of REQUESTS) send({ jsonrpc: "2.0", id: request.id, method: request.method });
        return;
    }

    const listing = REQUESTS.find((request) => request.id === message.id);
    if (listing) {
        const items = message.result?.[listing.key] ?? [];
        counts[listing.key] = items.length;
        process.stdout.write(`${listing.method.padEnd(14)} OK  ${items.length}\n`);
        if (Object.keys(counts).length < REQUESTS.length) return;
        //Un catalogo vacio es como se ve desde fuera un servidor que exige configuracion para
        //arrancar: contesta, y no tiene nada que ensenar.
        if (counts.tools === 0) return fail("el catalogo de herramientas vino VACIO");
        if (!expectNoCredentials) return finish();
        return send({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: { name: "list_organizations", arguments: {} },
        });
    }

    if (message.id === 5) {
        const text = (message.result?.content ?? []).map((block) => block.text ?? "").join("\n");
        if (message.result?.isError !== true) {
            return fail("sin credenciales, la herramienta contesto como si hubiera funcionado");
        }
        //TRAMPA 15: las apps son del plan Custom. Un `401` a secas manda a esa persona a abrir un
        //ticket, asi que la frase tiene que llegar hasta el modelo.
        if (!text.includes("Custom plan") || !text.includes("PLANVORTEX_CLIENT_ID")) {
            return fail(
                `el error de la herramienta no explica que faltan credenciales: ${text.slice(0, 200)}`,
            );
        }
        process.stdout.write("tools/call     OK  isError, y el texto dice lo del plan Custom\n");
        return finish();
    }
});

function finish() {
    if (expectNoCredentials && !stderrText.includes("Custom plan")) {
        return fail("el arranque sin credenciales no aviso por stderr");
    }
    done = true;
    clearTimeout(timer);
    process.stdout.write("\nEl servidor contesta al saludo completo.\n");
    child.kill();
    process.exit(0);
}

send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "planvortex-introspect", version: "0" },
    },
});
