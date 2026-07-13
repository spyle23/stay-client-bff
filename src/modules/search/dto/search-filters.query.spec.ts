import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  normalizeToken,
  tokenizeAmenities,
  SearchFiltersQueryDto,
} from './search-filters.query';

describe('search-filters — normalisation (Décision 4)', () => {
  it('normalizeToken : insensible casse + accents', () => {
    expect(normalizeToken('  Boutiqué ')).toBe('boutique');
    expect(normalizeToken('4-STAR')).toBe('4-star');
  });

  it('tokenizeAmenities : découpe sur , ; / et normalise', () => {
    expect(tokenizeAmenities('WiFi, Parking ; Piscine/Spa')).toEqual([
      'wifi',
      'parking',
      'piscine',
      'spa',
    ]);
    expect(tokenizeAmenities(null)).toEqual([]);
    expect(tokenizeAmenities('')).toEqual([]);
  });
});

/** Instancie le DTO comme le fait le `ValidationPipe` (transform:true), puis valide. */
async function parse(raw: Record<string, unknown>) {
  const dto = plainToInstance(SearchFiltersQueryDto, raw);
  const errors = await validate(dto);
  return { dto, errors };
}

describe('SearchFiltersQueryDto — transforms (robustesse AC-7)', () => {
  it('sort inconnu → undefined (jamais une erreur)', async () => {
    const { dto, errors } = await parse({ sort: 'lol' });
    expect(errors).toHaveLength(0);
    expect(dto.sort).toBeUndefined();
  });

  it('sort connu conservé', async () => {
    const { dto, errors } = await parse({ sort: 'price_desc' });
    expect(errors).toHaveLength(0);
    expect(dto.sort).toBe('price_desc');
  });

  it('minPrice négatif/non-entier → ignoré (undefined)', async () => {
    expect((await parse({ minPrice: '-5' })).dto.minPrice).toBeUndefined();
    expect((await parse({ minPrice: 'abc' })).dto.minPrice).toBeUndefined();
    expect((await parse({ minPrice: '12000' })).dto.minPrice).toBe(12000);
  });

  it('minCapacity hors [1,30] → ignoré', async () => {
    expect(
      (await parse({ minCapacity: '99' })).dto.minCapacity,
    ).toBeUndefined();
    expect((await parse({ minCapacity: '4' })).dto.minCapacity).toBe(4);
  });

  it('catégorie : params répétés dé-dupliqués, PAS de split CSV (virgule préservée)', async () => {
    // Répété + doublon normalisé (4-STAR == 4-star) → une seule occurrence.
    expect(
      (await parse({ category: ['4-star', 'Boutique', '4-STAR'] })).dto
        .category,
    ).toEqual(['4-star', 'Boutique']);
    // Une catégorie contenant une virgule (texte libre PMS) N'EST PAS scindée.
    expect(
      (await parse({ category: 'Boutique, Luxury' })).dto.category,
    ).toEqual(['Boutique, Luxury']);
    // Vide → undefined (pas de filtre).
    expect((await parse({ category: '' })).dto.category).toBeUndefined();
  });

  it('équipements : CSV et répété → tableau trimé, dé-dupliqué (casse-insensible)', async () => {
    expect((await parse({ amenities: 'WiFi, Parking' })).dto.amenities).toEqual(
      ['WiFi', 'Parking'],
    );
    // Répété + doublon normalisé (WiFi == wifi) → une seule occurrence.
    expect(
      (await parse({ amenities: ['WiFi', 'wifi', ' '] })).dto.amenities,
    ).toEqual(['WiFi']);
  });
});
