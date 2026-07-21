import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { toMinorUnits } from '../../common/money/minor-units';
import { CorrelationService } from '../../common/correlation/correlation.service';
import {
  type PmsRequestContext,
  PmsClientService,
} from '../../integration/pms/pms-client.service';
import { PmsRequestError } from '../../integration/pms/pms-errors';
import { RedisService } from '../../redis/redis.service';
import type { components } from '../../types/generated/pms';
import {
  parseDateOnlyUtc,
  todayUtcMidnight,
} from '../search/dto/date-validators';
import { CATALOG_OPTIONS, type CatalogOptions } from './catalog.constants';
import type { HotelDetailDto, HotelGalleryImage } from './dto/hotel-detail.dto';
import type { HotelDetailQueryDto } from './dto/hotel-detail.query.dto';
import type { HotelRoomDto } from './dto/hotel-room.dto';
import type {
  RoomDetailDto,
  RoomIncludedService,
  RoomPhoto,
} from './dto/room-detail.dto';

type PmsHotel = components['schemas']['HotelDto'];
type PmsRoom = components['schemas']['RoomDto'];
type PmsRoomImage = components['schemas']['RoomImageDto'];
type PmsRoomIncludedService = components['schemas']['RoomIncludedServiceDto'];

const CACHE_PREFIX = 'catalog:hotel:v1:';
/** La galerie est cachée **par hôtel** (indépendante des dates) → partagée par toutes les vues. */
const GALLERY_CACHE_PREFIX = 'catalog:gallery:v1:';
/** Cache de la fiche chambre (story 1.10) — clé par (hôtel, chambre, dates, voyageurs). */
const ROOM_CACHE_PREFIX = 'catalog:room:v1:';
const MS_PER_DAY = 86_400_000;
/** Devise par défaut du PMS quand un hôtel n'en porte pas (Stay-api : `Hotel.Currency` défaut EUR). */
const DEFAULT_CURRENCY = 'EUR';
/** `RoomStatus.Available` (Stay-api : Available=1, Occupied=2, Maintenance=3, Cleaning=4, OutOfService=5). */
const ROOM_STATUS_AVAILABLE = 1;

/** Dates de séjour normalisées (présentes, valides, ordonnées, non passées et bornées), sinon `null`. */
interface StayDates {
  checkInDate: string;
  checkOutDate: string;
  nights: number;
}

