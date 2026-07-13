/**
 * Paramètres du module `catalog` (page hôtel publique, story 1.9) — **bornés et documentés**
 * (`.env.example`). Aucune valeur n'est imposée par les docs de planning : ces défauts sont la
 * décision de la story.
 */
export interface CatalogOptions {
  /** TTL du cache Redis du détail hôtel + chambres (secondes ; jamais 0 → pas de vérité durable). */
  cacheTtlSeconds: number;
  /** Plafond de chambres sondées pour composer la galerie (borne le fan-out d'images). */
  galleryMaxRooms: number;
  /** Parallélisme maximal des appels d'images de chambre (borne la charge PMS et le TTFB SSR). */
  galleryConcurrency: number;
  /** Durée maximale d'un séjour (nuits) — au-delà, le contexte de dates est ignoré (repli prix/nuit). */
  maxStayNights: number;
}

export const CATALOG_OPTIONS = 'CATALOG_OPTIONS';

export function resolveCatalogOptions(
  env: NodeJS.ProcessEnv = process.env,
): CatalogOptions {
  return {
    // Min 1 s : jamais 0 (qui écrirait un cache SANS expiration → vérité durable, viole AR-6).
    cacheTtlSeconds: bounded(env.CATALOG_CACHE_TTL_SECONDS, 60, 1, 600),
    // Aligné sur ce que la galerie front rend réellement (héros + 5 vignettes) : ne pas sonder
    // d'images qui ne seront jamais affichées.
    galleryMaxRooms: bounded(env.CATALOG_GALLERY_MAX_ROOMS, 5, 1, 20),
    galleryConcurrency: bounded(env.CATALOG_GALLERY_CONCURRENCY, 4, 1, 10),
    maxStayNights: bounded(env.CATALOG_MAX_STAY_NIGHTS, 90, 1, 365),
  };
}

/**
 * Entier borné dans `[min, max]`, sinon `fallback` si non parsable.
 *
 * ⚠️ La **normalisation en entier** est essentielle : un TTL fractionnaire (`45.5`, typo de
 * déploiement) est rejeté par Redis (`value is not an integer or out of range`), et l'erreur est
 * avalée par le `catch` best-effort d'écriture du cache → **plus aucune écriture, indéfiniment,
 * sans un seul log**. Borner sans normaliser est une validation en trompe-l'œil.
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
