import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CorrelationService } from '../../common/correlation/correlation.service';
import {
  type PmsRequestContext,
  PmsClientService,
} from '../../integration/pms/pms-client.service';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import { RedisService } from '../../redis/redis.service';
import type { components } from '../../types/generated/pms';
import { SEARCH_OPTIONS, type SearchOptions } from './search.constants';
import { parseDateOnlyUtc } from './dto/date-validators';
import type { HotelAvailabilityDto } from './dto/hotel-availability.dto';
import type { SearchHotelsQueryDto } from './dto/search-hotels.query.dto';
import type { SearchNearbyQueryDto } from './dto/search-nearby.query.dto';

type PmsHotel = components['schemas']['HotelDto'];
type PmsHotelWithDistance = components['schemas']['HotelWithDistanceDto'];
type PmsRoom = components['schemas']['RoomDto'];

export interface SearchHotelsResult {
  items: HotelAvailabilityDto[];
  page: number;
  pageSize: number;
  totalCount: number;
}

/** Critères datés partagés par les deux modes (destination et proximité). */
type FanoutQuery = Pick<
  SearchHotelsQueryDto,
  'checkInDate' | 'checkOutDate' | 'guests' | 'currency' | 'page' | 'pageSize'
>;

/** Hôtel candidat au fan-out + sa distance éventuelle (mode proximité uniquement). */
interface Candidate {
  hotel: PmsHotel;
  distanceKm: number | null;
}

interface AvailableOutcome {
  kind: 'available';
  dto: HotelAvailabilityDto;
}
type Outcome = AvailableOutcome | { kind: 'empty' } | { kind: 'failed' };

const CACHE_PREFIX = 'search:hotels:v1:';
const NEARBY_CACHE_PREFIX = 'search:nearby:v1:';
const MS_PER_DAY = 86_400_000;

