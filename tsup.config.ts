import { defineConfig } from "tsup";

/**
 * Salida ESM y nada más. Al revés que en `planvortex`, aquí no hay CJS que servir: esto no es una
 * librería que alguien importe, es un `bin` que arranca un proceso, y quien lo arranca es `npx`.
 *
 * El banner del shebang lo pone tsup, y sin él `npx planvortex-mcp` no ejecuta nada en Linux.
 */
export default defineConfig({
    entry: {
        index: "src/index.ts",
    },
    format: ["esm"],
    target: "node20",
    platform: "node",
    dts: true,
    sourcemap: true,
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
    //Las tres dependencias de runtime viajan como dependencias, no dentro del bundle: `planvortex`
    //porque es la librería que el servidor consume y su versión importa, y el SDK porque trae sus
    //propios `exports` condicionales (`_shims`) que un bundle aplanaría.
    external: ["@modelcontextprotocol/server", "planvortex", "zod"],
    treeshake: true,
});
