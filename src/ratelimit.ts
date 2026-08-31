/**
 * El cubo de fichas propio del servidor MCP (§ trampa 3 del roadmap).
 *
 * POR QUÉ EXISTE, que no es evidente: la API de PlanVortex **no tiene limitador**. `RateLimit.ts`
 * del servidor cubre sólo `POST /oauth/token`, porque se escribió contra la fuerza bruta de
 * credenciales y no contra el tráfico. Un modelo que decide paginar una bandeja de 3.000
 * comentarios mete 300 peticiones en un minuto contra producción, y no hace falta mala fe: basta
 * con que alguien diga «resume todo lo que ha pasado este mes».
 *
 * Es el mismo razonamiento —y la misma forma— que `discord/Http.ts` y `telegram/Http.ts` dentro del
 * servidor: la garantía tiene que ser ARITMÉTICA, no estadística. Un cubo compartido por TODAS las
 * llamadas salientes pone un techo que ni un bucle infinito puede rebasar. Por eso el bucket vive
 * envolviendo al `fetch` del cliente `planvortex` (§ {@link createContext}) y no en cada
 * herramienta: una herramienta que se olvidara de pedir ficha no existiría.
 *
 * El otro freno, el que corta el bucle de verdad, es {@link MAX_PAGES}: el cubo hace que 300
 * peticiones tarden un minuto en vez de un segundo, pero sigue haciéndolas.
 */

/** Peticiones por segundo sostenidas contra la API. */
export const DEFAULT_RATE_PER_SECOND = 5;

/** Cuántas puede soltar de golpe antes de empezar a esperar. */
export const DEFAULT_BURST = 10;

/**
 * El tope duro de páginas que una sola llamada de herramienta puede pedir.
 *
 * Ninguna herramienta pagina hoy más de una vez —los listados devuelven una página corta y ya—,
 * así que esto es el cinturón: si algún día una herramienta itera, itera con techo.
 */
export const MAX_PAGES = 5;

export class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    /** La cola de esperas encadenadas: sin ella dos llamadas concurrentes se darían la misma ficha. */
    private tail: Promise<void> = Promise.resolve();

    constructor(
        private readonly ratePerSecond: number = DEFAULT_RATE_PER_SECOND,
        private readonly burst: number = DEFAULT_BURST,
        private readonly now: () => number = () => Date.now(),
        private readonly sleep: (ms: number) => Promise<void> = (ms) =>
            new Promise((resolve) => setTimeout(resolve, ms)),
    ) {
        this.tokens = burst;
        this.lastRefill = now();
    }

    /** Espera hasta tener una ficha. Serializada: el orden de entrada es el orden de salida. */
    async take(): Promise<void> {
        const wait = this.tail.then(() => this.consume());
        //La cola nunca se rompe por un fallo de la petición de al lado.
        this.tail = wait.catch(() => undefined);
        return wait;
    }

    /** Lo que queda ahora mismo. Sólo para los tests y para el log de depuración. */
    available(): number {
        this.refill();
        return this.tokens;
    }

    private async consume(): Promise<void> {
        this.refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return;
        }
        const missing = 1 - this.tokens;
        await this.sleep(Math.ceil((missing / this.ratePerSecond) * 1000));
        this.refill();
        //Tras dormir siempre hay ficha; el `max(0)` es por si el reloj del sistema saltó atrás.
        this.tokens = Math.max(0, this.tokens - 1);
    }

    private refill(): void {
        const now = this.now();
        const elapsed = Math.max(0, now - this.lastRefill);
        this.lastRefill = now;
        this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.ratePerSecond);
    }
}
