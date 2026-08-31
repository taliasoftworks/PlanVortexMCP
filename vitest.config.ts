import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        //Las capas 1 y 2: la lógica de las herramientas con la API mockeada, y el servidor a través
        //de un cliente MCP de verdad. Sin red y sin credenciales.
        include: ["test/**/*.test.ts"],
        exclude: ["test/live/**"],
        environment: "node",
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
        },
    },
});
