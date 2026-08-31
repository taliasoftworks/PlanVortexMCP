/**
 * `upload_media`: la única herramienta que toca el disco, y la que más superficie de ataque tiene
 * de las veinticinco.
 *
 * TRAMPA 6 DEL ROADMAP. El modelo no puede mandar 200 MB de vídeo en base64 por un `tools/call`.
 * Con **stdio** hay una salida limpia: el servidor corre en la máquina del usuario, así que se
 * acepta una **ruta local** y la librería ya sabe subirla por streaming con `fs.openAsBlob`, sin
 * pasar el fichero por memoria.
 *
 * Dos consecuencias que hay que declarar o alguien se estrella:
 *
 * - **En modo `--http` la ruta local NO vale**, porque es la ruta del *servidor*, no la del
 *   usuario. Ahí sólo se acepta una URL, y con su propia validación. La asimetría se cuenta en el
 *   README y **la descripción de la herramienta cambia según el modo**, para que el modelo no
 *   ofrezca lo que no hay.
 * - **Leer una ruta arbitraria del disco es exactamente lo que un prompt inyectado querría**
 *   (`~/.ssh/id_rsa` subido a la biblioteca de una organización, que devuelve una URL firmada). De
 *   ahí la allowlist de `PLANVORTEX_MCP_UPLOAD_DIRS` y la extensión validada **antes** de abrir
 *   nada.
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Context } from "../context.js";
import { toolOk, ToolInputError } from "../errors.js";
import { asLines, projectUpload } from "../format/project.js";
import { fingerprint } from "../dedupe.js";
import { defineTool } from "./register.js";

/**
 * Los formatos que el servidor acepta (`ALLOWED_FILES_FORMATS`). `heic`/`heif` entran porque una
 * foto de iPhone tiene que pasar la puerta: el servidor la convierte a JPEG durante la ingesta.
 */
const ALLOWED_EXTENSIONS = new Set(["mp4", "jpeg", "jpg", "png", "gif", "heic", "heif"]);

/** 200 MB. Por encima de esto no es un adjunto de una publicación, es otro problema. */
const MAX_BYTES = 200 * 1024 * 1024;

export function registerUploadTools(server: McpServer, ctx: Context): void {
    const stdio = ctx.config.mode === "stdio";
    const sourceDescription = stdio
        ? "Absolute path to a local file, or a public https URL. Local paths only work because " +
          "this server runs on the user's own machine, and only inside the directories the " +
          "server was allowed to read."
        : "A public https URL. This server runs in HTTP mode, so a local path would be a path on " +
          "the SERVER, not on the user's machine, and is refused.";

    defineTool(
        server,
        ctx,
        {
            name: "upload_media",
            title: "Upload an image or video",
            description:
                "Put an image or video into an organization's file library and get back the id " +
                `that create_publication consumes in files. ${sourceDescription} ` +
                "Accepted formats: jpg, jpeg, png, gif, mp4, heic, heif.",
            inputSchema: z.object({
                source: z.string().describe(sourceDescription),
                filename: z
                    .string()
                    .describe("Name to store it under. Deduced from the source when omitted.")
                    .optional(),
                id_organization: z.string().describe("The PlanVortex organization id.").optional(),
            }),
            outputSchema: z.object({
                upload: z.object({
                    id: z.string(),
                    name: z.string(),
                    file_type: z.string(),
                    file_format: z.string(),
                }),
                already_existed: z.boolean(),
            }),
            annotations: { readOnlyHint: false, openWorldHint: false },
            write: true,
        },
        async (args, context) => {
            const idOrganization = await context.resolveOrganization(args.id_organization);
            const source = args.source.trim();
            const isUrl = /^https?:\/\//i.test(source);

            const file = isUrl
                ? await fetchRemote(source)
                : await readLocal(source, context.config.mode === "stdio", context.config.uploadDirs);

            const filename = args.filename ?? file.filename;
            assertExtension(filename);

            //El mismo fichero subido dos veces por un reintento del modelo es un fichero de más en
            //la biblioteca y un id distinto en la publicación (§ trampa 4).
            const key = fingerprint("upload_media", [idOrganization, filename, file.identity]);
            const [upload, alreadyExisted] = await context.dedupe.run(key, () =>
                context.pv.uploads.create(idOrganization, { file: file.source, filename }),
            );

            const view = projectUpload(upload);
            const preface = alreadyExisted ? "This file was already uploaded moments ago.\n\n" : "";
            return toolOk(
                `${preface}${asLines([view])}\n\nPass "${view.id}" in the files array of create_publication.`,
                { upload: view, already_existed: alreadyExisted },
            );
        },
    );
}

