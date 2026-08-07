import { isIP } from 'node:net';
import { Logger } from '@nestjs/common';

/**
 * Paramètres de **limitation de débit** (story 2.4 — FR-9 / NFR-7 / §10 anti-abus).
 *
 * Portée volontairement **bornée à deux routes** : la création de réservation
 * (`POST /booking/reservations`) et le Checkout invité (`POST /auth/guest`). Ce sont les deux
 * écritures qui laissent une trace **durable** dans la base du PMS partagée avec le back-office —
 * une `Pending` gèle une vraie chambre, un provisioning crée un vrai `Customer`. Le durcissement
 * transverse (connexion, recherche, CSRF, préfixe `__Host-`) reste le périmètre de la story 6.1.
 *
 * Deux compteurs indépendants s'appliquent à chaque appel :
 * - **`ip`** — freine un attaquant unique (déni d'inventaire, énumération) ;
 * - **`identity`** — freine un compte (ou un email au Checkout invité) qui tournerait derrière
 *   plusieurs adresses. Sans lui, un botnet contournerait la limite par IP.
 *
 * Fonction pure et bornée (patron `resolveAuthOptions` / `resolveBookingOptions`) : testable sans
 * booter Nest, et jamais de lecture d'env dispersée. Les **contradictions de configuration** sont
 * refusées **au boot**, comme `resolveBookingOptions` refuse les siennes.
 */

export interface ThrottlerOptionsResolved {
  /** Fenêtre de comptage (ms), commune aux deux compteurs. */
  windowMs: number;
  /** Requêtes autorisées par adresse IP et par fenêtre. */
  ipLimit: number;
  /** Requêtes autorisées par compte / email et par fenêtre. */
  identityLimit: number;
  /** Durée de blocage (ms) une fois la limite franchie. */
  blockMs: number;
}

export const THROTTLER_NAMES = {
  ip: 'ip',
  identity: 'identity',
} as const;

/** Message renvoyé au navigateur en 429 — humain, en français, sans détail exploitable. */
export const THROTTLER_MESSAGE =
  'Trop de tentatives. Patientez quelques instants avant de réessayer.';

/**
 * Motif **machine** accompagnant un 429 dans `errors.reason` (AC-8) — le front distingue ainsi
 * « trop de tentatives » d'un refus métier sans analyser le texte affichable.
 */
export const RATE_LIMITED_REASON = 'rate-limited';

/**
 * Facteur appliqué au seuil d'identité sur **`POST /booking/reservations`** (revue 2.4).
 *
 * Arbitrage : le `ThrottlerGuard` compte **avant** que le service ne reconnaisse un rejeu
 * idempotent (AC-5). Or le parcours qu'AC-5 déclare inoffensif — double-clic, F5, retour arrière,
 * reprise de tunnel — produit facilement 6 `POST` du même compte en une minute **sans rien créer**
 * (le service relit la réservation mémorisée en Redis, sans écrire au PMS). Au seuil nu (5/min),
 * ce voyageur légitime récoltait un 429 **et** 60 s de blocage au pire moment du tunnel.
 *
 * On double donc le seuil d'identité **sur cette seule route**, en le **plafonnant au seuil IP** :
 * au-delà, le compteur d'identité serait vain pour un client donné (l'IP bloquerait d'abord) et
 * contredirait le contrôle de cohérence du boot. Ce qui protège réellement l'écriture reste
 * inchangé : le seuil par IP, le verrou de séjour et l'idempotence côté service.
 */
const RESERVATION_REPLAY_FACTOR = 2;

/**
 * Seuil d'identité de la création de réservation : `identityLimit × facteur`, plafonné au seuil IP.
 * Exposé pour être testable sans booter Nest (le décorateur `@Throttle` s'en sert à chaud).
 */
export function reservationIdentityLimit(
  options: ThrottlerOptionsResolved,
): number {
  return Math.min(
    options.identityLimit * RESERVATION_REPLAY_FACTOR,
    options.ipLimit,
  );
}