/**
 * Orchestration de la recherche multi-hôtels (FR-1/FR-2/FR-4). Tant que l'endpoint agrégé PMS
 * (D1) n'est pas livré : **fan-out borné** + **cache Redis TTL court** + **segmentation devise** +
 * agrégation « à partir de » (min dispo).
 *
 * Deux modes partageant le **même** fan-out daté (`runFanout`) :
 * - **destination** (`searchHotels`) : candidats via `Hotels/search` (recherche texte).
 * - **proximité** (`searchNearby`, FR-2) : candidats via `Hotels/nearby` (distance/tri/rayon calculés
 *   côté PMS), résultats **triés par distance croissante** et portant `distanceKm`.
 *
 * Le PMS reste la source de vérité : lecture seule, endpoints publics, aucune persistance durable.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly pms: PmsClientService,
    private readonly redis: RedisService,
    private readonly correlation: CorrelationService,
    @Inject(SEARCH_OPTIONS) private readonly options: SearchOptions,
  ) {}

  /** Recherche par destination (FR-1) — candidats via la recherche texte du PMS. */
  async searchHotels(query: SearchHotelsQueryDto): Promise<SearchHotelsResult> {
    const nights = this.resolveNights(query);

    const cacheKey = this.cacheKey(query);
    const cached = await this.readCache(cacheKey);
    if (cached) {
      return cached;
    }

    const ctx = this.pmsContext();

    // 1) Candidats par destination, segmentés par devise de travail, bornés au plafond.
    const candidatesRes = await this.pms.getList<PmsHotel>(
      `/Hotels/search?${this.hotelQuery(query)}`,
      ctx,
    );
    const candidates = this.toCandidates(candidatesRes.data, query.currency);

    const result = await this.runFanout(candidates, query, nights, ctx, false);
    await this.writeCache(cacheKey, result);
    return result;
  }

  /** Recherche « à proximité » (FR-2) — candidats via `Hotels/nearby` (distance PMS), triés distance. */
  async searchNearby(query: SearchNearbyQueryDto): Promise<SearchHotelsResult> {
    const nights = this.resolveNights(query);
    const radiusKm = this.resolveRadiusKm(query.radiusKm);
    // Arrondi UNIQUE des coordonnées (~3 déc. ≈ 110 m) : appliqué à l'appel PMS ET à la clé de
    // cache. Confidentialité (Décision 5, NFR-5) même pour un appelant haute précision + cohérence
    // (la clé de cache reflète exactement les coords envoyées au PMS).
    const latitude = roundCoord(query.latitude);
    const longitude = roundCoord(query.longitude);

    const cacheKey = this.nearbyCacheKey(query, latitude, longitude, radiusKm);
    const cached = await this.readCache(cacheKey);
    if (cached) {
      return cached;
    }

    const ctx = this.pmsContext();

    // 1) Candidats par proximité — le PMS filtre par rayon, trie par distance et renvoie `distanceKm`.
    //    Segmentation devise stricte + plafond de fan-out, comme la recherche par destination.
    const candidatesRes = await this.pms.getList<PmsHotelWithDistance>(
      `/Hotels/nearby?${this.nearbyQuery(latitude, longitude, radiusKm)}`,
      ctx,
    );
    const candidates = this.toCandidates(candidatesRes.data, query.currency);

    // Tri distance croissant appliqué APRÈS le fan-out (défensif : prépare la bascule D1 dont
    // l'ordre n'est pas garanti, et re-trie après exclusion des indisponibles).
    const result = await this.runFanout(candidates, query, nights, ctx, true);
    await this.writeCache(cacheKey, result);
    return result;
  }

  /** Segmente STRICTEMENT par devise (pas de repli EUR), borne au plafond, porte la distance. */
  private toCandidates(
    data: (PmsHotel & { distanceKm?: number })[] | null | undefined,
    currency: string,
  ): Candidate[] {
    return (data ?? [])
      .filter((hotel) => hotel.currency === currency)
      .slice(0, this.options.maxHotels)
      .map((hotel) => ({
        hotel,
        // Distance valide = nombre fini ≥ 0. Une valeur négative/NaN (donnée PMS erronée) est
        // écartée (→ null) : jamais « à -5 km » ni un tri « le plus proche » aberrant (symétrique
        // à la garde `price > 0`).
        distanceKm:
          typeof hotel.distanceKm === 'number' &&
          Number.isFinite(hotel.distanceKm) &&
          hotel.distanceKm >= 0
            ? hotel.distanceKm
            : null,
      }));
  }

  /**
   * Fan-out borné partagé : disponibilité par hôtel candidat, garde de dégradation, tri
   * optionnel par distance, pagination de l'ensemble agrégé disponible.
   */
  private async runFanout(
    candidates: Candidate[],
    query: FanoutQuery,
    nights: number,
    ctx: PmsRequestContext | undefined,
    sortByDistance: boolean,
  ): Promise<SearchHotelsResult> {
    const outcomes = await mapWithConcurrency(
      candidates,
      this.options.concurrency,
      (candidate) => this.availabilityFor(candidate, query, nights, ctx),
    );

    const available = outcomes
      .filter((o): o is AvailableOutcome => o.kind === 'available')
      .map((o) => o.dto);

    // Dégradation : des candidats existent, AUCUN résultat disponible, ET au moins un appel de
    // dispo a échoué (panne/timeout/5xx = `failed`) → 503. On ne présente JAMAIS une panne comme
    // « 0 résultat » (NFR-10/AC-4). Un candidat légitimement vide (`empty`) ou un 4xx métier
    // (mappé en `empty`), ou 0 candidat (rayon vide), ne déclenche pas la dégradation.
    const failed = outcomes.filter((o) => o.kind === 'failed').length;
    if (candidates.length > 0 && available.length === 0 && failed > 0) {
      throw new PmsUnavailableError(
        'Le PMS est indisponible : recherche impossible pour le moment.',
      );
    }

    if (sortByDistance) {
      available.sort((a, b) => {
        const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
        const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
        // `da === db ? 0` évite `Infinity - Infinity = NaN` (deux distances nulles) : un
        // comparateur renvoyant NaN laisse le tri dans un ordre indéterminé.
        return da === db ? 0 : da - db;
      });
    }

    const totalCount = available.length;
    const start = (query.page - 1) * query.pageSize;
    const items = available.slice(start, start + query.pageSize);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      totalCount,
    };
  }

  private async availabilityFor(
    candidate: Candidate,
    query: FanoutQuery,
    nights: number,
    ctx: PmsRequestContext | undefined,
  ): Promise<Outcome> {
    const hotel = candidate.hotel;
    if (!hotel.id) {
      return { kind: 'empty' };
    }
    try {
      const roomsRes = await this.pms.getList<PmsRoom>(
        `/Rooms/hotel/${hotel.id}/available?${this.roomQuery(query)}`,
        ctx,
      );
      const rooms = roomsRes.data ?? [];
      const count = roomsRes.pagination?.totalCount ?? rooms.length;
      // Prix strictement positif : un prix 0/négatif (erreur de saisie PMS) ne doit jamais
      // devenir un « à partir de 0 € »/négatif.
      const prices = rooms
        .map((room) => room.price)
        .filter(
          (p): p is number =>
            typeof p === 'number' && Number.isFinite(p) && p > 0,
        );
      if (count <= 0 || prices.length === 0) {
        return { kind: 'empty' };
      }
      const minPerNight = Math.min(...prices);
      return {
        kind: 'available',
        dto: toAvailabilityDto(
          hotel,
          minPerNight,
          nights,
          count,
          query.currency,
          candidate.distanceKm,
        ),
      };
    } catch (err) {
      // 4xx métier (hôtel/param) → exclu SANS compter comme panne (`empty`) ; panne réseau/
      // timeout/5xx (`PmsUnavailableError`) → `failed`, ce qui alimente la garde de dégradation.
      this.logger.warn(
        `Disponibilité indéterminée pour l'hôtel ${hotel.id} — exclu des résultats.`,
      );
      return err instanceof PmsRequestError
        ? { kind: 'empty' }
        : { kind: 'failed' };
    }
  }

  private resolveNights(query: FanoutQuery): number {
    const checkIn = parseDateOnlyUtc(query.checkInDate);
    const checkOut = parseDateOnlyUtc(query.checkOutDate);
    // Garde défensive : le ValidationPipe a déjà rejeté ces cas (aucun appel PMS possible ici).
    if (checkIn === null || checkOut === null || checkOut <= checkIn) {
      throw new PmsUnavailableError('Plage de dates invalide.');
    }
    return Math.round((checkOut - checkIn) / MS_PER_DAY);
  }

  /** Rayon effectif : défaut si absent/≤ 0, borné au rayon maximal configuré. */
  private resolveRadiusKm(radiusKm: number | undefined): number {
    const requested =
      typeof radiusKm === 'number' && Number.isFinite(radiusKm) && radiusKm > 0
        ? radiusKm
        : this.options.nearbyDefaultRadiusKm;
    return Math.min(requested, this.options.nearbyMaxRadiusKm);
  }

  private pmsContext(): PmsRequestContext | undefined {
    const correlationId = this.correlation.getCorrelationId();
    return correlationId ? { correlationId } : undefined;
  }

  private hotelQuery(query: SearchHotelsQueryDto): string {
    const params = new URLSearchParams();
    params.set('Search', query.destination);
    params.set('PageSize', String(this.options.maxHotels));
    return params.toString();
  }

  private nearbyQuery(
    latitude: number,
    longitude: number,
    radiusKm: number,
  ): string {
    const params = new URLSearchParams();
    params.set('Latitude', String(latitude));
    params.set('Longitude', String(longitude));
    params.set('RadiusKm', String(radiusKm));
    params.set('MaxResults', String(this.options.nearbyMaxResults));
    return params.toString();
  }

  private roomQuery(query: FanoutQuery): string {
    const params = new URLSearchParams();
    // Dates ancrées en UTC (`…T00:00:00Z`) : le PMS lie ce param en `DateTime` et une date-only
    // arrive en `Kind=Unspecified`, rejetée par Npgsql sur les colonnes `timestamptz` (→ 500).
    params.set('CheckInDate', toPmsUtcDateTime(query.checkInDate));
    params.set('CheckOutDate', toPmsUtcDateTime(query.checkOutDate));
    params.set('MinCapacity', String(query.guests));
    params.set('PageSize', '100');
    return params.toString();
  }

  private cacheKey(query: SearchHotelsQueryDto): string {
    const normalized = JSON.stringify({
      destination: query.destination.trim().toLowerCase(),
      checkInDate: query.checkInDate,
      checkOutDate: query.checkOutDate,
      guests: query.guests,
      currency: query.currency,
      page: query.page,
      pageSize: query.pageSize,
    });
    return CACHE_PREFIX + createHash('sha1').update(normalized).digest('hex');
  }

  private nearbyCacheKey(
    query: SearchNearbyQueryDto,
    latitude: number,
    longitude: number,
    radiusKm: number,
  ): string {
    // Coordonnées déjà arrondies (~3 décimales ≈ 110 m) par `searchNearby` : la clé reflète
    // EXACTEMENT les coords envoyées au PMS (pas d'écart clé↔requête).
    const normalized = JSON.stringify({
      latitude,
      longitude,
      radiusKm,
      checkInDate: query.checkInDate,
      checkOutDate: query.checkOutDate,
      guests: query.guests,
      currency: query.currency,
      page: query.page,
      pageSize: query.pageSize,
    });
    return (
      NEARBY_CACHE_PREFIX + createHash('sha1').update(normalized).digest('hex')
    );
  }

  private async readCache(key: string): Promise<SearchHotelsResult | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as SearchHotelsResult) : null;
    } catch {
      // Cache best-effort : une panne Redis ne casse jamais la recherche.
      return null;
    }
  }

  private async writeCache(
    key: string,
    value: SearchHotelsResult,
  ): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify(value),
        this.options.cacheTtlSeconds,
      );
    } catch {
      // best-effort
    }
  }
}

