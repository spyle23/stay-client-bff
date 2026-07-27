/**
 * Paramètres du module `auth` — **custody de session** (story 2.1, AR-9 / NFR-8).
 *
 * Le BFF est le gardien des jetons : les JWT `Customer` du PMS vivent en Redis côté serveur,
 * le navigateur ne détient qu'un cookie **opaque** signé. Le secret de signature ne quitte
 * jamais le serveur (NFR-6).
 *
 * `resolveAuthOptions` est une **fonction pure** (miroir de `resolvePmsClientOptions` /
 * `resolveCatalogOptions`) → testable sans booter Nest, et **fail-fast** : un `SESSION_SECRET`
 * absent ou trop court fait échouer le démarrage plutôt que de laisser tourner un BFF dont
 * les cookies de session seraient forgeables.
 */

export interface AuthOptions {
  /** Secret HMAC de signature du cookie de session (jamais exposé, jamais loggé). */
  sessionSecret: string;
  /** Nom du cookie opaque déposé au navigateur. */
  cookieName: string;
  /** Attribut `Secure` du cookie (localhost est un contexte sécurisé : `true` marche en dev). */
  cookieSecure: boolean;
  /** Plafond dur du TTL d'une session (secondes) — borne le TTL dérivé de l'expiration PMS. */
  maxSessionTtlSeconds: number;
  /** TTL du verrou Redis de refresh (ms) — borne l'immobilisation si une instance meurt. */
  refreshLockTtlMs: number;
  /** Attente maximale du perdant du verrou avant d'abandonner (ms). */
  refreshWaitTimeoutMs: number;
  /** Intervalle de scrutation de la session par le perdant du verrou (ms). */
  refreshPollIntervalMs: number;
}

export const AUTH_OPTIONS = 'AUTH_OPTIONS';

/**
 * Longueur minimale du secret de session. 32 caractères ≈ 256 bits d'entrée HMAC-SHA256 :
 * en deçà, la signature du cookie devient attaquable hors-ligne (le cookie est public).
 */
export const SESSION_SECRET_MIN_LENGTH = 32;

/** Convention de nommage des clés Redis du dépôt : `<domaine>:<objet>:v1:<clé>`. */
export const SESSION_KEY_PREFIX = 'auth:session:v1:';
export const REFRESH_LOCK_PREFIX = 'auth:refresh:lock:v1:';

/**
 * `UserRole.Customer` côté PMS (`Admin=1, Manager=2, Receptionist=3, Customer=4`).
 * Le PMS expose **un seul** `/auth/login` pour tous les rôles : c'est au BFF de refuser
 * qu'un Manager/Admin ouvre une session sur l'application cliente (AC-4).
 */
export const CUSTOMER_ROLE = 4;

/** Caractères autorisés dans un nom de cookie (jeton RFC 7230). */
const COOKIE_NAME_PATTERN = /^[\w!#$%&'*+.^`|~-]+$/;

export function resolveAuthOptions(
  env: NodeJS.ProcessEnv = process.env,
): AuthOptions {
  const sessionSecret = (env.SESSION_SECRET ?? '').trim();
  if (sessionSecret.length < SESSION_SECRET_MIN_LENGTH) {
    // Fail-fast explicite : un secret absent/faible rendrait les sessions forgeables.
    throw new Error(
      `SESSION_SECRET manquant ou trop court (${sessionSecret.length} caractère(s), minimum ${SESSION_SECRET_MIN_LENGTH}). ` +
        'Renseignez-le dans stay-client-bff/.env (cf. .env.example) — il ne doit jamais être commité.',
    );
  }

  const cookieName = nonEmpty(env.SESSION_COOKIE_NAME, 'stay_sid');
  // Un nom hors « token » RFC 7230 passerait le boot puis ferait échouer **toute** connexion en
  // 500 (la sérialisation du cookie lève une TypeError) — panne différée et coûteuse à diagnostiquer.
  if (!COOKIE_NAME_PATTERN.test(cookieName)) {
    throw new Error(
      `SESSION_COOKIE_NAME invalide : "${cookieName}". Caractères autorisés : lettres, chiffres et !#$%&'*+-.^_\`|~`,
    );
  }

  // Doit rester du même ordre que le budget PMS + verrou : un perdant du verrou qui abandonne
  // en 5 s alors que le gagnant a jusqu'à ~25 s renverrait un 503 évitable.
  const refreshWaitTimeoutMs = bounded(
    env.SESSION_REFRESH_WAIT_MS,
    30_000,
    100,
    60_000,
  );
  const refreshPollIntervalMs = bounded(
    env.SESSION_REFRESH_POLL_MS,
    100,
    10,
    2_000,
  );
  // Bornés indépendamment, ces deux réglages peuvent se contredire (poll ≥ attente ⇒ une seule
  // lecture, budget dépassé d'un ordre de grandeur). On le refuse au boot plutôt qu'à l'exécution.
  if (refreshPollIntervalMs >= refreshWaitTimeoutMs) {
    throw new Error(
      `SESSION_REFRESH_POLL_MS (${refreshPollIntervalMs}) doit être strictement inférieur à SESSION_REFRESH_WAIT_MS (${refreshWaitTimeoutMs}).`,
    );
  }

  return {
    sessionSecret,
    cookieName,
    // Défaut `true` : `Secure` est accepté sur http://localhost (contexte sécurisé) — pas de
    // dégradation en dev. L'override n'existe que pour un déploiement derrière un proxy exotique.
    cookieSecure: env.SESSION_COOKIE_SECURE !== 'false',
    // 7 j = durée du refresh token PMS (JWT_REFRESH_EXPIRATION_DAYS). Plafond, pas valeur imposée :
    // le TTL réel est dérivé de `refreshTokenExpiration` renvoyé par le PMS.
    maxSessionTtlSeconds: bounded(
      env.SESSION_MAX_TTL_SECONDS,
      7 * 24 * 3600,
      60,
      30 * 24 * 3600,
    ),
    // ⚠️ Doit couvrir le budget d'un appel PMS complet, sinon le verrou expire **pendant** le
    // refresh : une seconde instance en émettrait un autre avec le même refresh token, que la
    // rotation du PMS rejetterait — déconnexion d'un voyageur en plein parcours. Budget réel :
    // PMS_TIMEOUT_MS (8 s) × (PMS_MAX_RETRIES + 1 = 3) + backoff ≈ 25 s → défaut 40 s.
    refreshLockTtlMs: bounded(
      env.SESSION_REFRESH_LOCK_MS,
      40_000,
      5_000,
      120_000,
    ),
    refreshWaitTimeoutMs,
    refreshPollIntervalMs,
  };
}

function nonEmpty(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim();
  return value.length > 0 ? value : fallback;
}

/**
 * Entier borné dans `[min, max]`, sinon `fallback`. La **normalisation en entier** est
 * indispensable pour les TTL Redis (une valeur fractionnaire est rejetée à l'écriture).
 */
function bounded(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.trunc(Math.min(Math.max(n, min), max));
}
