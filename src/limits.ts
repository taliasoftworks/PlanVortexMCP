/**
 * La validación previa de una publicación, **antes** de tocar la API.
 *
 * TRAMPA 13 DEL ROADMAP, que es más sutil de lo que parece. Los catálogos son datos estáticos y
 * cacheables: son un `resource` de libro. Pero **muchos clientes MCP no leen los resources por su
 * cuenta** — los ofrecen para que el *usuario* los adjunte a mano. Si la validación de «¿caben
 * estos caracteres en LinkedIn?» depende de que alguien adjunte un resource, no ocurre nunca.
 *
 * Por eso los límites viven en TRES sitios a la vez, y no es duplicación: el `resource` (para quien
 * lo lea), la herramienta `get_social_limits` (para que el modelo pueda preguntarlo) y **esto**,
 * que es la única de las tres que no se puede saltar.
 *
 * Y valida aquí y no allí por una razón de calidad, no de rendimiento: un error nuestro es
 * inmediato y explica qué cambiar; un 907 del servidor es un viaje de ida y vuelta para decir lo
 * mismo peor.
 *
 * Los números salen de `CONSTANT.SOCIAL_LIMITS` del servidor, leídos por la librería. Nunca se
 * copian aquí: quien valida un límite es quien tiene derecho a anunciarlo, y PlanVortexWeb ya
 * demostró lo que pasa cuando cada uno guarda su copia — el compositor contaba LinkedIn hasta 3.000
 * mientras `validateCharacters` rechazaba en 1.300.
 */
import type { SocialCapabilities, SocialLimits } from "planvortex";

export interface LimitProblem {
    /** La frase que lee el modelo, con el número exacto que sobra. */
    message: string;
}

/**
 * Cuenta el texto en las DOS unidades que hacen falta, que no son intercambiables.
 *
 * TRAMPA DE BLUESKY, heredada del servidor: su texto tiene 300 *grafemas* **y** 3.000 *bytes*, y
 * `.length` miente en las dos direcciones. Un emoji de familia son 11 unidades UTF-16, **un**
 * grafema y **25 bytes**: 121 de ellos caben de sobra en 300 grafemas y se pasan de 3.000 bytes.
 * Por eso se cuenta con `Intl.Segmenter` y con `Buffer.byteLength`, y por eso el servidor publica
 * los dos números (`characters.bluesky` y `max_post_bytes.bluesky`).
 */
export function countText(text: string): { graphemes: number; bytes: number } {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    //Se recorre el iterador en vez de materializarlo: `[...segment(text)]` construiría un array
    //entero con cada grafema sólo para preguntarle la longitud.
    const iterator = segmenter.segment(text)[Symbol.iterator]();
    let graphemes = 0;
    while (!iterator.next().done) graphemes += 1;
    return { graphemes, bytes: Buffer.byteLength(text, "utf8") };
}

/**
 * Todo lo que se puede saber sin llamar a nadie. Devuelve la lista de problemas: si está vacía, la
 * publicación puede irse a la API.
 */
