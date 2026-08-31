/**
 * Las proyecciones cortas de cada entidad.
 *
 * TRAMPA 7 DEL ROADMAP: las respuestas del API son enormes y el contexto se paga. Una
 * `Publication` trae `publication_errors`, `extra_data`, `publication_stats` y la cuenta **poblada
 * entera**; treinta publicaciones son decenas de miles de tokens, el listado se come la ventana y
 * el modelo se queda sin sitio para pensar.
 *
 * La regla, sin excepciones: **toda herramienta de listado devuelve una proyección corta** —id,
 * red, estado, fecha y las primeras palabras del texto—, con `limit` por defecto 10 y tope 50. La
 * ficha completa se pide por id, y una a una.
 *
 * Y cuando se trunca, **se dice que se ha truncado y cuántos quedan**: un truncado silencioso es
 * exactamente cómo un modelo llega a decirle a alguien «no tienes más publicaciones».
 */
import {
    account as populatedAccount,
    accountId,
    messageContact,
    type Account,
    type Comment,
    type Conversation,
    type Message,
    type Organization,
    type Publication,
    type TopPublication,
    type Upload,
} from "planvortex";
import { wrapUntrusted } from "./untrusted.js";

/** Lo que devuelve un listado si nadie dice otra cosa. */
export const DEFAULT_LIMIT = 10;
/** Y lo máximo que puede pedir, aunque lo pida. */
export const MAX_LIMIT = 50;

/** Cuánto texto de una publicación entra en un listado. Lo justo para reconocerla. */
const SNIPPET = 140;

