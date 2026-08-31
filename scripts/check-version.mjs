/**
 * La version vive en CINCO sitios, y los cinco tienen que decir lo mismo.
 *
 * No es pedanteria: cada uno rompe de una forma distinta y ninguna es evidente.
 *
 * - `package.json` es lo que se publica en npm.
 * - `server.json` lo lee el registro oficial de MCP, que **valida que la version del paquete npm
 *   coincida** con la que declara. Si no cuadran, la release entra en npm y se cae en el registro,
 *   que es el peor sitio para enterarse porque ese job va con `continue-on-error`.
 * - `server.json` la repite dentro de `packages[]`: es la version del paquete, no la del servidor,
 *   y son dos campos distintos que casi siempre valen lo mismo.
 * - `manifest.json` es lo que ve quien instala el bundle `.mcpb` de un doble clic, y una version
 *   vieja ahi es lo que le hace pensar que no se actualizo.
 * - `src/config.ts` es lo que el servidor anuncia en `server/discover` y en `--version`, o sea lo
 *   unico que ve alguien depurando una conexion.
 *
 * Corre en CI y antes de publicar. Falla con la lista de quien discrepa.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const json = (file) => JSON.parse(read(file));

const pkg = json("package.json");
const server = json("server.json");
const manifest = json("manifest.json");

const config = /export const VERSION = "([^"]+)"/.exec(read("src/config.ts"))?.[1];

const found = {
    "package.json": pkg.version,
    "server.json (server)": server.version,
    "server.json (packages[0])": server.packages?.[0]?.version,
    "manifest.json": manifest.version,
    "src/config.ts": config,
};

const expected = pkg.version;
const wrong = Object.entries(found).filter(([, value]) => value !== expected);

if (wrong.length > 0) {
    process.stderr.write(
        `Las versiones no coinciden. package.json dice ${expected} y estos no:\n` +
            wrong.map(([where, value]) => `  ${where}: ${value ?? "(no encontrada)"}`).join("\n") +
            "\n",
    );
    process.exit(1);
}

//Y el identificador del registro, que tiene que ser el mismo en los dos ficheros o `mcp-publisher`
//rechaza la publicacion sin decir cual de los dos esta mal.
if (pkg.mcpName !== server.name) {
    process.stderr.write(
        `El nombre del registro no coincide: package.json dice "${pkg.mcpName}" y server.json ` +
            `dice "${server.name}".\n`,
    );
    process.exit(1);
}

//Y que `packages[0].identifier` sea el paquete de npm que se publica de verdad.
if (server.packages?.[0]?.identifier !== pkg.name) {
    process.stderr.write(
        `server.json apunta al paquete "${server.packages?.[0]?.identifier}" y este se publica ` +
            `como "${pkg.name}".\n`,
    );
    process.exit(1);
}

process.stdout.write(`Version ${expected} coherente en los cinco sitios.\n`);