/**
 * Domaine `catalog` (story 1.9, FR-5) — **page hôtel publique**. Agrège, depuis les endpoints
 * **publics** du PMS, le détail d'un hôtel, ses chambres (disponibles pour les dates en contexte,
 * ou chambres `Available` si aucune date) et une **galerie composée** (le PMS n'a pas de galerie
 * d'hôtel : logo + images primaires des chambres). Cache Redis TTL court, résilience héritée de
 * `PmsClientService`.
 *
 * Le PMS reste la source de vérité : lecture seule, endpoints publics, aucune persistance durable.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly pms: PmsClientService,
    private readonly redis: RedisService,
    private readonly correlation: CorrelationService,
    @Inject(CATALOG_OPTIONS) private readonly options: CatalogOptions,
  ) {}

  /**
   * Détail hôtel + chambres + galerie. Propage une `PmsRequestError` 404 (hôtel introuvable → 404
   * côté front) et une `PmsUnavailableError` si le PMS est injoignable **pour le détail** (503,
   * page indisponible). Une panne **sur les chambres** ne casse PAS la page : `roomsUnavailable`.
   */
  async getHotelDetail(
    id: string,
    query: HotelDetailQueryDto,
  ): Promise<HotelDetailDto> {
    const stay = this.resolveStayDates(query);

    const cacheKey = this.cacheKey(id, stay, query.guests);
    const cached = await this.readCache<HotelDetailDto>(cacheKey);
    if (cached) {
      return cached;
    }

    const ctx = this.pmsContext();

    // Détail hôtel (public). 404 → PmsRequestError(404) propagée ; panne → PmsUnavailableError (503).
    const hotelRes = await this.pms.get<PmsHotel>(`/Hotels/${id}`, ctx);
    const hotel = hotelRes.data;
    if (!hotel || !hotel.id) {
      // Corps 200 sans données (ne devrait pas arriver) → traité comme introuvable.
      throw new PmsRequestError('Hôtel introuvable.', 404);
    }

    // Devise résolue **une seule fois** : l'hôtel et ses chambres portent la MÊME devise (jamais
    // `null` d'un côté et une devise fabriquée de l'autre).
    const currency = hotel.currency ?? DEFAULT_CURRENCY;

    const { rooms, roomsUnavailable } = await this.fetchRooms(
      id,
      stay,
      query.guests,
      currency,
      ctx,
    );
    const gallery = await this.galleryFor(hotel, ctx);

    const dto = this.toHotelDetailDto(
      hotel,
      currency,
      rooms,
      gallery,
      stay,
      roomsUnavailable,
    );

    // Ne JAMAIS cacher une réponse dégradée : sinon un timeout PMS d'une seconde fige
    // « chambres indisponibles » pour tous les visiteurs pendant tout le TTL.
    if (!roomsUnavailable) {
      await this.writeCache(cacheKey, dto);
    }
    return dto;
  }

  /**
   * Détail d'une **seule** chambre (story 1.10, FR-6) pour la fiche publique. Composé depuis des
   * endpoints **publics** du PMS : hôtel (devise + nom/ville), liste NON datée des chambres (trouve
   * la chambre même indisponible, porte description/équipements/services inclus), set daté
   * `/available` (cross-check de disponibilité), images.
   *
   * Propage une `PmsRequestError` 404 (hôtel ou chambre introuvable → 404 côté front) et une panne
   * PMS **sur l'hôtel ou la liste des chambres** (la fiche ne peut rien afficher → 503, page
   * dégradée). Une panne **sur la disponibilité datée** ne casse PAS la fiche (`availabilityDegraded`)
   * et une panne **sur les images** est best-effort (galerie vide).
   */
  async getRoomDetail(
    hotelId: string,
    roomId: string,
    query: HotelDetailQueryDto,
  ): Promise<RoomDetailDto> {
    const stay = this.resolveStayDates(query);

    const cacheKey = this.roomCacheKey(hotelId, roomId, stay, query.guests);
    const cached = await this.readCache<RoomDetailDto>(cacheKey);
    if (cached) {
      return cached;
    }

    const ctx = this.pmsContext();

    // Hôtel (public) : devise + nom/ville. 404 → chambre inatteignable → 404 ; panne → 503.
    const hotelRes = await this.pms.get<PmsHotel>(`/Hotels/${hotelId}`, ctx);
    const hotel = hotelRes.data;
    if (!hotel || !hotel.id) {
      throw new PmsRequestError('Hôtel introuvable.', 404);
    }
    const currency = hotel.currency ?? DEFAULT_CURRENCY;

    // La chambre depuis la liste NON datée (présente même quand indisponible). Une chambre absente
    // = 404 ; une panne (non-404) sur cette liste = dégradation de page (rethrow → 503).
    const room = await this.findRoom(hotelId, roomId, ctx);
    if (!room) {
      throw new PmsRequestError('Chambre introuvable.', 404);
    }

    const { available, availabilityDegraded } =
      await this.resolveRoomAvailability(
        hotelId,
        roomId,
        room,
        stay,
        query.guests,
        ctx,
      );
    const images = await this.roomPhotos(roomId, ctx);

    const dto = this.toRoomDetailDto(
      hotel,
      room,
      currency,
      stay,
      images,
      available,
      availabilityDegraded,
    );

    // Ne jamais cacher une réponse dégradée : une panne d'`/available` d'une seconde figerait la
    // disponibilité de la chambre pour tous les visiteurs pendant tout le TTL.
    if (!availabilityDegraded) {
      await this.writeCache(cacheKey, dto);
    }
    return dto;
  }

  /**
   * Trouve la chambre par id dans la liste **non datée** de l'hôtel (`/Rooms/hotel/{id}`), qui
   * inclut TOUTES les chambres (même indisponibles). Un 404 = l'hôtel n'a pas de chambres → `null`
   * (→ 404 fiche). Toute autre panne est rethrow (dégradation de page).
   *
   * ⚠️ Dette partagée avec 1.9 : `PageSize=100`, `hasNextPage` non lu. Au-delà de 100 chambres, la
   * chambre cible peut être hors page → traitée comme introuvable ; c'est logué pour lever le doute.
   */
  private async findRoom(
    hotelId: string,
    roomId: string,
    ctx: PmsRequestContext | undefined,
  ): Promise<PmsRoom | null> {
    try {
      const res = await this.pms.getList<PmsRoom>(
        `/Rooms/hotel/${hotelId}?PageSize=100`,
        ctx,
      );
      const rooms = res.data ?? [];
      const room = rooms.find((candidate) => candidate.id === roomId) ?? null;
      if (!room) {
        this.logger.warn(
          `Chambre ${roomId} absente de l'hôtel ${hotelId} (${rooms.length} chambre(s) lue(s), PageSize=100).`,
        );
      }
      return room;
    } catch (err) {
      // 404 = hôtel sans chambres → chambre introuvable ; sinon dégradation (rethrow → 503).
      if (err instanceof PmsRequestError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Disponibilité de la chambre pour les dates. **Avec dates** : appartenance au set réellement
   * disponible du PMS (`/available`, qui filtre déjà statut + capacité). **Sans dates** : éligibilité
   * statique (`status = Available` + prix > 0 + capacité). Une panne du cross-check daté **dégrade**
   * (repli éligibilité statique + `availabilityDegraded=true`) — jamais « indisponible ».
   */
  private async resolveRoomAvailability(
    hotelId: string,
    roomId: string,
    room: PmsRoom,
    stay: StayDates | null,
    guests: number | undefined,
    ctx: PmsRequestContext | undefined,
  ): Promise<{ available: boolean; availabilityDegraded: boolean }> {
    if (!stay) {
      return {
        available: this.isEligibleRoom(room, null, guests),
        availabilityDegraded: false,
      };
    }
    try {
      const res = await this.pms.getList<PmsRoom>(
        `/Rooms/hotel/${hotelId}/available?${this.availableRoomsQuery(stay, guests)}`,
        ctx,
      );
      // Garde-prix explicite : le set `/available` du PMS ne filtre pas un prix ≤ 0 aberrant.
      const available =
        this.hasSellablePrice(room) &&
        (res.data ?? []).some((candidate) => candidate.id === roomId);
      return { available, availabilityDegraded: false };
    } catch (err) {
      const status = err instanceof PmsRequestError ? err.status : null;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Disponibilité datée indéterminée pour la chambre ${roomId} (hôtel ${hotelId}, statut ${status ?? 'réseau/timeout'}) : ${message}`,
      );
      // Dégradation : repli sur l'éligibilité statique, jamais « indisponible pour ces dates ».
      return {
        available: this.isEligibleRoom(room, null, guests),
        availabilityDegraded: true,
      };
    }
  }

  /** Photos de la chambre, triées primaire d'abord puis `displayOrder`. Best-effort : `[]` si panne. */
  private async roomPhotos(
    roomId: string,
    ctx: PmsRequestContext | undefined,
  ): Promise<RoomPhoto[]> {
    try {
      const res = await this.pms.get<PmsRoomImage[]>(
        `/Files/rooms/${roomId}/images`,
        ctx,
      );
      const usable = (res.data ?? []).filter(
        (image): image is PmsRoomImage & { url: string } =>
          typeof image.url === 'string' && image.url.length > 0,
      );
      return [...usable]
        .sort((a, b) => {
          if (Boolean(a.isPrimary) !== Boolean(b.isPrimary)) {
            return a.isPrimary ? -1 : 1;
          }
          return (a.displayOrder ?? 0) - (b.displayOrder ?? 0);
        })
        .map((image) => ({ url: image.url }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Images indisponibles pour la chambre ${roomId} — galerie vide. ${message}`,
      );
      return [];
    }
  }

  private toRoomDetailDto(
    hotel: PmsHotel,
    room: PmsRoom,
    currency: string,
    stay: StayDates | null,
    images: RoomPhoto[],
    available: boolean,
    availabilityDegraded: boolean,
  ): RoomDetailDto {
    // Unités mineures avec l'exposant RÉEL de la devise (cohérent avec `toRoomDto`/le front).
    const pricePerNight = toMinorUnits(room.price ?? 0, currency);
    return {
      id: room.id ?? '',
      hotelId: hotel.id ?? '',
      hotelName: hotel.name ?? null,
      hotelCity: hotel.city ?? null,
      number: room.number ?? null,
      category: room.category ?? null,
      capacity: typeof room.capacity === 'number' ? room.capacity : null,
      amenities: room.amenities ?? null,
      floor: room.floor ?? null,
      description: room.description ?? null,
      includedServices: this.mapIncludedServices(room.includedServices),
      images,
      pricePerNight,
      // Dérivé des unités mineures déjà arrondies (jamais un double arrondi depuis le décimal).
      totalPrice: stay ? pricePerNight * stay.nights : null,
      currency,
      nights: stay ? stay.nights : null,
      available,
      availabilityDegraded,
    };
  }

  /** Services inclus **actifs** et nommés (un service sans nom n'a rien à afficher). */
  private mapIncludedServices(
    services: PmsRoomIncludedService[] | null | undefined,
  ): RoomIncludedService[] {
    return (services ?? [])
      .filter(
        (service) =>
          service.isActive !== false &&
          typeof service.serviceName === 'string' &&
          service.serviceName.trim().length > 0,
      )
      .map((service) => ({
        name: (service.serviceName as string).trim(),
        quantity:
          typeof service.includedQuantity === 'number'
            ? service.includedQuantity
            : null,
        notes: service.notes ?? null,
      }));
  }

  private roomCacheKey(
    hotelId: string,
    roomId: string,
    stay: StayDates | null,
    guests: number | undefined,
  ): string {
    const normalized = JSON.stringify({
      hotelId,
      roomId,
      checkInDate: stay?.checkInDate ?? null,
      checkOutDate: stay?.checkOutDate ?? null,
      guests: guests ?? null,
    });
    return (
      ROOM_CACHE_PREFIX + createHash('sha1').update(normalized).digest('hex')
    );
  }

  /**
   * Chambres pour les dates (endpoint public daté `/Rooms/hotel/{id}/available`, qui filtre déjà
   * statut + capacité) ou, **sans dates**, toutes les chambres (`/Rooms/hotel/{id}`, non daté) —
   * ce dernier ne filtrant **ni le statut ni la capacité**, le BFF doit le faire lui-même (sinon une
   * chambre en maintenance s'affiche comme réservable).
   *
   * Une panne PMS **n'échoue pas** la page : `roomsUnavailable=true`, `rooms=[]` (hôtel affichable).
   * Seul un **404** signifie « pas de chambres » ; tout autre échec (400 d'intégration, 403, 5xx,
   * timeout) est une **dégradation** — jamais présenté comme « aucune chambre disponible ».
   */
  private async fetchRooms(
    id: string,
    stay: StayDates | null,
    guests: number | undefined,
    currency: string,
    ctx: PmsRequestContext | undefined,
  ): Promise<{ rooms: HotelRoomDto[]; roomsUnavailable: boolean }> {
    const path = stay
      ? `/Rooms/hotel/${id}/available?${this.availableRoomsQuery(stay, guests)}`
      : `/Rooms/hotel/${id}?PageSize=100`;
    try {
      const res = await this.pms.getList<PmsRoom>(path, ctx);
      const rooms = (res.data ?? [])
        .filter((room) => this.isEligibleRoom(room, stay, guests))
        .map((room) => this.toRoomDto(room, stay, currency));
      return { rooms, roomsUnavailable: false };
    } catch (err) {
      const status = err instanceof PmsRequestError ? err.status : null;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Chambres indéterminées pour l'hôtel ${id} (statut ${status ?? 'réseau/timeout'}) : ${message}`,
      );
      // 404 = l'hôtel n'a pas de chambres → état vide légitime. Tout le reste = panne/bug.
      return { rooms: [], roomsUnavailable: status !== 404 };
    }
  }

  /**
   * Chambre exposable : identifiable et au prix strictement positif. **Sans dates**, le PMS ne
   * filtre ni le statut ni la capacité → on ne retient que les chambres `Available` et assez
   * grandes (avec dates, `/available` + `MinCapacity` s'en chargent déjà côté PMS).
   */
  private isEligibleRoom(
    room: PmsRoom,
    stay: StayDates | null,
    guests: number | undefined,
  ): boolean {
    if (!room.id) {
      return false;
    }
    if (!this.hasSellablePrice(room)) {
      return false;
    }
    if (stay === null) {
      if (room.status !== ROOM_STATUS_AVAILABLE) {
        return false;
      }
      if (guests !== undefined && (room.capacity ?? 0) < guests) {
        return false;
      }
    }
    return true;
  }

  /**
   * Prix **vendable** : présent, fini et strictement positif. Un prix ≤ 0 / NaN (erreur de saisie
   * PMS) ne doit jamais produire une chambre réservable — sinon la fiche afficherait un prix négatif
   * et un CTA « Réserver » actif vers le tunnel. Le set daté `/available` du PMS ne garantit pas ce
   * filtre (contrairement à `isEligibleRoom`), d'où le contrôle explicite aussi sur ce chemin.
   */
  private hasSellablePrice(room: PmsRoom): boolean {
    return (
      typeof room.price === 'number' &&
      Number.isFinite(room.price) &&
      room.price > 0
    );
  }

  /**
   * Galerie de l'hôtel — **indépendante des dates et de la disponibilité** (revue 1.9) : les photos
   * d'un établissement ne sont pas une fonction de son taux d'occupation. Composée depuis la liste
   * **non datée** des chambres, elle est cachée **par hôtel** (partagée par toutes les vues datées).
   */
  private async galleryFor(
    hotel: PmsHotel,
    ctx: PmsRequestContext | undefined,
  ): Promise<HotelGalleryImage[]> {
    const id = hotel.id ?? '';
    const key = this.galleryCacheKey(id);
    const cached = await this.readCache<HotelGalleryImage[]>(key);
    if (cached) {
      return cached;
    }
    const gallery = await this.composeGallery(hotel, ctx);
    await this.writeCache(key, gallery);
    return gallery;
  }

  /**
   * Compose : logo hôtel (si présent) + image primaire de chaque chambre (bornée à
   * `galleryMaxRooms`, concurrence bornée), dé-dupliquée par URL. Best-effort : un échec d'image
   * est ignoré (mais logué), jamais une page cassée.
   */
  private async composeGallery(
    hotel: PmsHotel,
    ctx: PmsRequestContext | undefined,
  ): Promise<HotelGalleryImage[]> {
    const seen = new Set<string>();
    const images: HotelGalleryImage[] = [];
    const add = (
      url: string | null | undefined,
      roomNumber: string | null,
    ): void => {
      if (url && !seen.has(url)) {
        seen.add(url);
        images.push({ url, roomNumber });
      }
    };

    add(hotel.logoUrl, null);

    const rooms = await this.galleryRooms(hotel.id ?? '', ctx);
    const primaries = await mapWithConcurrency(
      rooms.slice(0, this.options.galleryMaxRooms),
      this.options.galleryConcurrency,
      (room) => this.primaryRoomImage(room, ctx),
    );
    for (const image of primaries) {
      if (image) {
        add(image.url, image.roomNumber);
      }
    }
    return images;
  }

  /** Chambres de l'hôtel (non datées) servant de source d'images. Best-effort : `[]` si échec. */
  private async galleryRooms(
    id: string,
    ctx: PmsRequestContext | undefined,
  ): Promise<PmsRoom[]> {
    try {
      const res = await this.pms.getList<PmsRoom>(
        `/Rooms/hotel/${id}?PageSize=100`,
        ctx,
      );
      return (res.data ?? []).filter((room) => Boolean(room.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Galerie : chambres injoignables pour l'hôtel ${id} — galerie réduite au logo. ${message}`,
      );
      return [];
    }
  }

  private async primaryRoomImage(
    room: PmsRoom,
    ctx: PmsRequestContext | undefined,
  ): Promise<HotelGalleryImage | null> {
    try {
      const res = await this.pms.get<PmsRoomImage[]>(
        `/Files/rooms/${room.id}/images`,
        ctx,
      );
      // Ne considérer que les images réellement exploitables : une primaire sans `url` ne doit pas
      // priver la chambre d'une image valide qui suit.
      const usable = (res.data ?? []).filter(
        (image): image is PmsRoomImage & { url: string } =>
          typeof image.url === 'string' && image.url.length > 0,
      );
      if (usable.length === 0) {
        return null;
      }
      const primary =
        usable.find((image) => image.isPrimary) ??
        [...usable].sort(
          (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0),
        )[0];
      return { url: primary.url, roomNumber: room.number ?? null };
    } catch (err) {
      // Best-effort, mais JAMAIS muet : une panne du service /Files ne doit pas être
      // indistinguable d'un « hôtel sans photos ».
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Images indisponibles pour la chambre ${room.id} — ignorées. ${message}`,
      );
      return null;
    }
  }

  private toRoomDto(
    room: PmsRoom,
    stay: StayDates | null,
    currency: string,
  ): HotelRoomDto {
    // Unités mineures avec l'exposant RÉEL de la devise (MGA/JPY = ×1, EUR/USD = ×100, KWD = ×1000).
    const pricePerNight = toMinorUnits(room.price ?? 0, currency);
    return {
      id: room.id ?? '',
      hotelId: room.hotelId ?? '',
      number: room.number ?? null,
      category: room.category ?? null,
      capacity: typeof room.capacity === 'number' ? room.capacity : null,
      amenities: room.amenities ?? null,
      floor: room.floor ?? null,
      pricePerNight,
      // Dérivé des unités mineures déjà arrondies : le total affiché reste cohérent avec le
      // prix/nuit affiché (un double arrondi depuis le décimal les fait diverger d'un cent).
      totalPrice: stay ? pricePerNight * stay.nights : null,
      currency,
      nights: stay ? stay.nights : null,
    };
  }

  private toHotelDetailDto(
    hotel: PmsHotel,
    currency: string,
    rooms: HotelRoomDto[],
    gallery: HotelGalleryImage[],
    stay: StayDates | null,
    roomsUnavailable: boolean,
  ): HotelDetailDto {
    return {
      id: hotel.id ?? '',
      name: hotel.name ?? null,
      category: hotel.category ?? null,
      description: hotel.description ?? null,
      address: hotel.address ?? null,
      city: hotel.city ?? null,
      country: hotel.country ?? null,
      postalCode: hotel.postalCode ?? null,
      latitude: hotel.latitude ?? null,
      longitude: hotel.longitude ?? null,
      phone: hotel.phone ?? null,
      email: hotel.email ?? null,
      currency,
      locale: hotel.locale ?? null,
      logoUrl: hotel.logoUrl ?? null,
      roomCount: hotel.roomCount ?? 0,
      gallery,
      rooms,
      stayNights: stay ? stay.nights : null,
      roomsUnavailable,
    };
  }

  /**
   * Dates utilisables = présentes, valides, ordonnées, **non passées** (la recherche impose déjà
   * `@IsNotPastDate`) et de durée **bornée** (un séjour de 8 000 ans produirait un total aberrant et
   * inonderait le cache). Sinon `null` → repli prix/nuit (la page se rend toujours).
   */
  private resolveStayDates(query: HotelDetailQueryDto): StayDates | null {
    const { checkInDate, checkOutDate } = query;
    if (!checkInDate || !checkOutDate) {
      return null;
    }
    const start = parseDateOnlyUtc(checkInDate);
    const end = parseDateOnlyUtc(checkOutDate);
    if (start === null || end === null || end <= start) {
      return null;
    }
    if (start < todayUtcMidnight()) {
      return null;
    }
    const nights = Math.round((end - start) / MS_PER_DAY);
    if (nights > this.options.maxStayNights) {
      return null;
    }
    return { checkInDate, checkOutDate, nights };
  }

  private availableRoomsQuery(
    stay: StayDates,
    guests: number | undefined,
  ): string {
    const params = new URLSearchParams();
    // Dates ancrées UTC (`…T00:00:00Z`) — sinon Npgsql rejette une date-only Kind=Unspecified (500).
    params.set('CheckInDate', toPmsUtcDateTime(stay.checkInDate));
    params.set('CheckOutDate', toPmsUtcDateTime(stay.checkOutDate));
    params.set('MinCapacity', String(Math.max(1, guests ?? 1)));
    params.set('PageSize', '100');
    return params.toString();
  }

  private pmsContext(): PmsRequestContext | undefined {
    const correlationId = this.correlation.getCorrelationId();
    return correlationId ? { correlationId } : undefined;
  }

  private cacheKey(
    id: string,
    stay: StayDates | null,
    guests: number | undefined,
  ): string {
    const normalized = JSON.stringify({
      id,
      checkInDate: stay?.checkInDate ?? null,
      checkOutDate: stay?.checkOutDate ?? null,
      guests: guests ?? null,
    });
    return CACHE_PREFIX + createHash('sha1').update(normalized).digest('hex');
  }

  private galleryCacheKey(id: string): string {
    return GALLERY_CACHE_PREFIX + createHash('sha1').update(id).digest('hex');
  }

  private async readCache<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      // Cache best-effort : une panne Redis ne casse jamais la page.
      return null;
    }
  }

  private async writeCache(key: string, value: unknown): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify(value),
        this.options.cacheTtlSeconds,
      );
    } catch (err) {
      // Best-effort, mais logué : un TTL invalide ferait échouer TOUTES les écritures
      // silencieusement (cache mort → martelage du PMS).
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Écriture du cache impossible (${key}) : ${message}`);
    }
  }
}

/** Ancre une date-only `AAAA-MM-JJ` en datetime UTC pour la liaison `DateTime` du PMS. */
function toPmsUtcDateTime(dateOnly: string): string {
  return `${dateOnly}T00:00:00Z`;
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
