/**
 * Lo que comparten las veinticinco herramientas: un cliente `planvortex`, el cubo de fichas y la
 * resolución de la organización.
 *
 * El servidor MCP **no habla HTTP**. Le pide las cosas a la librería, que ya resolvió los 214
 * códigos de error, el `multipart`, la caché del token y la paginación. La contrapartida que hay
 * que aceptar —y que es correcta— es que cada endpoint que quiera exponer una herramienta tiene que
 * existir antes en la librería: es lo que evita una tercera copia de la API.
 */
import { PlanVortex, type Organization } from "planvortex";
import type { Config } from "./config.js";
import { CREDENTIALS_HELP, USER_AGENT } from "./config.js";
import { ToolInputError } from "./errors.js";
import { TokenBucket } from "./ratelimit.js";
import { DedupeCache } from "./dedupe.js";
import { log } from "./log.js";

export interface Context {
    /**
     * El cliente de la librería. Es un **getter perezoso** y por una razón concreta: en stdio las
     * credenciales pueden no estar (§ `main`), y aun así el servidor tiene que listar sus
     * veinticinco herramientas. Se construye la primera vez que alguien va a salir a la red, y si
     * entonces no hay credenciales lanza {@link ToolInputError} con {@link CREDENTIALS_HELP}, que
     * `runTool` convierte en un `isError` que el modelo puede leerle al usuario.
     */
    readonly pv: PlanVortex;
    readonly config: Config;
    /** El anti-duplicado de las escrituras (§ trampa 4). */
    readonly dedupe: DedupeCache;
    /** La memoria de la resolución de organización: una llamada por proceso, no por herramienta. */
    resolveOrganization(explicit?: string | undefined): Promise<string>;
    /** Todas las organizaciones a las que llega esta app. Cacheadas. */
    listOrganizations(): Promise<Organization[]>;
}

export function createContext(config: Config): Context {
    //TRAMPA 3: el cubo envuelve al `fetch` del cliente, no a cada herramienta. Una herramienta que
    //se olvidara de pedir ficha no existiría — no hay ninguna forma de salir a la red desde aquí
    //que no pase por esta función.
    const bucket = new TokenBucket();
    const limitedFetch = async (input: string, init: RequestInit): Promise<Response> => {
        await bucket.take();
        return fetch(input, {
            ...init,
            //Se distingue de la librería a secas en los logs del API, que es lo que se quiere el
            //día que haya que saber cuánto tráfico viene de agentes.
            headers: { ...(init.headers as Record<string, string>), "user-agent": USER_AGENT },
        });
    };

    let client: PlanVortex | undefined;
    const pv = (): PlanVortex => {
        if (client) return client;
        //Un `ToolInputError` y no un `ConfigError`: esto ya no es el arranque, es una herramienta
        //en marcha, y lo que tiene que pasar es que el modelo reciba la frase y se la enseñe a
        //quien configuró el servidor — no que el proceso se caiga en mitad de una conversación.
        if (!config.clientId || !config.clientSecret) throw new ToolInputError(CREDENTIALS_HELP);
        client = new PlanVortex({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
            fetch: limitedFetch,
        });
        return client;
    };

    let organizationsCache: Organization[] | undefined;
    let resolved: string | undefined;

    const listOrganizations = async (): Promise<Organization[]> => {
        if (organizationsCache) return organizationsCache;
        //Una sola llamada: `/clients_organizations` trae cada cliente con sus organizaciones raíz
        //dentro. Con `clients.list()` + `clients.organizations()` serían 1 + N.
        const page = await pv().clients.withOrganizations();
        organizationsCache = page.data.flatMap((client) => client.organizations ?? []);
        return organizationsCache;
    };

    /**
     * TRAMPA 1: la spec 2026-07-28 quitó las sesiones del protocolo, así que **cada llamada llega
     * sola** y no hay dónde guardar «la organización actual». Casi todo en la API cuelga de una
     * (`/organizations/:id/...`), y si cada herramienta la exige, el agente gasta una llamada de
     * descubrimiento antes de cada cosa y a veces se inventa el id.
     *
     * Tres capas, en este orden: el parámetro, si viene; si no, el entorno; si no, **y sólo si la
     * app llega a una sola organización**, ésa.
     *
     * Y cuando llega a varias sin pista, esto **no falla con un 400**: devuelve la lista con sus
     * ids, que es exactamente lo que el modelo necesita para reintentar bien a la primera.
     */
    const resolveOrganization = async (explicit?: string | undefined): Promise<string> => {
        if (explicit) return explicit;
        if (config.organizationId) return config.organizationId;
        if (resolved) return resolved;

        const organizations = await listOrganizations();
        if (organizations.length === 1 && organizations[0]) {
            resolved = organizations[0]._id;
            log.debug("organización resuelta por ser la única", { id: resolved });
            return resolved;
        }
        if (organizations.length === 0) {
            throw new ToolInputError(
                "This PlanVortex app does not reach any organization. A person has to create one " +
                    "in the PlanVortex panel, or grant this app access to an existing one.",
            );
        }
        const list = organizations.map((org) => `- ${org.name}: ${org._id}`).join("\n");
        throw new ToolInputError(
            `This app reaches ${organizations.length} organizations, so id_organization is ` +
                `required. Call again with one of these ids:\n${list}\n` +
                "Set PLANVORTEX_ORGANIZATION_ID in the server configuration to skip this step.",
        );
    };

    return {
        get pv(): PlanVortex {
            return pv();
        },
        config,
        dedupe: new DedupeCache(),
        resolveOrganization,
        listOrganizations,
    };
}
