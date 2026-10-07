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
 * Todo lo que salga de una herramienta es lo segundo, y por eso {@link runTool} envuelve a
 * todas: un fallo que escapara se convertiría en error de protocolo y el modelo se quedaría
 * sin nada que leer.
 *
 * Y el error NUNCA es un volcado del JSON. `{"code":907,"message":"...","data":{...}}` en el
 * contexto de un modelo es ruido caro.
 */
import { isPlanVortexError, type PlanVortexError } from "planvortex";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { TransportMode } from "./config.js";
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
 *
 * El modo entra porque cambia a quién se le habla: en stdio y `--http` hay una app detrás, en
 * modo alojado una persona (ver {@link explainError}).
 */
export async function runTool(
    fn: () => Promise<CallToolResult>,
    mode: TransportMode = "stdio",
): Promise<CallToolResult> {
    try {
        return await fn();
    } catch (error) {
        //Al log entero (por `stderr`), al modelo sólo la frase útil.
        log.warn("la herramienta falló", { error: error instanceof Error ? error.message : error });
        return toolError(explainError(error, mode));
    }
}

/**
 * La frase que lee el modelo. Una línea de qué pasó y una de qué hacer, en inglés porque es lo que
 * el modelo razona y porque la API pública ya está en inglés (§ decisión 8).
 *
 * En modo alojado no hay app ni fichero de configuración que revisar: quien llama es una persona
 * que inició sesión, y sus permisos son sus roles. Los consejos que hablan de «la app» o de
 * `PLANVORTEX_CLIENT_SECRET` serían falsos ahí, y se cambian por los suyos.
 */
export function explainError(error: unknown, mode: TransportMode = "stdio"): string {
    if (error instanceof ToolInputError) {
        return error.message;
    }
    if (!isPlanVortexError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        return `The request failed before reaching PlanVortex: ${message}`;
    }
    return `${headline(error)} ${advice(error, mode === "hosted")}`.trim();
}

function headline(error: PlanVortexError): string {
    //El código va delante y entre corchetes: es lo que un humano busca en la documentación cuando
    //el modelo le enseña esta frase, y no cuesta casi nada de contexto.
    return error.code > 0 ? `[PlanVortex error ${error.code}] ${error.message}.` : `${error.message}.`;
}

