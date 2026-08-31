/**
 * De una excepción de `planvortex` a una frase que el MODELO pueda usar para corregirse.
 *
 * TRAMPA 5 DEL ROADMAP, y aquí se juega media calidad del servidor. La librería ya hizo la mitad
 * del camino: convierte el código del catálogo —que siempre llega dentro de un HTTP 400— en una
 * clase (`PlanLimitError`, `PublicationError`, `AccountError`…). Lo que falta es el último salto,
 * que es de otra naturaleza: decidir **qué se hace con esto** y decírselo al modelo en una frase.
 *
 * Las dos formas de fallar de MCP no son intercambiables:
 *
 * - **Error de protocolo** (JSON-RPC `error`): herramienta desconocida, petición malformada. El
 *   modelo no puede arreglarlo y no lo ve como resultado.
 * - **Error de ejecución** (`isError: true` dentro de un resultado correcto): la API falló, la
 *   fecha está mal, el texto se pasa de largo. **Esto sí lo lee el modelo y con esto se corrige.**
 *
 * Todo lo que salga de una herramienta es lo segundo, y por eso {@link runTool} envuelve a las
 * veinticinco: un fallo que escapara se convertiría en error de protocolo y el modelo se quedaría
 * sin nada que leer.
 *
 * Y el error NUNCA es un volcado del JSON. `{"code":907,"message":"...","data":{...}}` en el
 * contexto de un modelo es ruido caro.
 */
import { isPlanVortexError, type PlanVortexError } from "planvortex";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { log } from "./log.js";

/** Un resultado de herramienta que el modelo lee como fallo, no como error de protocolo. */
export function toolError(text: string): CallToolResult {
    return { content: [{ type: "text", text }], isError: true };
}

/** Un resultado normal: el texto que lee el modelo y, opcionalmente, el JSON que valida. */
export function toolOk(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
    return structuredContent === undefined
        ? { content: [{ type: "text", text }] }
        : { content: [{ type: "text", text }], structuredContent };
}

/**
 * Un error de la herramienta que no viene de la API: una validación nuestra, una fecha imposible,
 * una organización que no se puede resolver. Se distingue de los de `planvortex` para no
 * inventarle un código del catálogo que no tiene.
 */
export class ToolInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ToolInputError";
    }
}

/**
 * El envoltorio de TODAS las herramientas. Nada sale de aquí como excepción.
 */
export async function runTool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
    try {
        return await fn();
    } catch (error) {
        //Al log entero (por `stderr`), al modelo sólo la frase útil.
        log.warn("la herramienta falló", { error: error instanceof Error ? error.message : error });
        return toolError(explainError(error));
    }
}

/**
 * La frase que lee el modelo. Una línea de qué pasó y una de qué hacer, en inglés porque es lo que
 * el modelo razona y porque la API pública ya está en inglés (§ decisión 8).
 */
export function explainError(error: unknown): string {
    if (error instanceof ToolInputError) {
        return error.message;
    }
    if (!isPlanVortexError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        return `The request failed before reaching PlanVortex: ${message}`;
    }
    return `${headline(error)} ${advice(error)}`.trim();
}

function headline(error: PlanVortexError): string {
    //El código va delante y entre corchetes: es lo que un humano busca en la documentación cuando
    //el modelo le enseña esta frase, y no cuesta casi nada de contexto.
    return error.code > 0 ? `[PlanVortex error ${error.code}] ${error.message}.` : `${error.message}.`;
}

function advice(error: PlanVortexError): string {
    switch (error.family) {
        case "publication":
            //900-960. Casi siempre corregible: sobran caracteres, la red no admite ese tipo de
            //fichero, falta un título. Lo que hay que cambiar lo dice el propio mensaje del
            //catálogo, que para eso los escribió alguien.
            return (
                "This is a problem with the post itself, and the message above says what to change. " +
                "Fix the text, the media or the target network and call the tool again. " +
                "Call get_social_limits if you need the exact per-network limits."
            );
        case "plan_limit":
            //1300-1408. NO se arregla reintentando, y si no se dice con todas las letras el modelo
            //reintenta tres veces y luego se inventa una explicación.
            return (
                "This is a plan limit, not a transient failure: retrying will fail the same way. " +
                "Do not retry. Call get_plan_use to show what is left, and tell the user their " +
                "PlanVortex plan has to grow for this to work."
            );
        case "auth":
            //501 y 522 los arregla la librería sola y no deberían llegar aquí. El 520 sí llega, y
            //significa que a la app le faltan permisos: hay que decir CUÁLES.
            if (error.code === 520) {
                const required = requiredPermissions(error);
                const detail = required.length > 0 ? ` Missing: ${required.join(", ")}.` : "";
                return (
                    `The PlanVortex app is authenticated but lacks the permissions for this call.${detail} ` +
                    "Do not retry: a person has to grant them to the app in the PlanVortex panel."
                );
            }
            return (
                "The credentials of this MCP server were rejected. That is a configuration problem, " +
                "not something the request can fix. Do not retry; tell the user to check the " +
                "PLANVORTEX_CLIENT_ID and PLANVORTEX_CLIENT_SECRET of this server."
            );
        case "account":
            //700-715. La cuenta social está en error, y reconectarla es un OAuth con una persona
            //delante: el modelo no puede hacerlo (§ trampa 9).
            return (
                "The connected social account is not usable right now. Call list_accounts to see " +
                "its error state. Reconnecting an account needs a person: use create_connect_link " +
                "and give the user the link."
            );
        case "file":
            return (
                "The file was rejected. Check the format and the size against get_social_limits, " +
                "then upload it again with upload_media."
            );
        case "messaging":
            //1500-1512. El error que se comete siempre: la ventana de 24 h de Meta.
            return (
                "The message was not sent. On Facebook, Instagram and WhatsApp a free-form message " +
                "is only allowed inside the 24-hour window since the contact last wrote; outside " +
                "it, WhatsApp needs an approved template. Retrying the same message will not help."
            );
        case "organization":
            return (
                "Check the organization id: call list_organizations and use one of the ids it " +
                "returns. This app only reaches its own organizations."
            );
        case "integration":
            return (
                "The integration is not usable. Connecting or repairing one needs a person in the " +
                "PlanVortex panel; this server cannot do it."
            );
        case "connection":
        case "http":
            return "This looks transient. One retry is reasonable; more than one is not.";
        default:
            return (
                "Read the message above before retrying: most of these are not fixed by repeating " +
                "the same call."
            );
    }
}

/** Los permisos que el 520 adjunta en su `data` (`{permissions, client_permissions}`). */
function requiredPermissions(error: PlanVortexError): string[] {
    const out: string[] = [];
    for (const key of ["permissions", "client_permissions"]) {
        const value = error.data[key];
        if (Array.isArray(value)) out.push(...value.map((item) => String(item)));
        else if (typeof value === "string" && value) out.push(value);
    }
    return out;
}
