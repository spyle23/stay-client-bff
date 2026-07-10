/**
 * Paramètres du repli fan-out (D1 non livré) — **bornés et documentés** (AC-3, `.env.example`).
 * Aucune valeur n'est imposée par les docs de planning : ces défauts sont la décision de la story.
 */
export interface SearchOptions {
  /** Plafond d'hôtels candidats sondés par recherche (borne le fan-out). */
  maxHotels: number;
  /** Parallélisme maximal des appels de disponibilité par hôtel. */
  concurrency: number;
  /** TTL du cache Redis des résultats (secondes ; 0 = pas d'expiration). */
  cacheTtlSeconds: number;
  /** Rayon par défaut (km) de la recherche « à proximité » (défaut PMS = 10). */
  nearbyDefaultRadiusKm: number;
  /** Rayon maximal (km) accepté pour la recherche « à proximité » (clamp du param URL). */
  nearbyMaxRadiusKm: number;
  /** Plafond de candidats demandés au PMS `/Hotels/nearby` (`MaxResults`). */
  nearbyMaxResults: number;
}

export const SEARCH_OPTIONS = 'SEARCH_OPTIONS';

export function resolveSearchOptions(
  env: NodeJS.ProcessEnv = process.env,
): SearchOptions {
  const maxHotels = bounded(env.SEARCH_FANOUT_MAX_HOTELS, 25, 1, 100);
  const nearbyMaxRadiusKm = bounded(
    env.SEARCH_NEARBY_MAX_RADIUS_KM,
    100,
    1,
    1000,
  );
  return {
    maxHotels,
    concurrency: bounded(env.SEARCH_FANOUT_CONCURRENCY, 6, 1, 50),
    // Min 1 s : jamais 0 (qui écrirait un cache SANS expiration → vérité durable, viole AR-6/AC-7).
    cacheTtlSeconds: bounded(env.SEARCH_CACHE_TTL_SECONDS, 45, 1, 600),
    nearbyMaxRadiusKm,
    // Défaut borné au rayon max (un défaut > max n'aurait aucun sens).
    nearbyDefaultRadiusKm: bounded(
      env.SEARCH_NEARBY_DEFAULT_RADIUS_KM,
      10,
      1,
      nearbyMaxRadiusKm,
    ),
    // Par défaut = plafond de fan-out : on ne sonde jamais plus d'hôtels que le fan-out n'en traite.
    nearbyMaxResults: bounded(env.SEARCH_NEARBY_MAX_RESULTS, maxHotels, 1, 100),
  };
}

/** Nombre borné dans `[min, max]`, sinon `fallback` si non parsable. */
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
  return Math.min(Math.max(n, min), max);
}