export function resolveThrottlerOptions(
  env: NodeJS.ProcessEnv = process.env,
): ThrottlerOptionsResolved {
  // 60 s : assez court pour ne pas punir un voyageur qui corrige une erreur, assez long pour
  // rendre le martèlement inefficace.
  const windowMs = bounded(env.THROTTLE_WINDOW_MS, 60_000, 1_000, 3_600_000);
  // 10 créations/minute par IP : très au-dessus d'un usage humain (une réservation prend des
  // minutes), très en dessous d'un script.
  const ipLimit = bounded(env.THROTTLE_IP_LIMIT, 10, 1, 1_000);
  // Plus strict : un même compte n'a aucune raison d'enchaîner les créations.
  const identityLimit = bounded(env.THROTTLE_IDENTITY_LIMIT, 5, 1, 1_000);
  const blockMs = bounded(env.THROTTLE_BLOCK_MS, 60_000, 1_000, 3_600_000);

  // Bornés indépendamment, ces réglages peuvent se contredire. On refuse au boot plutôt que de
  // servir une politique qui ne veut rien dire (patron `resolveBookingOptions`).
  if (identityLimit > ipLimit) {
    throw new Error(
      `THROTTLE_IDENTITY_LIMIT (${identityLimit}) ne peut pas dépasser THROTTLE_IP_LIMIT (${ipLimit}) : ` +
        `le compteur d'identité ne se déclencherait jamais pour un client donné, l'IP bloquant en premier.`,
    );
  }
  if (blockMs > windowMs) {
    throw new Error(
      `THROTTLE_BLOCK_MS (${blockMs}) ne peut pas dépasser THROTTLE_WINDOW_MS (${windowMs}) : ` +
        `la sanction survivrait à la fenêtre qui l'a déclenchée, sans qu'aucun compteur ne la justifie plus.`,
    );
  }

  return { windowMs, ipLimit, identityLimit, blockMs };
}

/**
 * Configuration `@Throttle` d'une route : les **deux** compteurs nommés, déclarés explicitement.
 *
 * ⚠️ Valeurs exposées en **fonctions** (`Resolvable`) et non figées : un décorateur est évalué à
 * l'**import** du contrôleur, bien avant que le boot (ou une suite e2e) n'ait posé les variables
 * d'environnement. Figer les nombres ici servirait des seuils fantômes, différents de ceux
 * annoncés au démarrage.
 */
export type RouteThrottleConfig = Record<
  string,
  { limit: () => number; ttl: () => number; blockDuration: () => number }
>;

function routeThrottle(
  identityLimitOf: (options: ThrottlerOptionsResolved) => number,
): RouteThrottleConfig {
  return {
    [THROTTLER_NAMES.ip]: {
      limit: () => resolveThrottlerOptions().ipLimit,
      ttl: () => resolveThrottlerOptions().windowMs,
      blockDuration: () => resolveThrottlerOptions().blockMs,
    },
    [THROTTLER_NAMES.identity]: {
      limit: () => identityLimitOf(resolveThrottlerOptions()),
      ttl: () => resolveThrottlerOptions().windowMs,
      blockDuration: () => resolveThrottlerOptions().blockMs,
    },
  };
}

/**
 * `POST /booking/reservations` — seuil d'identité relevé pour absorber les rejeux idempotents
 * (voir `RESERVATION_REPLAY_FACTOR`), seuil IP inchangé.
 */
export const RESERVATION_THROTTLE = routeThrottle(reservationIdentityLimit);

/**
 * `POST /auth/guest` — seuils nus. Aucun rejeu « gratuit » à absorber ici : une soumission répétée
 * sur le **même** email réutilise la session sans appeler le PMS (AC-10), et un email **différent**
 * est justement ce que le compteur doit freiner (le couple 409/200 forme un oracle d'énumération).
 */
export const GUEST_CHECKOUT_THROTTLE = routeThrottle(
  (options) => options.identityLimit,
);

