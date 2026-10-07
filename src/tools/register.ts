/**
 * El registrador común de todas las herramientas.
 *
 * Existe para que cinco invariantes no dependan de que nadie se acuerde:
 *
 * 1. **Todo handler va envuelto en `runTool`**, así que un fallo sale como `isError` —que el modelo
 *    lee y con el que se corrige— y nunca como error de protocolo (§ trampa 5).
 * 2. **`PLANVORTEX_MCP_READ_ONLY` apaga de verdad**: una herramienta de escritura no se registra,
 *    no se registra desactivada. Lo que no está en `tools/list` no se puede llamar. Y «de
 *    escritura» es `readOnlyHint: false`, no una bandera aparte que pudiera decir otra cosa.
 * 3. **El orden es el de registro**, y por tanto determinista. La spec 2026-07-28 cachea
 *    `tools/list` con `ttlMs`, y un orden que cambiara entre arranques tiraría esa caché y la del
 *    prompt del modelo en cada conversación.
 * 4. **Ningún esquema de entrada admite claves desconocidas** (§ trampa 16). Un `z.object` las
 *    descarta en silencio, y una clave mal escrita donde iba el id de la organización no da error:
 *    contesta por OTRA organización, con cara de acierto.
 * 5. **Si la organización no vino en la llamada, la respuesta dice cuál se usó** (§ trampa 16). Es
 *    la red de seguridad de la 4: un id por defecto es correcto, pero invisible.
 */
import { ZodObject, strictObject } from "zod";
import { isPlanVortexError } from "planvortex";
import type { McpServer } from "@modelcontextprotocol/server";
import type * as z from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { TransportMode } from "../config.js";
import type { Context } from "../context.js";
import { runTool } from "../errors.js";

/**
 * Las anotaciones que el cliente MCP pinta, y lo que miran las dos revisiones (fase 3 de
 * `chatgpt.md`, trampa 11). Claude decide con ellas qué pide confirmación —una destructiva, siempre;
 * una de lectura, nunca— y OpenAI exige los tres booleanos explícitos en todas y los compara con lo
 * que la herramienta hace de verdad.
 *
 * Por eso son dos formas y no una con todo opcional:
 *
 * - **Una de lectura no declara `destructiveHint`**: es `false` por definición, y lo pone
 *   {@link defineTool}. Así no hay forma de escribir una lectura destructiva.
 * - **Una escritura TIENE que decirlo**, sin valor por defecto. El `false` global que había aquí
 *   (§ decisión 6: no hay borrados) era la definición de «destructivo» de este servidor, no la de
 *   las revisiones: para las dos, publicar o mandar un mensaje lo es, porque no se puede deshacer.
 *   Cada herramienta nueva de escritura tiene que pensarlo, y el compilador lo obliga.
 *
 * Y `readOnlyHint` es además lo que decide si la herramienta es de escritura: con
 * `PLANVORTEX_MCP_READ_ONLY` (o sin `planvortex:write` en modo alojado) se quitan las que lo tienen
 * a `false`. Una bandera aparte podía decir otra cosa, y una escritura que se olvidara de ella se
 * quedaba listada en una conexión de sólo lectura.
 */
export type Annotations =
    | { readOnlyHint: true; openWorldHint: boolean; idempotentHint?: boolean }
    | { readOnlyHint: false; destructiveHint: boolean; openWorldHint: boolean; idempotentHint?: boolean };

