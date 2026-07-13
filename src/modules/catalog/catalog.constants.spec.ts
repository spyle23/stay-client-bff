import { resolveCatalogOptions } from './catalog.constants';

describe('resolveCatalogOptions', () => {
  it('applique les défauts documentés', () => {
    const options = resolveCatalogOptions({});
    expect(options.cacheTtlSeconds).toBe(60);
    expect(options.galleryMaxRooms).toBe(5);
    expect(options.galleryConcurrency).toBe(4);
    expect(options.maxStayNights).toBe(90);
  });

  /**
   * Revue : un TTL fractionnaire est rejeté par Redis (`value is not an integer`) et l'erreur est
   * best-effort → le cache mourrait **silencieusement**. Toute option doit être un entier.
   */
  it('normalise en entier (un TTL fractionnaire tuerait le cache silencieusement)', () => {
    const options = resolveCatalogOptions({
      CATALOG_CACHE_TTL_SECONDS: '45.5',
      CATALOG_GALLERY_MAX_ROOMS: '3.9',
    });
    expect(options.cacheTtlSeconds).toBe(45);
    expect(Number.isInteger(options.cacheTtlSeconds)).toBe(true);
    expect(options.galleryMaxRooms).toBe(3);
    expect(Number.isInteger(options.galleryMaxRooms)).toBe(true);
  });

  it('borne les valeurs hors plage et ignore les valeurs non parsables', () => {
    expect(
      resolveCatalogOptions({ CATALOG_CACHE_TTL_SECONDS: '0' }).cacheTtlSeconds,
    ).toBe(1);
    expect(
      resolveCatalogOptions({ CATALOG_CACHE_TTL_SECONDS: '99999' })
        .cacheTtlSeconds,
    ).toBe(600);
    expect(
      resolveCatalogOptions({ CATALOG_CACHE_TTL_SECONDS: 'abc' })
        .cacheTtlSeconds,
    ).toBe(60);
  });
});