/** Valeurs symboliques acceptées par Express en plus des IP/CIDR. */
const TRUST_PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * `trust proxy` d'Express — détermine si `req.ip` doit être lu dans `X-Forwarded-For`.
 *
 * ⚠️ Réglage **de sécurité**, pas de confort :
 * - laissé à `false` derrière un reverse-proxy, **toutes** les requêtes partagent l'IP du proxy :
 *   un seul seau pour toute la planète, et le premier abuseur bloque tout le monde ;
 * - mis à `true` sans proxy réel, n'importe qui peut forger `X-Forwarded-For` et **contourner**
 *   entièrement la limite par IP.
 *
 * Il n'y a donc pas de valeur universellement sûre : défaut `false` (dev/local, exposition
 * directe), à activer explicitement lors du déploiement derrière un proxy de confiance. Deux
 * garde-fous complètent ce défaut (revue 2.4) :
 * - une valeur **invalide** échoue au **boot** en nommant `TRUST_PROXY` — sinon `proxy-addr` lève
 *   plus tard un `TypeError: invalid IP address` qui ne désigne aucune variable ;
 * - une valeur **absente en production** produit un log `error` explicite : le silence, ici,
 *   signifie « toute la plateforme dans un seul seau » sur le chemin de conversion.
 */
export function resolveTrustProxy(
  env: NodeJS.ProcessEnv = process.env,
): boolean | number | string {
  const raw = (env.TRUST_PROXY ?? '').trim();

  if (raw === '') {
    if (env.NODE_ENV === 'production') {
      new Logger('TrustProxy').error(
        "TRUST_PROXY n'est pas renseigné : `req.ip` sera lu sur la connexion TCP. Derrière un " +
          "reverse-proxy, TOUTES les requêtes partagent alors l'adresse du proxy — un seul seau de " +
          'limitation pour toute la plateforme, et le premier abuseur bloque tous les voyageurs sur ' +
          'le chemin de conversion. Renseignez TRUST_PROXY (nombre de sauts de confiance, ou liste ' +
          "d'IP/CIDR), ou « false » explicitement si le BFF est exposé en direct.",
      );
    }
    return false;
  }

  const lowered = raw.toLowerCase();
  if (lowered === 'false') {
    return false;
  }
  if (lowered === 'true') {
    return true;
  }
  // Un entier ≥ 0 = nombre de sauts de proxy de confiance.
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  // Sinon, liste d'IP/CIDR (ou mots-clés Express) gérée par `proxy-addr`.
  if (isTrustedProxyList(raw)) {
    return raw;
  }

  throw new Error(
    `TRUST_PROXY (« ${raw} ») est invalide. Valeurs acceptées : « true », « false », un nombre ` +
      `entier de sauts de proxy de confiance (≥ 0), ou une liste d'IP/CIDR séparées par des ` +
      `virgules (ex. « 10.0.0.0/8, 127.0.0.1 », ou « loopback »/« linklocal »/« uniquelocal »).`,
  );
}

/** Liste non vide dont **chaque** entrée est une IP, un CIDR ou un mot-clé Express. */
function isTrustedProxyList(raw: string): boolean {
  const entries = raw.split(',').map((entry) => entry.trim());
  return (
    entries.length > 0 && entries.every((entry) => isTrustedProxyEntry(entry))
  );
}

function isTrustedProxyEntry(entry: string): boolean {
  const value = entry.toLowerCase();
  if (value === '') {
    return false;
  }
  if (TRUST_PROXY_PRESETS.has(value)) {
    return true;
  }

  const slash = value.indexOf('/');
  const address = slash >= 0 ? value.slice(0, slash) : value;
  // `isIP` (node:net) : 4, 6, ou 0 si ce n'est pas une adresse — aucune dépendance nouvelle.
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  if (slash < 0) {
    return true;
  }

  const prefix = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) {
    return false;
  }
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

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
