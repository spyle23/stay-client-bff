/**
 * Paramètres du module `booking` (tunnel de réservation, story 2.2 — FR-7) — **bornés et
 * documentés** (`.env.example`). Patron `resolveCatalogOptions` / `resolveAuthOptions` : fonction
 * pure testable, jamais de lecture d'env dispersée dans les services.
 *
 * Le module n'a **pas** de cache propre (Décision 2 de la story) : le devis délègue à
 * `CatalogService.getRoomDetail`, déjà caché et déjà protégé contre la mise en cache d'une réponse
 * dégradée. Deux caches produiraient deux vérités de prix.
 */

export interface BookingOptions {
  /**
   * Durée maximale d'un séjour (nuits). Au-delà, le devis est refusé (400) plutôt que de produire
   * un total aberrant — miroir de `CATALOG_MAX_STAY_NIGHTS`, qui écarte silencieusement le
   * contexte de dates côté `catalog`.
   */
  maxStayNights: number;
}

export const BOOKING_OPTIONS = 'BOOKING_OPTIONS';

export function resolveBookingOptions(
  env: NodeJS.ProcessEnv = process.env,
): BookingOptions {
  return {
    maxStayNights: bounded(env.BOOKING_MAX_STAY_NIGHTS, 90, 1, 365),
  };
}

/**
 * Entier borné dans `[min, max]`, sinon `fallback` si non parsable.
 *
 * ⚠️ La **normalisation en entier** est essentielle : une valeur fractionnaire passe `Number()`,
 * franchit les bornes, puis casse plus bas (arithmétique de nuits, expiration Redis rejetée par
 * `EXPIRE`). Borner sans normaliser est une validation en trompe-l'œil (cf. `catalog.constants.ts`).
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
