import js from "@eslint/js";
import typescript from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
import globals from "globals";

export default [
    {
        ignores: ["dist/**", "coverage/**"],
    },
    js.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
                sourceType: "module",
            },
            globals: {
                ...globals.node,
                ...globals.es2022,
            },
        },
        plugins: {
            "@typescript-eslint": typescript,
        },
        rules: {
            ...typescript.configs.recommended.rules,
            "no-undef": "off",
            "@typescript-eslint/consistent-type-imports": "error",
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            // Trampa 11: en stdio el protocolo VIAJA por stdout. Un `console.log` de depuración se
            // mete en medio del JSON-RPC y el cliente ve un mensaje corrupto; el síntoma es un
            // servidor que «no arranca» sin ningún error. Todo log va por `stderr`, y el único
            // sitio que escribe es `log.ts`.
            "no-console": "error",
        },
    },
    {
        files: ["src/log.ts", "test/**/*.ts"],
        rules: { "no-console": "off" },
    },
    {
        // Los scripts de mantenimiento son JavaScript suelto, no entran en el bundle y no los
        // analiza el `projectService` de TypeScript. Sin esto, `process` sale como no definido.
        files: ["scripts/**/*.mjs"],
        languageOptions: {
            sourceType: "module",
            globals: { ...globals.node },
        },
    },
];