export function validatePublication(
    limits: SocialLimits,
    input: {
        social_network: string;
        text?: string | undefined;
        title?: string | undefined;
        files?: readonly string[] | undefined;
    },
): LimitProblem[] {
    const network = input.social_network;
    const problems: LimitProblem[] = [];
    const text = input.text ?? "";
    const { graphemes, bytes } = countText(text);

    //PINTEREST no cuenta en grafemas, y en ninguno de sus dos campos (medido contra la API, fase 5
    //de su roadmap): la descripción en unidades UTF-16 —acepta 800 puntos de código pero GUARDA
    //sólo las 800 primeras unidades, sin avisar— y el título en puntos de código. Los grafemas son
    //siempre los MENOS de las tres cuentas, así que con ellos este fichero dejaba pasar lo que el
    //servidor rechaza con el 995: la familia de cuatro es 1 grafema, 7 puntos y 11 unidades.
    const pinterest = network === "pinterest";
    const textLength = pinterest ? text.length : graphemes;
    const maxCharacters = limits.characters?.[network];
    if (maxCharacters !== undefined && maxCharacters > 0 && textLength > maxCharacters) {
        problems.push({
            message:
                `The text is ${textLength} characters and ${network} allows ${maxCharacters}. ` +
                `Remove ${textLength - maxCharacters} characters.` +
                (pinterest && textLength !== graphemes
                    ? " Pinterest counts an emoji as two or more characters."
                    : ""),
        });
    }

    const maxBytes = limits.max_post_bytes?.[network];
    if (maxBytes !== undefined && maxBytes > 0 && bytes > maxBytes) {
        problems.push({
            message:
                `The text is ${bytes} bytes and ${network} allows ${maxBytes}. This limit is ` +
                "counted in bytes, not characters: emoji and accented letters cost several bytes " +
                "each, so a text well inside the character limit can still be too long.",
        });
    }

    //`title_characters` usa `0` para «esta red no tiene campo de título», nunca una clave ausente.
    const maxTitle = limits.title_characters?.[network];
    if (input.title) {
        if (maxTitle === 0) {
            problems.push({
                message: `${network} has no title field. Put everything in the text instead.`,
            });
        } else if (
            maxTitle !== undefined &&
            (pinterest ? Array.from(input.title).length : countText(input.title).graphemes) > maxTitle
        ) {
            problems.push({
                message: `The title is longer than the ${maxTitle} characters ${network} allows.`,
            });
        }
    }

    const maxImages = limits.total_images?.[network];
    const files = input.files ?? [];
    if (maxImages !== undefined && maxImages >= 0 && files.length > maxImages) {
        problems.push({
            message:
                maxImages === 0
                    ? `${network} does not accept media on this kind of post.`
                    : `${files.length} files were given and ${network} accepts ${maxImages}.`,
        });
    }

    if (!text.trim() && files.length === 0) {
        problems.push({ message: "A post needs text, media, or both. This one has neither." });
    }

    return problems;
}

/**
 * Los dos campos que sólo tienen algunas redes —hoy, Pinterest—, validados con la matriz de
 * capacidades del servidor y no con una lista de aquí.
 *
 * El DESTINO (el tablero) es la razón de que exista: sin él el servidor no rechaza nada, guarda la
 * publicación en `withErrors` con el 987 y nadie la intenta. Un modelo que no sabe de tableros
 * publica en Pinterest, lee «creada» y da el pin por hecho. Y al revés los dos: en una red sin esos
 * campos el servidor los BORRA en silencio, así que un `link` en Facebook «funciona» y no hace nada
 * — mejor decirlo que dejar al modelo creer que puso un enlace.
 */
export function validateNetworkFields(
    capabilities: Record<string, SocialCapabilities | undefined>,
    input: {
        social_network: string;
        destination?: string | undefined;
        link?: string | undefined;
        creating: boolean;
    },
): LimitProblem[] {
    const network = input.social_network;
    const capability = capabilities[network];
    //Una red que esta versión no conoce no se juzga: que lo diga el servidor.
    if (capability === undefined) return [];
    const problems: LimitProblem[] = [];

    if (capability.destinations) {
        if (input.creating && !input.destination) {
            problems.push({
                message:
                    `A ${network} post has to say where it goes inside the account (on Pinterest, ` +
                    "the board). Call list_destinations with this account and pass one id as " +
                    "destination_id; ask the user which board if it is not obvious.",
            });
        } else if (input.destination !== undefined && !/^\d+$/.test(input.destination)) {
            problems.push({
                message:
                    `"${input.destination}" is not a board id. Pass the id from list_destinations ` +
                    "(a string of digits), never the board's name.",
            });
        }
    } else if (input.destination) {
        problems.push({
            message: `${network} has no destinations: the account itself is where the post goes. Remove destination_id.`,
        });
    }

    if (input.link) {
        if (!capability.link) {
            problems.push({
                message:
                    `${network} has no separate link field. Put the URL inside the text instead, ` +
                    "or remove link.",
            });
        } else if (!/^https?:\/\/\S+$/i.test(input.link)) {
            problems.push({ message: `link has to be an http(s) URL; "${input.link}" is not.` });
        }
    }

    return problems;
}

/** Las redes que el catálogo conoce, para decirle al modelo cuáles hay cuando escribe una mal. */
export function knownNetworks(limits: SocialLimits): string[] {
    return Object.keys(limits.characters ?? {}).sort();
}
