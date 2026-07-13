import { Transform } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Bloc **filtre/tri partagé** par les deux modes de recherche (FR-3), appliqué **à la fois** à
 * `SearchHotelsQueryDto` (destination) et `SearchNearbyQueryDto` (proximité) via l'héritage.
 *
 * ⚠️ **Pourquoi une base commune ?** Le `ValidationPipe` global est `whitelist:true` +
 * `forbidNonWhitelisted:true` : tout query-param **non déclaré** au DTO renvoie **400** (bug Phase 3
 * de la story 1.7). Ces champs doivent donc figurer sur **les deux** DTO — factorisés ici.
 *
 * ♻️ **Robustesse (AC-7)** : les filtres sont des raffinements **optionnels**. Une valeur douteuse
 * (issue d'une URL éditée à la main) est **normalisée/ignorée** par `@Transform` **avant** validation
 * — jamais un 400. Seuls les critères de base (destination/dates/coords/voyageurs/devise) restent
 * bloquants. La cohérence de bornes (`minPrice > maxPrice`) est gérée côté service.
 */
export const SORT_OPTIONS = ['price_asc', 'price_desc', 'distance'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

/** Cardinalité max d'un filtre multi-valeurs et longueur max d'un token (anti-abus URL). */
export const MAX_FILTER_VALUES = 20;
export const MAX_TOKEN_LENGTH = 40;

/** Marques diacritiques combinantes (U+0300–U+036F) supprimées après décomposition NFD. */
const DIACRITICS = /[̀-ͯ]/g;

/**
 * Normalise un libellé texte libre pour comparaison **insensible casse + accents** (Décision 4).
 * `hotel.category` et `room.amenities` sont des chaînes PMS non structurées → on compare toujours
 * des formes normalisées des deux côtés.
 */
export function normalizeToken(value: string): string {
  return value.trim().toLowerCase().normalize('NFD').replace(DIACRITICS, '');
}

/** Découpe un champ `amenities` PMS (texte libre) en tokens normalisés (séparateurs `, ; /`). */
export function tokenizeAmenities(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[,;/]/)
    .map((part) => normalizeToken(part))
    .filter((token) => token.length > 0);
}

/**
 * Sanitize un filtre multi-valeurs : accepte les params **répétés** (`category=a&category=b`), trim,
 * borne la longueur/cardinalité, dé-duplique **par forme normalisée** en conservant la forme
 * d'affichage d'origine. Renvoie `undefined` si vide (⇒ « pas de filtre »).
 *
 * `splitCsv` : découpe en plus chaque valeur sur `,` (confort d'URL tapée à la main). **Interdit
 * pour la catégorie** (texte libre PMS pouvant contenir une virgule, ex. « Boutique, Luxury » →
 * corruption au round-trip) ; autorisé pour les équipements (tokens sans virgule).
 */
function sanitizeStringArray(
  value: unknown,
  splitCsv: boolean,
): string[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  const parts = splitCsv
    ? raw.flatMap((item) => String(item).split(','))
    : raw.map((item) => String(item));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TOKEN_LENGTH) {
      continue;
    }
    const key = normalizeToken(trimmed);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_FILTER_VALUES) {
      return out;
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Entier ≥ 0 (cents), sinon `undefined`. Un blanc (`' '`) est ignoré (et non coercé en `0`). */
function sanitizeNonNegativeInt(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return undefined; // `' '`/`''` → ignoré (évite `Number(' ')===0`)
  }
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Capacité entière dans `[1, 30]` (mêmes bornes que `guests`), sinon `undefined`. */
function sanitizeCapacity(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : undefined;
}

/** Option de tri connue, sinon `undefined` (retombe sur le défaut du mode). */
function sanitizeSort(value: unknown): SortOption | undefined {
  return typeof value === 'string' &&
    (SORT_OPTIONS as readonly string[]).includes(value)
    ? (value as SortOption)
    : undefined;
}

export class SearchFiltersQueryDto {
  /** Tri : `price_asc` | `price_desc` | `distance`. `distance` = no-op en mode destination. */
  @IsOptional()
  @Transform(({ value }) => sanitizeSort(value))
  @IsIn(SORT_OPTIONS)
  sort?: SortOption;

  /** Fourchette de prix (cents entiers, sur le **total du séjour**, devise de travail). */
  @IsOptional()
  @Transform(({ value }) => sanitizeNonNegativeInt(value))
  @IsInt()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @Transform(({ value }) => sanitizeNonNegativeInt(value))
  @IsInt()
  @Min(0)
  maxPrice?: number;

  /** Capacité minimale — resserre `MinCapacity` du fan-out (`max(guests, minCapacity)`). */
  @IsOptional()
  @Transform(({ value }) => sanitizeCapacity(value))
  @IsInt()
  @Min(1)
  @Max(30)
  minCapacity?: number;

  /** Catégories d'hôtel (texte libre PMS ; match exact normalisé, OU logique ; PAS de split CSV). */
  @IsOptional()
  @Transform(({ value }) => sanitizeStringArray(value, false))
  @IsArray()
  @IsString({ each: true })
  category?: string[];

  /** Équipements de chambre (repli D9 ; tokens, ET logique : ≥ 1 chambre porte TOUS les tokens). */
  @IsOptional()
  @Transform(({ value }) => sanitizeStringArray(value, true))
  @IsArray()
  @IsString({ each: true })
  amenities?: string[];
}
