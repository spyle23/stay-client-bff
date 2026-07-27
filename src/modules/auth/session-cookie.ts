import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parse, serialize } from 'cookie';

/**
 * Cookie de session **opaque** (story 2.1 — AR-9 / NFR-8).
 *
 * Le navigateur ne reçoit **jamais** de JWT : seulement `<sid>.<signature>` où
 * - `sid` = 32 octets aléatoires (base64url) — la clé de session en Redis, sans aucune
 *   information métier (opaque : rien à décoder côté navigateur) ;
 * - `signature` = HMAC-SHA256(sid, SESSION_SECRET) — empêche l'énumération/forgeage de `sid`
 *   (sans elle, un attaquant pourrait tenter des identifiants au hasard contre Redis).
 *
 * Fonctions **pures** (aucune dépendance Nest) → testables directement.
 * On s'appuie sur la dépendance `cookie` (déjà installée au scaffold 1.1) plutôt que
 * d'ajouter `cookie-parser` : le BFF n'a besoin de lire/écrire qu'un seul cookie.
 */

/** Séparateur `sid` / signature. Absent de l'alphabet base64url → découpage non ambigu. */
const SEPARATOR = '.';

export interface SessionCookieOptions {
  cookieName: string;
  sessionSecret: string;
  cookieSecure: boolean;
}

/** Identifiant de session : 256 bits d'entropie, encodés base64url (sûr en en-tête HTTP). */
export function generateSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function signSessionId(sid: string, secret: string): string {
  return createHmac('sha256', secret).update(sid).digest('base64url');
}

/** Valeur du cookie : `<sid>.<signature>`. */
export function buildSessionCookieValue(sid: string, secret: string): string {
  return `${sid}${SEPARATOR}${signSessionId(sid, secret)}`;
}

/**
 * Vérifie la signature et renvoie le `sid`, ou `null` si le cookie est absent, malformé
 * ou falsifié. Comparaison **à temps constant** (`timingSafeEqual`) : une comparaison
 * naïve laisserait fuir la signature attendue octet par octet.
 */
export function verifySessionCookieValue(
  value: string | undefined,
  secret: string,
): string | null {
  if (!value) {
    return null;
  }
  // `sid` ne contient jamais de séparateur (base64url) → le dernier point délimite la signature.
  const index = value.lastIndexOf(SEPARATOR);
  if (index <= 0 || index === value.length - 1) {
    return null;
  }
  const sid = value.slice(0, index);
  const provided = Buffer.from(value.slice(index + 1));
  const expected = Buffer.from(signSessionId(sid, secret));
  // `timingSafeEqual` exige des longueurs égales : on les compare d'abord (non secret).
  if (provided.length !== expected.length) {
    return null;
  }
  return timingSafeEqual(provided, expected) ? sid : null;
}

/** Extrait et vérifie le `sid` depuis l'en-tête `Cookie` brut d'une requête entrante. */
export function readSessionId(
  cookieHeader: string | undefined,
  options: SessionCookieOptions,
): string | null {
  if (!cookieHeader) {
    return null;
  }
  const jar = parse(cookieHeader);
  return verifySessionCookieValue(
    jar[options.cookieName],
    options.sessionSecret,
  );
}

/**
 * En-tête `Set-Cookie` de dépôt de session.
 * `HttpOnly` (invisible à JS → pas de vol par XSS), `Secure`, `SameSite=Lax` (le front :3001 et
 * le BFF :4000 partagent le même *site* `localhost` → le cookie accompagne bien les appels),
 * `Path=/` et `Max-Age` aligné sur la durée de vie de la session côté Redis.
 */
export function buildSessionCookie(
  sid: string,
  ttlSeconds: number,
  options: SessionCookieOptions,
): string {
  return serialize(
    options.cookieName,
    buildSessionCookieValue(sid, options.sessionSecret),
    {
      httpOnly: true,
      secure: options.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: ttlSeconds,
    },
  );
}

/** En-tête `Set-Cookie` d'expiration immédiate (déconnexion). */
export function buildClearedSessionCookie(
  options: SessionCookieOptions,
): string {
  return serialize(options.cookieName, '', {
    httpOnly: true,
    secure: options.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