function advice(error: PlanVortexError, asUser: boolean): string {
    //Los frenos de ritmo van por delante de la familia, y a proposito. Nacieron por encima del
    //960 —el techo que tenia el rango `publication` cuando las publicaciones eran un cupo—, asi
    //que con una version de `planvortex` anterior llegan SIN familia y caerian en el consejo
    //generico. Y el generico es justo el contrario del bueno: aqui no hay nada que corregir en el
    //post, hay que esperar. El 984 es el mismo caso una red mas tarde: es el 429 de Slack con la
    //ventana de reintentos agotada, y cae en `publication` desde que el rango llega al 986.
    //El 991 es el de Pinterest: la red frena a la APLICACION de PlanVortex, que comparten todos los
    //clientes, y llega como 429 con `Retry-After`.
    if (
        error.code === 978 ||
        error.code === 979 ||
        error.code === 545 ||
        error.code === 984 ||
        error.code === 991
    ) {
        return rateAdvice(error);
    }
    //Los dos «aquí no hay comentarios», también por código. El 2600 nació fuera de todo rango
    //—con `planvortex` 0.14 llega SIN familia—, y el 945 cae en `publication`, cuyo consejo por
    //defecto es «corrige el post»: en una bandeja eso no significa nada y manda a reescribir.
    if (error.code === 945 || error.code === 2600) {
        return noCommentsAdvice(error);
    }
    switch (error.family) {
        case "publication":
            //900-996, y no todo lo que hay dentro es «arregla el post»: el rango mete también un
            //id que no existe, un post ya enviado, un tope de cuenta y los dos de Slack que
            //necesitan a una persona. Ver {@link publicationAdvice}.
            return publicationAdvice(error, asUser);
        case "plan_limit":
            //1300-1408. NO se arregla reintentando, y si no se dice con todas las letras el modelo
            //reintenta tres veces y luego se inventa una explicación. Y se EXPLICA, no se vende
            //(trampa 12 de chatgpt.md): las dos revisiones rechazan un servidor que empuja a pagar.
            return (
                "This is a plan limit, not a transient failure: retrying will fail the same way. " +
                "Do not retry. Call get_plan_use to show the user what their PlanVortex plan " +
                "includes and how much of it is in use, and explain that this goes beyond it."
            );
        case "auth":
            //El rango 500-544 se llama `auth` por el catálogo del servidor, no porque todo lo que
            //cae dentro sea un problema de credenciales. Ver {@link authAdvice}.
            return authAdvice(error, asUser);
        case "account":
            //700-715. La cuenta social está en error, y reconectarla es un OAuth con una persona
            //delante: el modelo no puede hacerlo (§ trampa 9).
            return (
                "The connected social account is not usable right now. Call list_accounts to see " +
                `its error state. ${reconnectAdvice(asUser)}`
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
                (asUser
                    ? "returns. This user only reaches the organizations they have a role in."
                    : "returns. This app only reaches its own organizations.")
            );
        case "integration":
            return integrationAdvice(error);
        case "ai_plan":
            return aiPlanAdvice(error);
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
 * El rango `publication` (900-996), desglosado por la misma razón que el de `auth` y descubierto
 * igual: la capa 3 pidió las estadísticas de una publicación borrada y el servidor contestó
 * «esto es un problema del post, corrige el texto o los ficheros y vuelve a llamar». No hay texto
 * que corregir cuando el identificador no existe.
 *
 * Tres códigos del rango no se arreglan tocando el post:
 *
 * - **917**: ese id no existe (o está borrado). Se busca otro, no se reescribe nada.
 * - **921**: ya salió. Editar una publicación enviada no es posible en ninguna red. O todavía no:
 *   la red está procesando su vídeo (`data.state` = `publishing`), y entonces se espera.
 * - **926**: el tope por cuenta y mes, que es una red de seguridad y no un cupo de plan: sigue
 *   viviendo en el rango de publicaciones, así que reintentar falla igual por mucho que se
 *   acorte el texto. El **924** que había aquí era el cupo MENSUAL del plan, y el servidor lo
 *   retiró el 02-09-2026 al hacer las publicaciones ilimitadas.
 *
 * Y los frenos de ritmo, 978, 979 y 984, ni siquiera llegan hasta aquí: los atiende
 * {@link rateAdvice} antes de mirar la familia.
 */
/**
 * Los CUATRO frenos de ritmo: los dos de publicación —lo único que puede parar un lote desde que
 * las publicaciones son ilimitadas (02-09-2026)—, el de la API entera, que llegó al abrirla a todos
 * los planes, y el 429 de Slack (984), que es por método y por workspace.
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
            "says and continue, and if it keeps happening, space the calls out. Do not retry in " +
            "a loop."
        );
    }
    if (error.code === 984) {
        return (
            "Slack is rate limiting this workspace and the retry window ran out. This is TRANSIENT " +
            "and it has nothing to do with the post: Slack counts per method and per workspace, so " +
            "another channel of the same workspace will hit it too. Do not rewrite anything and do " +
            "not retry immediately — wait a minute and send the rest spaced out, or schedule them " +
            "with a publish_date."
        );
    }
    if (error.code === 991) {
        return (
            "Pinterest is rate limiting PlanVortex's application. This is TRANSIENT and it has " +
            "nothing to do with the post or the account: do not rewrite anything. Wait the seconds " +
            "the Retry-After header says before the next Pinterest call, and schedule the rest " +
            "with a publish_date instead of sending them in a burst."
        );
    }
    if (error.code === 979) {
        return (
            "That social network has a daily publishing cap and this account has reached it today. " +
            "This is NOT a plan limit and paying more does not lift it: it is the network's own " +
            "ceiling. Do not retry today. Schedule the rest for tomorrow with create_publication, or use " +
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
/**
 * No hay comentarios que leer ni a los que responder: ni es transitorio ni hay nada que corregir.
 *
 * - **945**: la RED no tiene comentarios en PlanVortex (TikTok, WhatsApp, Slack, Pinterest).
 * - **2600**: la red sí, pero ESTA CUENTA no. Hoy sólo un perfil personal de LinkedIn: LinkedIn no
 *   deja a ninguna app leer los comentarios de un perfil, sólo los de una página. El consejo útil
 *   es mandar a las páginas, porque quien pregunta por «los comentarios de LinkedIn» casi siempre
 *   tiene alguna conectada.
 */
function noCommentsAdvice(error: PlanVortexError): string {
    if (error.code === 2600) {
        return (
            "This account has no comment inbox: it is a LinkedIn personal profile, and LinkedIn does " +
            "not let any app read the comments on a profile, only on a page. It is not a temporary " +
            "failure and nothing in the request is wrong, so do not retry, here or with other posts of " +
            "this account. Call list_accounts: the LinkedIn accounts without personal_profile are " +
            "pages, and those do have comments."
        );
    }
    return (
        "This social network has no comments in PlanVortex, so there is nothing to read or reply to " +
        "here. Do not retry. Call get_social_capabilities to see which connected networks have " +
        "comments."
    );
}

function publicationAdvice(error: PlanVortexError, asUser: boolean): string {
    switch (error.code) {
        case 917:
            return (
                "That publication id does not exist in this organization: it was never created, it " +
                "belongs to another organization or it has been deleted. Do not retry with the same " +
                "id. Call list_publications and take an id from there."
            );
        case 921:
            //El mismo código para dos cosas opuestas: ya salió, o la red aún está procesando el
            //vídeo (el reel de Instagram que tarda, `data.state` = `publishing`). En la segunda,
            //el consejo de la primera —«hazla nueva»— publica el vídeo dos veces.
            if (error.data["state"] === "publishing") {
                return (
                    "This post has NOT failed: the network is still processing its video, and " +
                    "PlanVortex will publish it by itself within a few minutes. It cannot be edited " +
                    "meanwhile. Do not retry it and do not create it again: either would publish the " +
                    "video twice. Check it with get_publication; if it ends in withErrors, it can be " +
                    "edited then."
                );
            }
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
        //SLACK. Los dos que no se arreglan tocando el post, y el 980 es el error mas comun de esa
        //red entera: la app no esta en el canal. Reintentar con otro texto falla igual, y lo que
        //desbloquea es que una PERSONA escriba un comando dentro de Slack.
        case 980:
            return (
                "The PlanVortex app is not in that Slack channel, and nothing about the post is " +
                "wrong: retrying with different text or media will fail exactly the same way. Do " +
                "not retry. Somebody with access to that channel has to type `/invite @PlanVortex` " +
                "inside it — on a private channel that is the only way, because Slack has no API " +
                "for an app to join one. Tell the user that, then publish again."
            );
        case 985:
            return (
                "That Slack channel is archived or no longer exists, so nothing can be published " +
                "to it. Do not retry: this does not fix itself. Either somebody unarchives the " +
                "channel in Slack, or the account is reconnected to a different one. Call " +
                "list_accounts to pick another."
            );
        //PINTEREST. Los tres del tablero, que no se arreglan con otro texto: el 987 es el más común
        //de la red y casi siempre es que el modelo no sabía que hay tableros.
        case 987:
            return (
                "A Pinterest pin has to go to a board and this one has none, or the id given is not " +
                "a board id (a board's NAME does not work). Call list_destinations with the " +
                "account, ask the user which board, and pass its id as destination_id — with " +
                "update_publication if the post already exists."
            );
        case 992:
            return (
                "This network has no destinations: the account itself is where the post goes. " +
                "Remove destination_id and call again."
            );
        case 993:
            return (
                "That board is not in this account: it was deleted, or it belongs to another " +
                "profile. Call list_destinations and take an id from there."
            );
        case 988:
            return (
                "That Pinterest account is a personal one, and Pinterest only gives analytics to " +
                "business accounts. Nothing about a post fixes it: the user has to switch the " +
                `account to a business account on Pinterest and reconnect it. ${reconnectAdvice(asUser)}`
            );
        //Lo demás sí es el post: sobran caracteres, la red no admite ese tipo de fichero, falta un
        //título, el fichero pesa demasiado para Slack (983) o la subida se cayó (986). Lo que hay
        //que cambiar lo dice el propio mensaje del catálogo, que para eso lo escribió alguien.
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
function authAdvice(error: PlanVortexError, asUser: boolean): string {
    if (asUser) {
        const hosted = hostedAuthAdvice(error);
        if (hosted !== undefined) return hosted;
    }
    switch (error.code) {
        case 511: //el plan no tiene usuarios suficientes
        case 515: //el plan no incluye conversaciones
        case 516: //la funcionalidad exige plan de pago y el cliente está en `free`
        case 542: //la funcionalidad exige el plan Custom
            return (
                `This is a PlanVortex PLAN limitation, not a credentials problem: the ${asUser ? "user" : "app"} is ` +
                "authenticated and the call is well formed, but the account's plan does not include " +
                "this. Do not retry" +
                (asUser ? "" : ", and do not tell the user to check the server's credentials") +
                ". Explain to the user that this feature is not part of their current plan; " +
                "get_plan_use shows what it does include." +
                (error.code === 542 ? " This one is only part of the Custom plan." : "")
            );
        //Se parece al anterior y se arregla de otra manera: aquí el plan es el correcto y lo que
        //falla es el cobro. Subir de plan no lo desbloquea.
        case 517:
            return (
                "The PlanVortex account is disabled because of its subscription, not because of " +
                "the credentials or the sign-in. Do not retry: a person has to sort out the billing " +
                "in the PlanVortex panel before any of this works."
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

/**
 * Los del rango `auth` que cambian cuando detrás hay una PERSONA (modo alojado). `undefined` para
 * los que se explican igual —los de plan y el de la suscripción—, que siguen su camino de siempre.
 *
 * - **520**: no le faltan permisos a una app, le faltan a ella. Los da quien administra esa
 *   organización, con un rol.
 * - **537** no llega nunca (es de apps), pero si llegara su frase hablaría de «esta app».
 * - **El resto** (501, 522 y compañía) es que la API rechazó el token de esta conexión. No hay
 *   variables que mirar: se arregla volviendo a conectar PlanVortex en el asistente.
 */
function hostedAuthAdvice(error: PlanVortexError): string | undefined {
    switch (error.code) {
        case 511:
        case 515:
        case 516:
        case 517:
        case 542:
            return undefined;
        case 512:
        case 519:
            return (
                "This part of PlanVortex cannot be used through an assistant. Do not retry: tell the " +
                "user it has to be done by hand in the PlanVortex panel."
            );
        case 520: {
            const required = requiredPermissions(error);
            const detail = required.length > 0 ? ` Missing: ${required.join(", ")}.` : "";
            return (
                `This PlanVortex user is signed in but their role does not allow this call.${detail} ` +
                "Do not retry: someone who administers that organization has to give them a role " +
                "with those permissions in the PlanVortex panel."
            );
        }
        case 537:
            return (
                "This user does not have access to that organization. Call list_organizations and " +
                "use one of the ids it returns."
            );
        default:
            return (
                "PlanVortex did not accept this connection's sign-in. That is not something the " +
                "request can fix. Do not retry; tell the user to disconnect PlanVortex in their " +
                "assistant and connect it again."
            );
    }
}

/**
 * El rango `integration` (2200-2299), desglosado desde que una tienda es una integración: el consejo
 * de siempre —«hace falta una persona en el panel»— es el bueno para una clave que la tienda ya no
 * acepta, y el malo para un cortafuegos delante de ella (no lo arregla ninguna reconexión) o para una
 * tienda recién conectada que se está comprobando (lo arregla esperar cinco segundos).
 */
function integrationAdvice(error: PlanVortexError): string {
    switch (error.code) {
        case 2200:
            return (
                "That integration does not exist in this organization. Call list_store_products " +
                "without id_integration to get the ids of its connected shops."
            );
        case 2207:
            return (
                "That integration has no product catalogue: it is a Google Drive or a feed, not a " +
                "shop. Call list_store_products without id_integration to see which ones are shops."
            );
        case 2208:
            return (
                "The shop's catalogue could not be read. If a cursor was passed, it has to be exactly " +
                "the next_cursor of the previous page; otherwise one retry is reasonable, not a loop."
            );
        case 2209:
            return (
                "That shop is disabled in PlanVortex, so it cannot be read. A person has to enable it " +
                "in the PlanVortex panel, under Integrations; this server cannot."
            );
        case 2211:
            return (
                "The shop rejected PlanVortex's key: it was deleted or changed in the shop's own " +
                "WordPress. Do not retry. A person has to reconnect the shop in the PlanVortex panel."
            );
        case 2212:
            return (
                "A firewall or a security plugin in front of the shop blocked PlanVortex's server. It " +
                "is not the key and not the request, so retrying or reconnecting will not help: the " +
                "shop's hosting has to let PlanVortex's server through. Tell the user exactly that."
            );
        case 2213:
            return (
                "The shop did not answer, or failed on its side. That is the shop's hosting and it may " +
                "be transient: one retry in a while is reasonable, a loop is not."
            );
        case 2219:
            return (
                "The shop was connected moments ago and its key is still being checked. Wait a few " +
                "seconds and call again; if it lasts, a person has to reconnect it in the panel."
            );
        default:
            return (
                "The integration is not usable. Connecting or repairing one needs a person in the " +
                "PlanVortex panel; this server cannot do it."
            );
    }
}

/**
 * El rango `ai_plan` (2100-2199). El único que se desglosa es el 2120, porque es el único que el
 * modelo arregla solo y sin preguntar a nadie: quitar del plan las cuentas que la plantilla no admite.
 * El servidor las dice TODAS en `data.accounts`, y se le pasan tal cual.
 */
function aiPlanAdvice(error: PlanVortexError): string {
    if (error.code === 2120) {
        const accounts = Array.isArray(error.data["accounts"]) ? (error.data["accounts"] as unknown[]) : [];
        const listed = accounts
            .map((account) => {
                const row = account as { _id?: unknown; social_network?: unknown };
                return row._id ? `${String(row._id)} (${String(row.social_network ?? "?")})` : "";
            })
            .filter(Boolean);
        return (
            "Nothing was charged. That template cannot publish to some of the accounts" +
            (listed.length > 0 ? `: ${listed.join(", ")}` : "") +
            ". Remove them from accounts and call again, or pick another template; " +
            "get_planner_templates lists each template's unsupported_networks."
        );
    }
    return (
        "Read the message above before retrying: most of these are not fixed by repeating " + "the same call."
    );
}

/**
 * Quién reconecta una cuenta social y dónde. Con una app hay herramienta para darle el enlace a la
 * persona; en modo alojado no la hay (el enlace sólo se emite a una app, ver `create_connect_link`),
 * y mandar al modelo a una herramienta que no está en su listado es mandarlo a inventársela.
 */
function reconnectAdvice(asUser: boolean): string {
    return asUser
        ? "Reconnecting an account needs a person: the user does it in the PlanVortex panel, on " +
              "the Accounts page, where the network asks them to authorize."
        : "Reconnecting an account needs a person: use create_connect_link and give the user the link.";
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