interface LoadedFile {
    /**
     * Lo que se le pasa a la librería. Con una ruta local es LA RUTA, no su contenido:
     * `uploads.create` la sube por streaming con `fs.openAsBlob` y un vídeo de 200 MB no pasa por
     * memoria. Leerlo a un `Buffer` aquí anularía justo eso (§ trampa 6).
     */
    source: string | Buffer;
    filename: string;
    /** Lo que hace a dos subidas «la misma» para el anti-duplicado. */
    identity: string;
}

/**
 * Una ruta del disco, y sólo si TRES cosas se cumplen: estamos en stdio, hay allowlist, y la ruta
 * cae dentro de ella. Sin allowlist configurada no se lee nada: el valor por defecto seguro es
 * «ninguno», no «todos».
 */
async function readLocal(path: string, stdio: boolean, allowed: readonly string[]): Promise<LoadedFile> {
    if (!stdio) {
        throw new ToolInputError(
            "This server is running in HTTP mode, where a local path would point at the server's " +
                "own disk and not at the user's machine. Pass a public https URL instead.",
        );
    }
    if (!isAbsolute(path)) {
        throw new ToolInputError(`upload_media needs an absolute path, got "${path}".`);
    }
    if (allowed.length === 0) {
        throw new ToolInputError(
            "This server is not allowed to read any local directory, so it cannot upload a file " +
                "by path. Ask the user to set PLANVORTEX_MCP_UPLOAD_DIRS to the folders it may " +
                "read (for example their Pictures folder), or pass a public https URL instead.",
        );
    }
    const target = resolve(path);
    const inside = allowed.some((dir) => {
        const root = resolve(dir);
        return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
    });
    if (!inside) {
        throw new ToolInputError(
            `"${path}" is outside the directories this server may read. Allowed: ${allowed.join(", ")}.`,
        );
    }
    const info = await stat(target);
    if (!info.isFile()) throw new ToolInputError(`"${path}" is not a file.`);
    if (info.size > MAX_BYTES) {
        throw new ToolInputError(
            `"${path}" is ${Math.round(info.size / 1024 / 1024)} MB; the limit is 200 MB.`,
        );
    }
    return {
        source: target,
        filename: target.split(/[\\/]/).pop() ?? "upload",
        //Ruta, tamaño y mtime: reconoce el reintento sin leer el fichero entero para hacerle un hash.
        identity: `${target}:${info.size}:${info.mtimeMs}`,
    };
}

/**
 * Una URL remota, con la validación que evita el SSRF de manual: nada de `file://`, nada de IPs
 * privadas. En `--http` es el único camino, y ahí el que manda la URL puede no ser de confianza.
 */
async function fetchRemote(url: string): Promise<LoadedFile> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new ToolInputError(`Only http and https URLs are accepted, got "${parsed.protocol}".`);
    }
    if (isPrivateHost(parsed.hostname)) {
        throw new ToolInputError(
            `"${parsed.hostname}" is a private or loopback address. Media has to come from a ` +
                "publicly reachable URL.",
        );
    }
    const response = await fetch(url);
    if (!response.ok) {
        throw new ToolInputError(`Could not download ${url}: HTTP ${response.status}.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) {
        throw new ToolInputError(
            `That file is ${Math.round(bytes.byteLength / 1024 / 1024)} MB; the limit is 200 MB.`,
        );
    }
    const name = parsed.pathname.split("/").pop() || "upload";
    return { source: bytes, filename: name, identity: createHash("sha256").update(bytes).digest("hex") };
}

/** Loopback, enlace local y los tres rangos privados de IPv4, más los nombres que llevan ahí. */
export function isPrivateHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
    if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return true;
    const parts = host.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
    const [a = 0, b = 0] = parts.map(Number) as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
}

/** La extensión, comprobada **antes** de abrir nada y contra la lista del servidor. */
function assertExtension(filename: string): void {
    const extension = extname(filename).replace(".", "").toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
        throw new ToolInputError(
            `"${filename}" is not a format PlanVortex accepts. Allowed: ` +
                `${[...ALLOWED_EXTENSIONS].join(", ")}.`,
        );
    }
}
