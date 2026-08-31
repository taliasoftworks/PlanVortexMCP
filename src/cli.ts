/**
 * El `bin`. Lo unico que hace es arrancar, y por eso existe separado de `index.ts`.
 *
 * LA RAZON, que costo un fallo de verdad: cuando el binario y los exports viven en el mismo
 * fichero hay que preguntarse «¿me han ejecutado a mi, o me han importado?», y esa pregunta no
 * tiene una respuesta fiable. La forma habitual —comparar `process.argv[1]` con
 * `import.meta.url`— falla en dos casos que no son raros:
 *
 * - **`import.meta.url` es una URL y escapa caracteres.** Un usuario que se llame `José`, o que
 *   tenga un espacio en el nombre de usuario, tiene un `import.meta.url` con `%C3%A9` o `%20`
 *   donde `argv[1]` lleva el caracter tal cual. No coinciden, y el proceso **termina sin hacer
 *   nada y sin decir nada**: `npx planvortex-mcp` se queda mudo.
 * - **npm instala el bin como un enlace simbolico** en Linux y macOS. Ahi `argv[1]` es el enlace y
 *   `import.meta.url` es el destino, asi que tampoco coinciden.
 *
 * Con dos ficheros no hay nada que adivinar: esto se ejecuta siempre, y quien importe el paquete
 * importa `index.ts`, que no arranca nada.
 */
import { main } from "./index.js";

void main().catch((error: unknown) => {
    //Por `stderr`, como todo (§ trampa 11): en stdio el protocolo viaja por `stdout`.
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
});