/** El `limit` que de verdad se usa: nunca 0, nunca más de {@link MAX_LIMIT}. */
export function clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/** Las primeras palabras, con el corte dicho en voz alta. */
export function snippet(text: string | undefined, max = SNIPPET): string {
    if (!text) return "";
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * La coletilla de un listado. Nunca se calla un truncado: si el total no se conoce, se dice que
 * puede haber más, que es la verdad y no cuesta nada.
 */
export function paginationNote(shown: number, total: number | undefined, offset = 0): string {
    if (total === undefined) {
        return shown === 0 ? "No results." : `Showing ${shown}. There may be more.`;
    }
    const seen = offset + shown;
    if (seen >= total) return shown === 0 ? "No results." : `Showing all ${total}.`;
    return `Showing ${shown} of ${total}. ${total - seen} more — call again with offset ${seen}.`;
}

export interface OrganizationView {
    id: string;
    name: string;
}

export function projectOrganization(organization: Organization): OrganizationView {
    return { id: organization._id, name: organization.name };
}

export interface AccountView {
    id: string;
    social_network: string;
    name: string;
    username?: string;
    followers?: number;
    /** `0` es «bien». Cualquier otro número es el código del catálogo que explica por qué falla. */
    error_code: number;
    /** Lo que de verdad se pregunta: ¿puedo publicar con esta cuenta ahora mismo? */
    healthy: boolean;
}

export function projectAccount(account: Account): AccountView {
    return {
        id: account._id,
        social_network: String(account.social_network),
        name: account.name,
        ...(account.username === undefined ? {} : { username: account.username }),
        ...(account.followers_count === undefined ? {} : { followers: account.followers_count }),
        error_code: account.error_code,
        healthy: !account.error_code,
    };
}

export interface PublicationView {
    id: string;
    social_network: string;
    state: string;
    publication_type: string;
    publish_date?: string;
    text: string;
    id_account: string;
    /** Cuántos motivos de fallo trae. El detalle se pide con `get_publication`. */
    errors: number;
    url?: string;
}

export function projectPublication(publication: Publication): PublicationView {
    return {
        id: publication._id,
        social_network: String(publication.social_network),
        state: String(publication.state),
        publication_type: String(publication.publication_type),
        ...(publication.publish_date === undefined ? {} : { publish_date: publication.publish_date }),
        text: snippet(publication.text),
        id_account: accountId(publication),
        errors: publication.publication_errors?.length ?? 0,
        ...(publication.url === undefined ? {} : { url: publication.url }),
    };
}

/**
 * La ficha entera de UNA publicación. Sigue sin ser el objeto crudo: `extra_data` y la cuenta
 * poblada entera no le dicen nada a un modelo, y `publication_errors` —que es justo lo que se viene
 * a mirar— sí.
 */
export function projectPublicationDetail(publication: Publication): Record<string, unknown> {
    const populated = populatedAccount(publication);
    return {
        ...projectPublication(publication),
        text: publication.text ?? "",
        ...(publication.title === undefined ? {} : { title: publication.title }),
        ...(publication.name === undefined ? {} : { name: publication.name }),
        account: populated ? projectAccount(populated) : undefined,
        files: (publication.files ?? []).map(projectUpload),
        retries: publication.retries,
        ...(publication.external_identifier === undefined
            ? {}
            : { external_identifier: publication.external_identifier }),
        publication_errors: (publication.publication_errors ?? []).map((detail) => ({
            code: detail.code,
            message: detail.message,
        })),
    };
}

export interface UploadView {
    id: string;
    name: string;
    file_type: string;
    file_format: string;
}

/**
 * El fichero, **sin `public_path`** salvo que se pida a propósito.
 *
 * TRAMPA 8: `public_path` no es un enlace estable, es una URL presignada de R2 que caduca. Sirve
 * para enseñársela al usuario en el momento; no sirve para que el modelo la «recuerde» de una
 * conversación anterior ni para guardarla en un `resource` con `ttlMs` largo.
 */
export function projectUpload(upload: Upload): UploadView {
    return {
        id: upload._id,
        name: upload.name,
        file_type: String(upload.file_type),
        file_format: String(upload.file_format),
    };
}

export interface CommentView {
    id: string;
    social_network: string;
    author: string;
    /** El texto va **envuelto** (§ trampa 2). Nunca crudo. */
    text: string;
    rating?: number;
    read: boolean;
    replied: boolean;
    hidden: boolean;
    /** El de la RED, opaco, que es el que consumen `reply_to_comment` y `hide_comment`. */
    external_id: string;
    date: string;
}

export function projectComment(comment: Comment): CommentView {
    return {
        id: comment._id,
        social_network: String(comment.social_network),
        author: comment.author?.name ?? "unknown",
        text: wrapUntrusted(comment.text, {
            source: `${String(comment.social_network)} comment`,
            author: comment.author?.name,
            id: comment._id,
        }),
        ...(comment.rating === undefined ? {} : { rating: comment.rating }),
        read: comment.read,
        replied: comment.replied,
        hidden: comment.hidden,
        external_id: comment.external_id,
        date: comment.creation_date,
    };
}

export interface ConversationView {
    contact_id: string;
    name: string;
    unread: number;
    last_message_date: string;
}

export function projectConversation(conversation: Conversation): ConversationView {
    return {
        contact_id: conversation.contact._id,
        name: conversation.contact.name ?? "unknown",
        unread: conversation.unread_messages,
        last_message_date: conversation.date,
    };
}

export interface MessageView {
    id: string;
    direction: string;
    /** Envuelto igual que un comentario: un DM lo escribe cualquiera (§ trampa 2). */
    text: string;
    read: boolean;
    date: string;
    message_type: string;
}

export function projectMessage(message: Message): MessageView {
    //`from_contact_id` presente = lo escribió el contacto; ausente = lo escribimos nosotros.
    const incoming = message.from_contact_id !== undefined;
    const contact = messageContact(message);
    return {
        id: message._id,
        direction: incoming ? "incoming" : "outgoing",
        //Lo nuestro no se envuelve: lo escribió el cliente, no un desconocido.
        text: incoming
            ? wrapUntrusted(message.text, {
                  source: "private message",
                  author: contact?.name,
                  id: message._id,
              })
            : (message.text ?? ""),
        read: message.read,
        date: message.creation_date,
        message_type: String(message.message_type),
    };
}

export interface TopPublicationView {
    id_publication: string;
    social_network: string;
    text: string;
    url?: string;
    metrics: Record<string, number>;
    engagement_base?: string;
}

export function projectTopPublication(top: TopPublication): TopPublicationView {
    return {
        id_publication: top.id_publication,
        social_network: String(top.social_network),
        text: snippet(top.publication?.text),
        ...(top.publication?.url === undefined ? {} : { url: top.publication.url }),
        metrics: compactNumbers(top.metrics),
        ...(top.engagement_base === undefined ? {} : { engagement_base: String(top.engagement_base) }),
    };
}

/**
 * Quita las claves que no traen número.
 *
 * TRAMPA 14, y es la razón de que esta función exista en vez de volcar el objeto: **las métricas
 * que faltan no son ceros**. Telegram y Bluesky no tienen impresiones ni alcance en ninguna parte
 * de su API; Google Business no publica. Si el hueco se rellena con `0`, el modelo dirá que el post
 * no lo vio nadie, y eso es peor que no decir nada. Es la misma decisión que ya tomó la pantalla de
 * estadísticas del panel.
 */
export function compactNumbers(source: Record<string, unknown> | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(source ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
}

/**
 * Un bloque legible de `clave: valor`, que es lo que de verdad lee el modelo.
 *
 * Acepta `object` y no `Record<string, unknown>` porque las vistas de arriba son interfaces, y una
 * interfaz no tiene índice de cadena: pedirlo obligaría a declarar las quince con `[k: string]` y a
 * perder justo la comprobación que las hace útiles.
 */
export function asLines(rows: readonly object[]): string {
    return rows
        .map((row) =>
            Object.entries(row)
                .filter(([, value]) => value !== undefined && value !== "")
                .map(([key, value]) => `${key}: ${formatValue(value)}`)
                .join("\n"),
        )
        .join("\n\n");
}

function formatValue(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}
