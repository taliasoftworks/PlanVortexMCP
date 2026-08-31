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

//COMPROBAR PRIMERO QUE EL ESQUEMA DECLARADO ES EL VIGENTE.
//
//Sin esto, esta comprobacion no vale nada, y ya paso: el fichero declaraba el esquema `2025-07-09`
//—que sigue publicado y descargandose bien— y validaba en verde, mientras la API viva lo rechazaba
//con un 422. El `2025-07-09` es snake_case y el vigente es camelCase, asi que "validar" contra el
//viejo era exactamente lo contrario de lo que hacia falta.
//
//La fuente de verdad no es el esquema que uno elija: es el que el registro estampa en los
//servidores que ya tiene dados de alta.
try {
    const listado = await fetch("https://registry.modelcontextprotocol.io/v0/servers?limit=20");
    if (listado.ok) {
        const { servers = [] } = await listado.json();
        const vigentes = new Set(servers.map((entrada) => entrada?.server?.$schema).filter(Boolean));
        if (vigentes.size > 0 && !vigentes.has(schemaUrl)) {
            process.stderr.write(
                `server.json declara el esquema:\n  ${schemaUrl}\n` +
                    `pero el registro esta usando:\n  ${[...vigentes].join("\n  ")}\n` +
                    "Actualiza el $schema y revisa los nombres de los campos: han cambiado de " +
                    "snake_case a camelCase entre versiones.\n",
            );
            process.exit(1);
        }
    }
} catch {
    //Sin red se sigue: esto es una comprobacion, no una dependencia.
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
