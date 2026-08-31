/**
 * La caché anti-duplicado de las escrituras.
 *
 * TRAMPA 4 DEL ROADMAP. La librería ya protege del reintento del TRANSPORTE: `isIdempotent()` en su
 * `core/http.ts` no repite un `POST` salvo que el fallo demuestre que la petición no llegó. Pero
 * eso no cubre al que reintenta aquí, que es **el modelo**.
 *
 * Un `tools/call` que tarda cuarenta segundos y muere por el timeout del cliente deja al modelo sin
 * respuesta, y lo que hace un modelo sin respuesta es **volver a llamar a la herramienta**. Dos
 * publicaciones idénticas en Instagram, y la API no tiene clave de idempotencia que lo impida.
 *
 * La defensa es esto: una huella de la escritura durante unos minutos; si vuelve a entrar la misma,
 * se devuelve **lo que ya se creó**, con un texto que dice que ya existía. Es poco código y es la
 * diferencia entre una demo y un incidente en la cuenta de un cliente.
 *
 * Vive en memoria a propósito: el servidor corre en la máquina de su dueño y muere con la
 * conversación. Una caché persistente resolvería un caso que no se da y traería un fichero de
 * estado que gestionar.
 */

/** Cuánto dura una huella. Suficiente para cubrir un timeout de cliente y un reintento del modelo. */
export const DEDUPE_TTL_MS = 5 * 60 * 1000;

/** Tope de entradas: una conversación larga no puede hacer crecer esto sin fin. */
const MAX_ENTRIES = 200;

interface Entry<T> {
    value: T;
    expiresAt: number;
}

export class DedupeCache {
    private readonly entries = new Map<string, Entry<unknown>>();

    constructor(
        private readonly ttlMs: number = DEDUPE_TTL_MS,
        private readonly now: () => number = () => Date.now(),
    ) {}

    /**
     * Ejecuta `fn` **salvo** que la misma huella se haya visto hace poco, en cuyo caso devuelve lo
     * de entonces. El segundo elemento dice cuál de las dos cosas pasó, porque el texto que lee el
     * modelo tiene que decirlo: si no, cree que ha publicado dos veces.
     */
    async run<T>(key: string, fn: () => Promise<T>): Promise<[T, boolean]> {
        const hit = this.get<T>(key);
        if (hit !== undefined) return [hit, true];
        const value = await fn();
        this.set(key, value);
        return [value, false];
    }

    get<T>(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value as T;
    }

    set<T>(key: string, value: T): void {
        if (this.entries.size >= MAX_ENTRIES) {
            //La más vieja primero: `Map` conserva el orden de inserción.
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) this.entries.delete(oldest);
        }
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    }

    clear(): void {
        this.entries.clear();
    }
}

/**
 * La huella de una escritura: la operación y sus partes que la hacen «la misma».
 *
 * Se normaliza el espacio del texto porque un modelo que reintenta rara vez reproduce byte a byte
 * lo que mandó —un salto de línea de más y la huella cambiaría—, y eso convertiría la protección en
 * decorativa.
 */
export function fingerprint(operation: string, parts: readonly (string | undefined)[]): string {
    const normalised = parts.map((part) => (part ?? "").replace(/\s+/g, " ").trim().toLowerCase());
    return `${operation}::${normalised.join("::")}`;
}