export interface ToolDefinition<I extends z.ZodType, O extends z.ZodType> {
    name: string;
    title: string;
    description: string;
    inputSchema: I;
    outputSchema?: O;
    annotations: Annotations;
    /**
     * Marca la herramienta como GASTO: sólo se registra con `PLANVORTEX_MCP_ALLOW_AI` encendido.
     *
     * Es el inverso de la escritura, y por eso no sale de las anotaciones: la escritura quita algo
     * que por defecto está, `ai` añade algo que por defecto no. Una herramienta que factura no se
     * enciende sola porque el servidor arranque.
     */
    ai?: boolean;
    /**
     * Sólo en estos modos. Por defecto, en todos. Existe para lo que en un modo no puede funcionar
     * nunca: una herramienta que siempre contesta «aquí no se puede» es una que la revisión llama
     * con parámetros válidos y ve fallar (fase 3 de `chatgpt.md`).
     */
    modes?: readonly TransportMode[];
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
    server: McpServer,
    ctx: Context,
    definition: ToolDefinition<I, O>,
    handler: (args: z.infer<I>, ctx: Context) => Promise<CallToolResult>,
): void {
    if (definition.modes !== undefined && !definition.modes.includes(ctx.config.mode)) return;
    const annotations = definition.annotations;
    if (!annotations.readOnlyHint && ctx.config.readOnly) return;
    //Las dos banderas se cruzan aquí y en ningún otro sitio. Una herramienta `ai` es además de
    //escritura, así que `PLANVORTEX_MCP_READ_ONLY` ya la habría quitado arriba: el orden importa,
    //porque un servidor declarado de sólo lectura no publica ni aunque le enciendan la IA.
    if (definition.ai && !ctx.config.allowAiPlans) return;

    server.registerTool(
        definition.name,
        {
            title: definition.title,
            description: definition.description,
            inputSchema: strictInput(definition.inputSchema),
            ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
            //Los tres booleanos SIEMPRE, explícitos, en este orden. Y el título también aquí: la
            //spec lo puso arriba en 2025-06-18, pero un cliente o un escáner anterior sólo lo busca
            //en las anotaciones, y Claude exige que cada herramienta lo tenga.
            annotations: {
                title: definition.title,
                readOnlyHint: annotations.readOnlyHint,
                destructiveHint: annotations.readOnlyHint ? false : annotations.destructiveHint,
                ...(annotations.idempotentHint === undefined
                    ? {}
                    : { idempotentHint: annotations.idempotentHint }),
                openWorldHint: annotations.openWorldHint,
            },
        },
        //El `as` es el precio de tener un registrador genérico: el SDK infiere los argumentos del
        //esquema y aquí el esquema es una variable de tipo.
        (async (args: z.infer<I>) => {
            //El contexto de ESTA llamada, para saber si la organización salió del entorno en vez
            //de venir en los argumentos. Una bandera en el `ctx` compartido valdría hasta el día
            //que un cliente mande dos llamadas a la vez: entonces la nota de una saldría pegada a
            //la respuesta de la otra, afirmando una organización que no es. `Object.create`
            //y no `{...ctx}` porque `pv` es un getter perezoso y extenderlo lo despertaría.
            let defaulted: string | undefined;
            const scoped = Object.create(ctx, {
                resolveOrganization: {
                    value: async (explicit?: string | undefined): Promise<string> => {
                        const id = await ctx.resolveOrganization(explicit);
                        if (explicit === undefined) defaulted = id;
                        return id;
                    },
                },
            }) as Context;

            //Se mide aquí porque es el único sitio por el que pasan todas. El error se mira antes
            //de que `runTool` lo convierta en texto: el código de PlanVortex va al log como número,
            //no rescatado de una frase pensada para el modelo.
            const started = performance.now();
            let failure: unknown;
            const result = await runTool(async () => {
                try {
                    return await handler(args, scoped);
                } catch (error) {
                    failure = error;
                    throw error;
                }
            }, ctx.config.mode);
            ctx.observeTool?.({
                tool: definition.name,
                ok: result.isError !== true,
                ...(isPlanVortexError(failure) && failure.code > 0 ? { code: failure.code } : {}),
                ms: Math.round(performance.now() - started),
            });
            return withOrganizationNote(ctx, result, defaulted);
        }) as never,
    );
}

/**
 * El esquema de entrada, cerrado a claves desconocidas.
 *
 * `z.object` las descarta sin decir nada, y eso convierte un `organization_id` mal escrito —donde
 * iba `id_organization`— en una llamada que se resuelve por el valor por defecto y contesta por
 * otra organización. El modelo no tiene forma de notarlo: la respuesta es perfectamente coherente.
 *
 * Cerrarlo aquí y no en cada herramienta hace que la regla valga también para la próxima. Y el
 * esquema publicado sale con `additionalProperties: false`, así que el cliente también lo ve.
 */
function strictInput<I extends z.ZodType>(schema: I): I {
    //`z.strictObject(shape)` en vez de `.strict()`, que está deprecado en zod 4. Un esquema que no
    //sea un objeto llano (uno con `.refine`, por ejemplo) se queda como está, y quien lo escriba se
    //encontrará con el test que recorre `tools/list` exigiendo `additionalProperties: false`.
    return schema instanceof ZodObject ? (strictObject(schema.shape) as unknown as I) : schema;
}

/**
 * Añade, cuando la organización no vino en los argumentos, una línea diciendo por cuál se ha
 * contestado.
 *
 * Sólo pasa cuando el valor sale de `PLANVORTEX_ORGANIZATION_ID`: con una sola organización no hay
 * ambigüedad que avisar, y con varias y sin entorno `resolveOrganization` ya pide el id en vez de
 * elegir. O sea que esta nota cubre exactamente el caso en el que un id por defecto es correcto e
 * invisible a la vez. Se mira la configuración y no se pregunta a la API: una nota informativa no
 * puede añadir ni una llamada ni una forma nueva de fallar.
 */
function withOrganizationNote(
    ctx: Context,
    result: CallToolResult,
    defaulted: string | undefined,
): CallToolResult {
    if (defaulted === undefined || ctx.config.organizationId === undefined) return result;
    //Sobre un error la nota es ruido: lo que el modelo tiene que leer es por qué falló.
    if (result.isError === true) return result;

    const note =
        `Organization: ${defaulted}. It was not given in the arguments, so the default from the ` +
        "server configuration was used; pass id_organization to ask about a different one.";
    return { ...result, content: [...result.content, { type: "text", text: note }] };
}
