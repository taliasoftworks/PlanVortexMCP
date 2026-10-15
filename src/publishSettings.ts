/**
 * TIKTOK: lo que su auditoría de contenido (Content Sharing Guidelines) exige antes de publicar, y
 * cómo se cumple desde un asistente.
 *
 * La guía pide que la PERSONA elija, sin nada marcado de antemano: quién puede ver la publicación
 * (sólo entre las privacidades que admite SU cuenta ahora), si se puede comentar, hacer Dúo o
 * Stitch, y si es contenido comercial. Y que vea a qué cuenta va y la declaración de la música.
 * Un modelo que publica en TikTok sin preguntar nada sería exactamente lo que la guía prohíbe.
 *
 * Por qué NO es una herramienta nueva: la lista de herramientas es un contrato con los clientes
 * instalados y con las revisiones de los directorios (test/protocol.test.ts). Así que lo que admite
 * la cuenta lo lee `create_publication` por su cuenta cuando le falta algo, y lo devuelve en el
 * error: el modelo lo enseña, pregunta, y vuelve a llamar con las respuestas.
 *
 * Se decide por la capacidad `publish_settings` del servidor, no por el nombre de la red.
 */
import type { Context } from "./context.js";
import type { LimitProblem } from "./limits.js";

/** Lo que devuelve `GET /organizations/{id}/accounts/{id}/publish_settings` */
export interface PublishSettingsView {
    social_network: string;
    creator?: { username?: string; nickname?: string };
    visibility_options: string[];
    interactions: Record<string, { disabled: boolean } | undefined>;
    max_video_duration_sec?: number;
    can_post: boolean;
    reason?: string;
}

/** Cómo se nombra cada privacidad al preguntarle a la persona: las palabras de la app de TikTok */
const VISIBILITY_WORDS: Record<string, string> = {
    public: "everyone (public)",
    friends: "friends (followers they follow back)",
    followers: "followers",
    private: "only them (private)",
};

/** Las visibilidades con las que una colaboración pagada no puede salir (ERROR_2504 del servidor) */
export const BRANDED_FORBIDDEN_VISIBILITY = ["private", "followers"];

/**
 * Lo que la cuenta admite ahora. La librería `planvortex` que usa este servidor aún no tiene
 * `accounts.publishSettings()`, así que va por `request`, que la librería expone justo para esto.
 */
export async function readPublishSettings(
    context: Context,
    idOrganization: string,
    idAccount: string,
): Promise<PublishSettingsView> {
    const response = await context.pv.request<{ publish_settings: PublishSettingsView }>({
        method: "GET",
        path: `/organizations/${encodeURIComponent(idOrganization)}/accounts/${encodeURIComponent(idAccount)}/publish_settings`,
    });
    return response.data.publish_settings;
}

export interface TiktokChoices {
    visibility?: string | undefined;
    interactions?: Record<string, boolean | undefined> | undefined;
    commercial_content?:
        { your_brand?: boolean | undefined; branded_content?: boolean | undefined } | undefined;
    /** Con fecha futura, el tope diario de hoy no importa: TikTok lo mira el día que salga */
    scheduled_later: boolean;
    creating: boolean;
}

/**
 * Lo que falta o no vale para publicar en esta cuenta, con TODO lo que el modelo necesita para
 * preguntarle a la persona en una sola vuelta. Vacío = se puede mandar.
 */
export function publishSettingsProblems(
    settings: PublishSettingsView,
    choices: TiktokChoices,
): LimitProblem[] {
    const problems: LimitProblem[] = [];
    const account = settings.creator?.nickname || settings.creator?.username || "this account";

    if (!settings.can_post && !choices.scheduled_later) {
        problems.push({
            message:
                `TikTok is not taking posts from ${account} right now (${settings.reason ?? "no reason given"}), ` +
                "usually because it reached its daily posting limit. Do not retry now: tell the user, " +
                "and offer to schedule it for later with publish_date.",
        });
        return problems;
    }

    const options = settings.visibility_options;
    const missing: string[] = [];
    if (choices.creating && !choices.visibility) {
        missing.push(
            `who can see it, one of: ${options.map((option) => `${option} = ${VISIBILITY_WORDS[option] ?? option}`).join("; ")}` +
                " (pass it as visibility; there is no default, the user has to pick)",
        );
    }
    if (choices.creating && choices.interactions === undefined) {
        const closed = Object.keys(settings.interactions).filter(
            (key) => settings.interactions[key]?.disabled,
        );
        missing.push(
            "whether people can comment, and on a video Duet and Stitch with it (pass interactions: " +
                "{comments, duet, stitch}, each true or false; none is allowed unless the user says so)" +
                (closed.length > 0
                    ? `. ${closed.join(" and ")} ${closed.length === 1 ? "is" : "are"} turned off in their TikTok settings and will stay off`
                    : ""),
        );
    }
    if (missing.length > 0) {
        problems.push({
            message:
                `This post goes to the TikTok account ${account}. TikTok requires the user to choose, ` +
                `with nothing preselected:\n  1. ${missing.join("\n  2. ")}\n` +
                "Also ask whether it is commercial content: promoting their own brand (labeled " +
                '"Promotional content") and/or a paid partnership with a third party (labeled ' +
                '"Paid partnership", which cannot be private). Pass commercial_content: ' +
                "{your_brand, branded_content}, or leave it out if it is neither. Tell them that by " +
                "posting they agree to TikTok's Music Usage Confirmation (and, for a paid partnership, " +
                "its Branded Content Policy). Then call again with their answers.",
        });
    }

    if (choices.visibility && options.length > 0 && !options.includes(choices.visibility)) {
        problems.push({
            message:
                `${account} does not allow visibility "${choices.visibility}" right now. It allows: ` +
                `${options.join(", ")}. Ask the user which one.`,
        });
    }
    return problems;
}
