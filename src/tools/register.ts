/**
 * El registrador común de las veinticinco herramientas.
 *
 * Existe para que tres invariantes no dependan de que nadie se acuerde:
 *
 * 1. **Todo handler va envuelto en `runTool`**, así que un fallo sale como `isError` —que el modelo
 *    lee y con el que se corrige— y nunca como error de protocolo (§ trampa 5).
 * 2. **`PLANVORTEX_MCP_READ_ONLY` apaga de verdad**: una herramienta de escritura no se registra,
 *    no se registra desactivada. Lo que no está en `tools/list` no se puede llamar.
 * 3. **El orden es el de registro**, y por tanto determinista. La spec 2026-07-28 cachea
 *    `tools/list` con `ttlMs`, y un orden que cambiara entre arranques tiraría esa caché y la del
 *    prompt del modelo en cada conversación.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type * as z from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Context } from "../context.js";
import { runTool } from "../errors.js";

/** Las anotaciones que el cliente MCP pinta. Son lo único que hace que Claude Desktop avise. */
export interface Annotations {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

export interface ToolDefinition<I extends z.ZodType, O extends z.ZodType> {
    name: string;
    title: string;
    description: string;
    inputSchema: I;
    outputSchema?: O;
    annotations: Annotations;
    /** Marca la herramienta como escritura: `PLANVORTEX_MCP_READ_ONLY` la quita del listado. */
    write?: boolean;
    /**
     * Marca la herramienta como GASTO: sólo se registra con `PLANVORTEX_MCP_ALLOW_AI` encendido.
     *
     * Es el inverso de {@link write}, y por eso son dos banderas y no un enum: `write` quita algo
     * que por defecto está, `ai` añade algo que por defecto no. Una herramienta que factura no se
     * enciende sola porque el servidor arranque.
     */
    ai?: boolean;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
    server: McpServer,
    ctx: Context,
    definition: ToolDefinition<I, O>,
    handler: (args: z.infer<I>, ctx: Context) => Promise<CallToolResult>,
): void {
    if (definition.write && ctx.config.readOnly) return;
    //Las dos banderas se cruzan aquí y en ningún otro sitio. Una herramienta `ai` es además
    //`write`, así que `PLANVORTEX_MCP_READ_ONLY` ya la habría quitado arriba: el orden importa,
    //porque un servidor declarado de sólo lectura no publica ni aunque le enciendan la IA.
    if (definition.ai && !ctx.config.allowAiPlans) return;

    server.registerTool(
        definition.name,
        {
            title: definition.title,
            description: definition.description,
            inputSchema: definition.inputSchema,
            ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
            annotations: {
                //Ninguna herramienta de este servidor es destructiva, y se dice en las veinticinco
                //(§ decisión 6): borrar una publicación, una cuenta, un contacto o una integración
                //no es una opción desactivada, es código que no se ha escrito.
                destructiveHint: false,
                ...definition.annotations,
            },
        },
        //El `as` es el precio de tener un registrador genérico: el SDK infiere los argumentos del
        //esquema y aquí el esquema es una variable de tipo.
        (async (args: z.infer<I>) => runTool(() => handler(args, ctx))) as never,
    );
}
