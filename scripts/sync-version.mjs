/**
 * Escribe en los otros cuatro sitios la version que ya tiene `package.json`.
 *
 * Es la contraparte de `check-version.mjs`: aquel comprueba, este escribe. Sin el, subir de version
 * es editar cinco ficheros a mano y descubrir el que se olvido en la CI —o, peor, en el registro de
 * MCP, cuyo job va con `continue-on-error` y falla en silencio despues de que npm ya publico—.
 *
 * Va enganchado al ciclo de vida `version` de npm, que corre DESPUES de que npm suba
 * `package.json` y ANTES de que haga el commit y el tag. O sea: `npm version 0.2.0` sincroniza los
 * cinco, los mete en el commit y etiqueta, todo de una.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = (file) => join(root, file);
const read = (file) => readFileSync(path(file), "utf8");

const version = JSON.parse(read("package.json")).version;

/** Reescribe un JSON conservando el formato: se toca el campo, no se re-serializa el fichero. */
function patchJson(file, patches) {
    let text = read(file);
    for (const [pattern, replacement] of patches) {
        const before = text;
        text = text.replace(pattern, replacement);
        if (text === before) {
            process.stderr.write(`No se encontro ${pattern} en ${file}. Revisa el fichero a mano.\n`);
            process.exit(1);
        }
    }
    writeFileSync(path(file), text);
}

//`server.json` lleva DOS: la del servidor y la del paquete npm dentro de `packages[]`. Son campos
//distintos que casi siempre valen lo mismo, y olvidar el segundo es lo que rechaza el registro.
patchJson("server.json", [
    [/("version":\s*")[^"]+(")/, `$1${version}$2`],
    [/("identifier":\s*"planvortex-mcp",\s*"version":\s*")[^"]+(")/s, `$1${version}$2`],
]);

patchJson("manifest.json", [[/("version":\s*")[^"]+(")/, `$1${version}$2`]]);

//Lo que el servidor anuncia en `server/discover` y en `--version`: lo unico que ve alguien
//depurando una conexion.
patchJson("src/config.ts", [[/(export const VERSION = ")[^"]+(")/, `$1${version}$2`]]);

process.stdout.write(`Version ${version} escrita en server.json, manifest.json y src/config.ts.\n`);
