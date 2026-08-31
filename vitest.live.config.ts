import { defineConfig } from "vitest/config";

/**
 * CAPA 3 — contra un PlanVortex de verdad.
 *
 * Nunca corre en CI: necesita un stack y credenciales. Es la única capa que ve un `outputSchema`
 * que ya no encaja con lo que la API devuelve, y la única que confirma que las veinticinco
 * herramientas siguen llamando a rutas que existen.
 */
export default defineConfig({
    test: {
        include: ["test/live/**/*.test.ts"],
        environment: "node",
        //Una llamada a la API de verdad puede tardar; y van en serie porque comparten cuota.
        testTimeout: 60_000,
        fileParallelism: false,
    },
});
