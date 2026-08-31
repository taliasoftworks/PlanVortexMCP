/**
 * Valida `server.json` contra el esquema del registro oficial de MCP.
 *
 * POR QUE EXISTE: la 0.1.0 y la 0.1.1 se publicaron en npm con un `server.json` invalido y el alta
 * en el registro fallo las dos veces. No se noto porque ese job va con `continue-on-error` —tiene
 * que ir, el registro esta en preview y no puede tumbar una release que ya esta en npm—, asi que
 * la release salia verde y el servidor no aparecia en ningun sitio.
 *
 * El fallo era tonto y de los que no se ven leyendo: el esquema es **snake_case**
 * (`registry_type`, `environment_variables`, `is_required`, `website_url`) y el fichero estaba
 * escrito en camelCase, como el resto del proyecto. `mcp-publisher` lo rechaza sin decir que campo
 * esta mal.
 *
 * Comprueba ademas dos limites que el esquema impone y que es facil pasarse escribiendo copy:
 * la descripcion no puede pasar de 100 caracteres.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
//`ajv` llega como dependencia transitiva de eslint. Si algun dia deja de estar, mejor decirlo que
//saltarse la comprobacion en silencio.
let Ajv;
try {
    Ajv = require("ajv");
} catch {
    process.stderr.write("Falta `ajv` para validar server.json. Instalalo: npm i -D ajv\n");
    process.exit(1);
}

const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

const schemaUrl = server.$schema;
if (!schemaUrl) {
    process.stderr.write("server.json no declara $schema.\n");
    process.exit(1);
}

const response = await fetch(schemaUrl);
if (!response.ok) {
    //Sin red no se falla el build: se avisa y se sigue. Es una comprobacion, no una dependencia.
    process.stderr.write(`No se pudo descargar el esquema (${response.status}). Se omite la validacion.\n`);
    process.exit(0);
}
const schema = await response.json();

//`validateFormats: false` porque el esquema usa `format: "uri"` y ajv no lo trae de serie: sin
//esto suelta un aviso por cada campo y el ruido tapa el error que si importa. Lo que se comprueba
//aqui son los NOMBRES de los campos y los limites, no que una URL sea sintacticamente perfecta.
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const validate = ajv.compile(schema);

if (!validate(server)) {
    process.stderr.write("server.json NO valida contra el esquema del registro MCP:\n");
    for (const error of validate.errors ?? []) {
        process.stderr.write(
            `  ${error.instancePath || "(raiz)"} ${error.message} ${JSON.stringify(error.params)}\n`,
        );
    }
    process.exit(1);
}

process.stdout.write("server.json valida contra el esquema del registro MCP.\n");
