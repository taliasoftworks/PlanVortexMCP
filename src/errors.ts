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
    //Los dos frenos de ritmo van por delante de la familia, y a proposito. Nacieron por encima
    //del 960 —el techo que tenia el rango `publication` cuando las publicaciones eran un cupo—,
    //asi que con una version de `planvortex` anterior llegan SIN familia y caerian en el consejo
    //generico. Y el generico es justo el contrario del bueno: aqui no hay nada que corregir en el
    //post, hay que esperar.
    if (error.code === 978 || error.code === 979 || error.code === 545) {
        return rateAdvice(error);
    }
    switch (error.family) {
        case "publication":
            //900-979, y no todo lo que hay dentro es «arregla el post»: el rango mete también un
            //id que no existe, un post ya enviado y dos topes de plan. Ver {@link publicationAdvice}.
            return publicationAdvice(error);
        case "plan_limit":
            //1300-1408. NO se arregla reintentando, y si no se dice con todas las letras el modelo
            //reintenta tres veces y luego se inventa una explicación.
            return (
                "This is a plan limit, not a transient failure: retrying will fail the same way. " +
                "Do not retry. Call get_plan_use to show what is left, and tell the user their " +
                "PlanVortex plan has to grow for this to work."
            );
        case "auth":
            //El rango 500-544 se llama `auth` por el catálogo del servidor, no porque todo lo que
            //cae dentro sea un problema de credenciales. Ver {@link authAdvice}.
            return authAdvice(error);
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
            //1502 no es un envío fallido: es que esa red NO tiene mensajes directos, y la
            //descubrió la capa 3 llamando a `list_conversations` sobre una cuenta de YouTube. El
            //consejo de la ventana de 24 h ahí no dice nada —no se estaba enviando nada— y manda
            //al modelo a reintentar en un sitio donde no hay nada que reintentar.
            if (error.code === 1502) {
                return (
                    "This social network has no direct messages at all, so there is nothing to " +
                    "read or send here. Do not retry and do not try another contact: call " +
                    "get_social_capabilities to see which of the connected networks do have " +
                    "conversations."
                );
            }
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

/**
 * El rango `publication` (900-979), desglosado por la misma razón que el de `auth` y descubierto
 * igual: la capa 3 pidió las estadísticas de una publicación borrada y el servidor contestó
 * «esto es un problema del post, corrige el texto o los ficheros y vuelve a llamar». No hay texto
 * que corregir cuando el identificador no existe.
 *
 * Tres códigos del rango no se arreglan tocando el post:
 *
 * - **917**: ese id no existe (o está borrado). Se busca otro, no se reescribe nada.
 * - **921**: ya salió. Editar una publicación enviada no es posible en ninguna red.
 * - **926**: el tope por cuenta y mes, que es una red de seguridad y no un cupo de plan: sigue
 *   viviendo en el rango de publicaciones, así que reintentar falla igual por mucho que se
 *   acorte el texto. El **924** que había aquí era el cupo MENSUAL del plan, y el servidor lo
 *   retiró el 02-09-2026 al hacer las publicaciones ilimitadas.
 *
 * Y los dos frenos de ritmo, 978 y 979, ni siquiera llegan hasta aquí: los atiende
 * {@link rateAdvice} antes de mirar la familia.
 */
/**
 * Los TRES frenos de ritmo: los dos de publicación —lo único que puede parar un lote desde que las
 * publicaciones son ilimitadas (02-09-2026)— y el de la API entera, que llegó al abrirla a todos
 * los planes.
 *
 * Y son el caso en que el consejo importa mas que el mensaje: los dos son TRANSITORIOS —esperar los
 * arregla— mientras que todo lo que los rodea en el catalogo no lo es. Un modelo al que se le dice
 * «no reintentes» aqui abandona un lote que habria salido entero diez minutos despues; uno al que
 * no se le dice nada reintenta en bucle y se come el freno una y otra vez.
 */
function rateAdvice(error: PlanVortexError): string {
    if (error.code === 545) {
        //Este es de la CUENTA entera, no de una publicación: llega en cualquier herramienta, y
        //cae en la familia `auth`, cuyo consejo habla de credenciales. Con un token recién
        //emitido pasaría exactamente lo mismo.
        return (
            "This is the plan's API rate limit, and it is TRANSIENT: the credentials are fine and " +
            "asking for a new token changes nothing. Wait the seconds the `Retry-After` header " +
            "says and continue; if it keeps happening, space the calls out or the account needs a " +
            "bigger plan. Do not retry in a loop."
        );
    }
    if (error.code === 979) {
        return (
            "That social network has a daily publishing cap and this account has reached it today. " +
            "This is NOT a plan limit and paying more does not lift it: it is the network's own " +
            "ceiling. Do not retry today. Schedule the rest for tomorrow with publish_post, or use " +
            "an account on another network. Call get_social_limits for the per-network numbers."
        );
    }
    return (
        "Too many publications too fast on this account. This is TRANSIENT and it is not a plan " +
        "limit: publications are unlimited on every plan. Do not rewrite the post and do not retry " +
        "immediately — wait and send the rest spaced out, or schedule them with a publish_date. " +
        "Call get_social_limits for the per-hour and per-network daily caps."
    );
}
function publicationAdvice(error: PlanVortexError): string {
    switch (error.code) {
        case 917:
            return (
                "That publication id does not exist in this organization: it was never created, it " +
                "belongs to another organization or it has been deleted. Do not retry with the same " +
                "id. Call list_publications and take an id from there."
            );
        case 921:
            return (
                "This post has already gone out, and a published post cannot be edited or " +
                "rescheduled through PlanVortex. Do not retry. If the user wants a different text, " +
                "it has to be a new publication."
            );
        case 926:
            return (
                "This is a per-account cap, not a problem with the post: retrying with a shorter " +
                "text or other media will fail the same way. Do not retry. The cap is monthly and " +
                "per account, so either wait for the next month or use a different account. " +
                "Publications themselves are unlimited on every plan: this is not something the " +
                "user fixes by paying more."
            );
        //Lo demás sí es el post: sobran caracteres, la red no admite ese tipo de fichero, falta un
        //título. Lo que hay que cambiar lo dice el propio mensaje del catálogo, que para eso lo
        //escribió alguien.
        default:
            return (
                "This is a problem with the post itself, and the message above says what to change. " +
                "Fix the text, the media or the target network and call the tool again. " +
                "Call get_social_limits if you need the exact per-network limits."
            );
    }
}

/**
 * El rango `auth` (500-544), desglosado, que es lo único de este fichero que no salió de leer el
 * catálogo sino de EJECUTAR la capa 3: un stack con plan `free` contestó 516 a `list_comments` y
 * el servidor lo tradujo por «tus credenciales fueron rechazadas, revisa PLANVORTEX_CLIENT_SECRET».
 * Credenciales impecables, consejo imposible de seguir, y el modelo mandando a una persona a mirar
 * un fichero de configuración que estaba bien.
 *
 * Dentro del rango conviven cuatro cosas que se arreglan de maneras distintas, y sólo la última es
 * la configuración de este servidor:
 *
 * 1. **El plan no llega** (511, 515, 516, 517, 542). Las apps ya no son del plan Custom —la fase 2
 *    las abrió a los cuatro—, pero eso no elimina este caso: lo hace más frecuente. Un cliente en
 *    el plan gratuito tiene credenciales perfectamente válidas y un plan que no incluye lo que se
 *    acaba de pedir, y 542 sigue existiendo para lo que sí exige Custom.
 * 2. **Lo que una app no puede hacer nunca** (512, 519). No hay credencial que lo arregle: hace
 *    falta una persona con sesión (§ trampa 9).
 * 3. **Esa organización no es de esta app** (537).
 * 4. **Le faltan permisos** (520), y hay que decir CUÁLES.
 */
function authAdvice(error: PlanVortexError): string {
    switch (error.code) {
        case 511: //el plan no tiene usuarios suficientes
        case 515: //el plan no incluye conversaciones
        case 516: //la funcionalidad exige plan de pago y el cliente está en `free`
        case 542: //la funcionalidad exige el plan Custom
            return (
                "This is a PlanVortex PLAN limitation, not a credentials problem: the app is " +
                "authenticated and the call is well formed, but the account's plan does not include " +
                "this. Do not retry, and do not tell the user to check the server's credentials. " +
                "Call get_plan_use to show the plan they are on, and tell them it has to grow for " +
                "this to work." +
                (error.code === 542 ? " This one needs the Custom plan specifically." : "")
            );
        //Se parece al anterior y se arregla de otra manera: aquí el plan es el correcto y lo que
        //falla es el cobro. Subir de plan no lo desbloquea.
        case 517:
            return (
                "The PlanVortex account is disabled because of its subscription, not because of " +
                "this server's credentials. Do not retry: a person has to sort out the billing in " +
                "the PlanVortex panel before any of this works."
            );
        case 512: //exige usuario o token temporal: no se puede hacer con una app
        case 519: //exige otro tipo de token
            return (
                "This call cannot be made with an app's credentials at all, and this server only " +
                "has an app: it needs a signed-in person. Do not retry. If the goal was to connect " +
                "a social account, call create_connect_link and give the user the link; otherwise " +
                "tell them this part has to be done by hand in the PlanVortex panel."
            );
        case 537:
            return (
                "This app does not have access to that organization. Call list_organizations and " +
                "use one of the ids it returns; this server only reaches its own organizations."
            );
        case 520: {
            const required = requiredPermissions(error);
            const detail = required.length > 0 ? ` Missing: ${required.join(", ")}.` : "";
            return (
                `The PlanVortex app is authenticated but lacks the permissions for this call.${detail} ` +
                "Do not retry: a person has to grant them to the app in the PlanVortex panel."
            );
        }
        //501 y 522 los arregla la librería sola y no deberían llegar aquí. Lo que queda sí es la
        //configuración de este servidor, y ahí el consejo de siempre es el bueno.
        default:
            return (
                "The credentials of this MCP server were rejected. That is a configuration problem, " +
                "not something the request can fix. Do not retry; tell the user to check the " +
                "PLANVORTEX_CLIENT_ID and PLANVORTEX_CLIENT_SECRET of this server."
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