/** Ancre une date-only `AAAA-MM-JJ` en datetime UTC pour la liaison `DateTime` du PMS. */
function toPmsUtcDateTime(dateOnly: string): string {
  return `${dateOnly}T00:00:00Z`;
}

/** Arrondit une coordonnée à ~3 décimales (≈ 110 m) — confidentialité de la position (NFR-5). */
function roundCoord(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Convertit un hôtel PMS + prix min décimal en DTO de sortie (montants en cents). */
function toAvailabilityDto(
  hotel: PmsHotel,
  minPerNightDecimal: number,
  nights: number,
  availableRoomCount: number,
  fallbackCurrency: string,
  distanceKm: number | null,
): HotelAvailabilityDto {
  return {
    hotelId: hotel.id ?? '',
    name: hotel.name ?? null,
    city: hotel.city ?? null,
    country: hotel.country ?? null,
    category: hotel.category ?? null,
    currency: hotel.currency ?? fallbackCurrency,
    fromPricePerNight: Math.round(minPerNightDecimal * 100),
    fromTotalPrice: Math.round(minPerNightDecimal * nights * 100),
    nights,
    availableRoomCount,
    thumbnailUrl: hotel.logoUrl ?? null,
    latitude: hotel.latitude ?? null,
    longitude: hotel.longitude ?? null,
    distanceKm,
  };
}

/** Exécute `worker` sur chaque item avec un parallélisme borné, en préservant l'ordre. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const poolSize = Math.max(1, Math.min(limit, items.length));
  const runners: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i++) {
    runners.push(
      (async () => {
        let index = cursor++;
        while (index < items.length) {
          results[index] = await worker(items[index]);
          index = cursor++;
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}
