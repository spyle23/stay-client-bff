import type { CorrelationService } from '../../common/correlation/correlation.service';
import type {
  ApiListResponse,
  ApiResponse,
} from '../../integration/pms/api-response.types';
import type { PmsClientService } from '../../integration/pms/pms-client.service';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import type { RedisService } from '../../redis/redis.service';
import type { components } from '../../types/generated/pms';
import type { CatalogOptions } from './catalog.constants';
import { CatalogService } from './catalog.service';
import type { HotelDetailQueryDto } from './dto/hotel-detail.query.dto';

type PmsHotel = components['schemas']['HotelDto'];
type PmsRoom = components['schemas']['RoomDto'];
type PmsRoomImage = components['schemas']['RoomImageDto'];

const HOTEL_ID = '11111111-1111-1111-1111-111111111111';
const AVAILABLE = 1; // RoomStatus.Available
const MAINTENANCE = 3; // RoomStatus.Maintenance

/** Date-only UTC décalée de `days` jours (les dates passées sont désormais rejetées). */
function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function hotelResponse(hotel: Partial<PmsHotel>): ApiResponse<PmsHotel> {
  return { success: true, data: hotel };
}
function roomList(rooms: Partial<PmsRoom>[]): ApiListResponse<PmsRoom> {
  return {
    success: true,
    data: rooms,
    pagination: {
      page: 1,
      pageSize: 100,
      totalCount: rooms.length,
      totalPages: 1,
      hasPreviousPage: false,
      hasNextPage: false,
    },
  };
}
function imagesResponse(
  images: Partial<PmsRoomImage>[],
): ApiResponse<PmsRoomImage[]> {
  return { success: true, data: images };
}

const datedQuery: HotelDetailQueryDto = {
  checkInDate: isoDatePlus(30),
  checkOutDate: isoDatePlus(32), // 2 nuits
  guests: 2,
};

describe('CatalogService', () => {
  let pmsGet: jest.Mock;
  let pmsGetList: jest.Mock;
  let redisGet: jest.Mock;
  let redisSet: jest.Mock;
  let service: CatalogService;
  /** Fixtures pilotées par test — le mock `pms.get` **dispatche par chemin** (hôtel vs images). */
  let hotelFixture: Partial<PmsHotel>;
  let imageFixtures: Record<string, Partial<PmsRoomImage>[]>;
  const options: CatalogOptions = {
    cacheTtlSeconds: 60,
    galleryMaxRooms: 5,
    galleryConcurrency: 4,
    maxStayNights: 90,
  };

  /** Chemins réellement appelés sur `getList` (chambres). */
  const roomPaths = (): string[] =>
    (pmsGetList.mock.calls as unknown[][]).map((args) => args[0] as string);

  beforeEach(() => {
    hotelFixture = { id: HOTEL_ID, currency: 'EUR' };
    imageFixtures = {};
    // Un mock qui renverrait l'hôtel pour TOUS les chemins (y compris `/Files/.../images`)
    // masquerait le comportement réel : on dispatche donc explicitement.
    pmsGet = jest.fn().mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/')) {
        return Promise.resolve(hotelResponse(hotelFixture));
      }
      const match = /^\/Files\/rooms\/(.+)\/images$/.exec(path);
      return Promise.resolve(
        imagesResponse(match ? (imageFixtures[match[1]] ?? []) : []),
      );
    });
    pmsGetList = jest.fn();
    redisGet = jest.fn().mockResolvedValue(null);
    redisSet = jest.fn().mockResolvedValue(undefined);
    const correlation = {
      getCorrelationId: () => 'cid-test',
    } as unknown as CorrelationService;
    service = new CatalogService(
      { get: pmsGet, getList: pmsGetList } as unknown as PmsClientService,
      { get: redisGet, set: redisSet } as unknown as RedisService,
      correlation,
      options,
    );
  });

  /** Détail hôtel : champs mappés, SANS identifiants fiscaux (rcs/nif/stat). */
  it('mappe le détail hôtel et n’expose pas les identifiants fiscaux', async () => {
    pmsGet.mockImplementation((path: string) =>
      path === `/Hotels/${HOTEL_ID}`
        ? Promise.resolve(
            hotelResponse({
              id: HOTEL_ID,
              name: 'Hôtel Test',
              category: '4-star',
              city: 'Antananarivo',
              currency: 'EUR',
              rcs: 'RCS-123',
              nif: 'NIF-123',
              stat: 'STAT-123',
            }),
          )
        : Promise.resolve(imagesResponse([])),
    );
    pmsGetList.mockResolvedValue(
      roomList([{ id: 'r1', price: 120, capacity: 2, status: AVAILABLE }]),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, datedQuery);

    expect(dto.name).toBe('Hôtel Test');
    expect(dto).not.toHaveProperty('rcs');
    expect(dto).not.toHaveProperty('nif');
    expect(dto).not.toHaveProperty('stat');
    expect(dto.roomsUnavailable).toBe(false);
  });

  /** Total = prix/nuit × nuits (cohérent), MinCapacity poussé, dates ancrées UTC. */
  it('calcule le total du séjour (dérivé du prix/nuit), pousse MinCapacity et ancre les dates UTC', async () => {
    hotelFixture = { id: HOTEL_ID, name: 'H', currency: 'USD' };
    pmsGetList.mockResolvedValue(
      roomList([
        { id: 'r1', number: '101', price: 120, capacity: 2, status: AVAILABLE },
      ]),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, datedQuery);

    expect(dto.rooms[0].pricePerNight).toBe(12000);
    expect(dto.rooms[0].totalPrice).toBe(24000);
    expect(dto.rooms[0].nights).toBe(2);
    expect(dto.rooms[0].currency).toBe('USD');

    const availablePath = roomPaths().find((p) => p.includes('/available'));
    expect(availablePath).toContain(
      `CheckInDate=${datedQuery.checkInDate}T00%3A00%3A00Z`,
    );
    expect(availablePath).toContain('MinCapacity=2');
  });

  /**
   * Revue : l'unité mineure dépend de l'EXPOSANT de la devise (MGA/JPY = 0 décimale, KWD = 3).
   * Un ×100 en dur afficherait 12 000 MGA comme 1 200 000.
   */
  it('encode les montants avec l’exposant réel de la devise (MGA=×1, EUR=×100, KWD=×1000)', async () => {
    const run = async (currency: string, price: number) => {
      hotelFixture = { id: HOTEL_ID, currency };
      pmsGetList.mockResolvedValue(
        roomList([{ id: 'r1', price, status: AVAILABLE }]),
      );
      const dto = await service.getHotelDetail(HOTEL_ID, {});
      return dto.rooms[0].pricePerNight;
    };

    expect(await run('MGA', 12000)).toBe(12000); // 0 décimale → ×1
    expect(await run('JPY', 12000)).toBe(12000);
    expect(await run('EUR', 120)).toBe(12000); // 2 décimales → ×100
    expect(await run('KWD', 12)).toBe(12000); // 3 décimales → ×1000
  });

  /** Total dérivé des unités mineures : jamais de divergence « 10,00 €/nuit mais 20,01 € au total ». */
  it('dérive le total des unités mineures (pas de double arrondi)', async () => {
    pmsGetList.mockResolvedValue(
      roomList([{ id: 'r1', price: 10.005, status: AVAILABLE }]),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, datedQuery);

    expect(dto.rooms[0].totalPrice).toBe(dto.rooms[0].pricePerNight * 2);
  });

  it('propage un 404 quand le PMS ne trouve pas l’hôtel', async () => {
    pmsGet.mockRejectedValue(new PmsRequestError('Hotel not found', 404));

    await expect(service.getHotelDetail(HOTEL_ID, datedQuery)).rejects.toThrow(
      PmsRequestError,
    );
    expect(pmsGetList).not.toHaveBeenCalled();
  });

  /** Sans dates : endpoint non daté, prix/nuit seul. */
  it('sans dates : chambres via l’endpoint non daté, prix par nuit uniquement', async () => {
    pmsGetList.mockResolvedValue(
      roomList([{ id: 'r1', price: 90, capacity: 2, status: AVAILABLE }]),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, {});

    expect(roomPaths()[0]).toBe(`/Rooms/hotel/${HOTEL_ID}?PageSize=100`);
    expect(dto.rooms[0].pricePerNight).toBe(9000);
    expect(dto.rooms[0].totalPrice).toBeNull();
    expect(dto.rooms[0].nights).toBeNull();
  });

  /**
   * Revue : l'endpoint NON daté du PMS ne filtre ni le statut ni la capacité → une chambre en
   * maintenance ne doit jamais s'afficher comme réservable, ni une chambre trop petite.
   */
  it('sans dates : écarte les chambres non `Available` et de capacité insuffisante', async () => {
    pmsGetList.mockResolvedValue(
      roomList([
        { id: 'r1', price: 90, capacity: 4, status: MAINTENANCE }, // en travaux
        { id: 'r2', price: 90, capacity: 1, status: AVAILABLE }, // trop petite
        { id: 'r3', price: 90, capacity: 4, status: AVAILABLE }, // retenue
      ]),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, { guests: 3 });

    expect(dto.rooms.map((r) => r.id)).toEqual(['r3']);
  });

  /** Dates passées / séjour trop long → repli prix/nuit (jamais une erreur, jamais un total aberrant). */
  it('ignore un contexte de dates passé ou hors borne (repli prix/nuit)', async () => {
    pmsGetList.mockResolvedValue(
      roomList([{ id: 'r1', price: 90, status: AVAILABLE }]),
    );

    const past = await service.getHotelDetail(HOTEL_ID, {
      checkInDate: '2020-01-01',
      checkOutDate: '2020-01-05',
    });
    expect(past.rooms[0].nights).toBeNull();

    pmsGetList.mockClear();
    const tooLong = await service.getHotelDetail(HOTEL_ID, {
      checkInDate: isoDatePlus(10),
      checkOutDate: isoDatePlus(400), // > maxStayNights
    });
    expect(tooLong.rooms[0].nights).toBeNull();
    expect(roomPaths()[0]).not.toContain('/available');
  });

  /** Galerie : logo + primaire par chambre, **dé-duplication réellement exercée** (logo == image chambre). */
  it('compose la galerie et dé-duplique une URL partagée entre le logo et une chambre', async () => {
    pmsGet.mockImplementation((path: string) => {
      if (path === `/Hotels/${HOTEL_ID}`) {
        return Promise.resolve(
          hotelResponse({
            id: HOTEL_ID,
            name: 'H',
            currency: 'EUR',
            logoUrl: 'https://img/shared.png',
          }),
        );
      }
      if (path === '/Files/rooms/r1/images') {
        // Même URL que le logo → doit apparaître UNE seule fois dans la galerie.
        return Promise.resolve(
          imagesResponse([{ url: 'https://img/shared.png', isPrimary: true }]),
        );
      }
      if (path === '/Files/rooms/r2/images') {
        return Promise.resolve(
          imagesResponse([{ url: 'https://img/r2.png', isPrimary: true }]),
        );
      }
      return Promise.resolve(imagesResponse([]));
    });
    pmsGetList.mockResolvedValue(
      roomList([
        { id: 'r1', number: '101', price: 100, status: AVAILABLE },
        { id: 'r2', number: '102', price: 110, status: AVAILABLE },
      ]),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, datedQuery);

    expect(dto.gallery.map((g) => g.url)).toEqual([
      'https://img/shared.png',
      'https://img/r2.png',
    ]);
    expect(dto.gallery[0].roomNumber).toBeNull(); // logo
    expect(dto.gallery[1].roomNumber).toBe('102');
  });

  /** Aucune `isPrimary` → repli sur le plus petit `displayOrder` (branche jamais atteinte avant). */
  it('sélectionne l’image de plus petit displayOrder quand aucune n’est primaire', async () => {
    pmsGet.mockImplementation((path: string) => {
      if (path === `/Hotels/${HOTEL_ID}`) {
        return Promise.resolve(
          hotelResponse({ id: HOTEL_ID, currency: 'EUR' }),
        );
      }
      if (path === '/Files/rooms/r1/images') {
        return Promise.resolve(
          imagesResponse([
            { url: 'https://img/second.png', displayOrder: 2 },
            { url: 'https://img/first.png', displayOrder: 1 },
          ]),
        );
      }
      return Promise.resolve(imagesResponse([]));
    });
    pmsGetList.mockResolvedValue(
      roomList([{ id: 'r1', price: 100, status: AVAILABLE }]),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, datedQuery);

    expect(dto.gallery.map((g) => g.url)).toEqual(['https://img/first.png']);
  });

  /** Une image primaire sans `url` ne doit pas priver la chambre d'une image valide qui suit. */
  it('ignore une image primaire sans url et retient la suivante exploitable', async () => {
    pmsGet.mockImplementation((path: string) => {
      if (path === `/Hotels/${HOTEL_ID}`) {
        return Promise.resolve(
          hotelResponse({ id: HOTEL_ID, currency: 'EUR' }),
        );
      }
      if (path === '/Files/rooms/r1/images') {
        return Promise.resolve(
          imagesResponse([
            { url: null, isPrimary: true },
            { url: 'https://img/ok.png', displayOrder: 1 },
          ]),
        );
      }
      return Promise.resolve(imagesResponse([]));
    });
    pmsGetList.mockResolvedValue(
      roomList([{ id: 'r1', price: 100, status: AVAILABLE }]),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, datedQuery);

    expect(dto.gallery.map((g) => g.url)).toEqual(['https://img/ok.png']);
  });

  /** Panne PMS sur les chambres → dégradation, hôtel affichable, et **rien n'est caché**. */
  it('panne des chambres : roomsUnavailable=true, hôtel affichable, réponse NON cachée', async () => {
    hotelFixture = { id: HOTEL_ID, name: 'H', currency: 'EUR' };
    pmsGetList.mockRejectedValue(new PmsUnavailableError('rooms down'));

    const dto = await service.getHotelDetail(HOTEL_ID, datedQuery);

    expect(dto.name).toBe('H');
    expect(dto.rooms).toEqual([]);
    expect(dto.roomsUnavailable).toBe(true);
    // La clé du DTO dégradé ne doit PAS être écrite (une micro-panne ne doit pas durer le TTL).
    const writtenKeys = (redisSet.mock.calls as unknown[][]).map(
      (args) => args[0] as string,
    );
    expect(writtenKeys.some((k) => k.startsWith('catalog:hotel:'))).toBe(false);
  });

  /** Un 400 d'intégration est une DÉGRADATION, pas « aucune chambre » ; un 404 est un état vide. */
  it('distingue un 400 PMS (dégradation) d’un 404 (aucune chambre)', async () => {
    pmsGetList.mockRejectedValue(new PmsRequestError('Bad request', 400));
    const degraded = await service.getHotelDetail(HOTEL_ID, datedQuery);
    expect(degraded.roomsUnavailable).toBe(true);

    pmsGetList.mockRejectedValue(new PmsRequestError('Not found', 404));
    const empty = await service.getHotelDetail(HOTEL_ID, datedQuery);
    expect(empty.roomsUnavailable).toBe(false);
    expect(empty.rooms).toEqual([]);
  });

  /** Chambres inexploitables : prix ≤ 0 ou sans id (clé React vide + appel /Files inutile). */
  it('exclut les chambres au prix ≤ 0 et celles sans id', async () => {
    pmsGetList.mockResolvedValue(
      roomList([
        { id: 'r1', price: 0, status: AVAILABLE },
        { id: 'r2', price: -5, status: AVAILABLE },
        { price: 80, status: AVAILABLE }, // sans id
        { id: 'r4', price: 80, status: AVAILABLE },
      ]),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, datedQuery);

    expect(dto.rooms.map((r) => r.id)).toEqual(['r4']);
  });

  /** Capacité absente → `null` (jamais « 0 voyageur » affiché). */
  it('expose une capacité null quand le PMS ne la renseigne pas', async () => {
    pmsGetList.mockResolvedValue(
      roomList([{ id: 'r1', price: 80, status: AVAILABLE }]),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, datedQuery);

    expect(dto.rooms[0].capacity).toBeNull();
  });

  /** Devise cohérente hôtel ↔ chambres (jamais `null` d'un côté et « EUR » fabriqué de l'autre). */
  it('résout une devise unique pour l’hôtel et ses chambres', async () => {
    hotelFixture = { id: HOTEL_ID }; // pas de currency
    pmsGetList.mockResolvedValue(
      roomList([{ id: 'r1', price: 80, status: AVAILABLE }]),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, datedQuery);

    expect(dto.currency).toBe('EUR');
    expect(dto.rooms[0].currency).toBe(dto.currency);
  });

  /** Cache : un hit renvoie la valeur mémorisée sans solliciter le PMS. */
  it('sert depuis le cache Redis sans appeler le PMS', async () => {
    redisGet.mockImplementation((key: string) =>
      Promise.resolve(
        key.startsWith('catalog:hotel:')
          ? JSON.stringify({
              id: HOTEL_ID,
              name: 'Cached',
              rooms: [],
              gallery: [],
              roomsUnavailable: false,
            })
          : null,
      ),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, datedQuery);

    expect(dto.name).toBe('Cached');
    expect(pmsGet).not.toHaveBeenCalled();
    expect(pmsGetList).not.toHaveBeenCalled();
  });

  /**
   * La clé de cache doit **discriminer** (id, dates, voyageurs) : un test qui renvoie la même valeur
   * quelle que soit la clé passerait même avec une clé constante.
   */
  it('produit des clés de cache distinctes par (dates, voyageurs) et une clé galerie par hôtel', async () => {
    pmsGetList.mockResolvedValue(
      roomList([{ id: 'r1', price: 80, status: AVAILABLE }]),
    );

    await service.getHotelDetail(HOTEL_ID, datedQuery);
    await service.getHotelDetail(HOTEL_ID, { ...datedQuery, guests: 4 });

    const readKeys = (redisGet.mock.calls as unknown[][]).map(
      (args) => args[0] as string,
    );
    const hotelKeys = readKeys.filter((k) => k.startsWith('catalog:hotel:'));
    const galleryKeys = readKeys.filter((k) =>
      k.startsWith('catalog:gallery:'),
    );

    expect(new Set(hotelKeys).size).toBe(2); // deux contextes → deux clés
    expect(new Set(galleryKeys).size).toBe(1); // galerie indépendante des dates/voyageurs
  });

  /** La galerie ne dépend PAS des dates : elle est composée depuis la liste non datée. */
  it('compose la galerie depuis la liste NON datée des chambres (indépendante de la disponibilité)', async () => {
    pmsGet.mockImplementation((path: string) => {
      if (path === `/Hotels/${HOTEL_ID}`) {
        return Promise.resolve(
          hotelResponse({ id: HOTEL_ID, currency: 'EUR' }),
        );
      }
      if (path === '/Files/rooms/r9/images') {
        return Promise.resolve(
          imagesResponse([{ url: 'https://img/r9.png', isPrimary: true }]),
        );
      }
      return Promise.resolve(imagesResponse([]));
    });
    pmsGetList.mockImplementation((path: string) =>
      Promise.resolve(
        path.includes('/available')
          ? roomList([]) // AUCUNE chambre disponible pour ces dates
          : roomList([
              { id: 'r9', number: '9', price: 100, status: AVAILABLE },
            ]),
      ),
    );

    const dto = await service.getHotelDetail(HOTEL_ID, datedQuery);

    // Zéro chambre réservable, mais l'hôtel garde son identité visuelle.
    expect(dto.rooms).toEqual([]);
    expect(dto.gallery.map((g) => g.url)).toEqual(['https://img/r9.png']);
  });

  /** Écriture cache avec un TTL entier (un TTL fractionnaire tuerait le cache silencieusement). */
  it('écrit le cache avec le TTL entier configuré', async () => {
    pmsGetList.mockResolvedValue(
      roomList([{ id: 'r1', price: 80, status: AVAILABLE }]),
    );

    await service.getHotelDetail(HOTEL_ID, datedQuery);

    const ttls = (redisSet.mock.calls as unknown[][]).map((args) => args[2]);
    expect(ttls.length).toBeGreaterThan(0);
    for (const ttl of ttls) {
      expect(Number.isInteger(ttl)).toBe(true);
      expect(ttl).toBe(60);
    }
  });

  // --- Story 1.10 : fiche chambre (getRoomDetail) -----------------------------------------
  describe('getRoomDetail', () => {
    const ROOM_ID = '22222222-2222-2222-2222-222222222222';

    /**
     * Dispatche `getList` par chemin : liste NON datée (trouve la chambre) vs set `/available`
     * (cross-check de disponibilité). Un mock indifférencié masquerait le comportement réel.
     */
    function dispatchRooms(opts: {
      list?: Partial<PmsRoom>[];
      available?: Partial<PmsRoom>[];
      listError?: Error;
      availableError?: Error;
    }): void {
      pmsGetList.mockImplementation((path: string) => {
        if (path.includes('/available')) {
          return opts.availableError
            ? Promise.reject(opts.availableError)
            : Promise.resolve(roomList(opts.available ?? []));
        }
        return opts.listError
          ? Promise.reject(opts.listError)
          : Promise.resolve(roomList(opts.list ?? []));
      });
    }

    /** Fiche complète (dates) : mapping des champs + total dérivé + disponibilité par cross-check. */
    it('mappe la fiche (photos, catégorie, services inclus, total) et marque disponible', async () => {
      hotelFixture = {
        id: HOTEL_ID,
        name: 'Hôtel Test',
        city: 'Antananarivo',
        currency: 'EUR',
      };
      imageFixtures[ROOM_ID] = [
        { url: 'https://img/2.png', displayOrder: 2 },
        { url: 'https://img/primary.png', isPrimary: true, displayOrder: 5 },
      ];
      dispatchRooms({
        list: [
          {
            id: ROOM_ID,
            number: '101',
            category: 'Suite',
            capacity: 2,
            price: 120,
            amenities: 'Wifi, Clim',
            floor: 1,
            description: 'Vue mer',
            status: AVAILABLE,
            includedServices: [
              {
                serviceName: 'Petit-déjeuner',
                includedQuantity: 2,
                isActive: true,
              },
            ],
          },
        ],
        available: [{ id: ROOM_ID, price: 120, status: AVAILABLE }],
      });

      const dto = await service.getRoomDetail(HOTEL_ID, ROOM_ID, datedQuery);

      expect(dto.id).toBe(ROOM_ID);
      expect(dto.hotelName).toBe('Hôtel Test');
      expect(dto.hotelCity).toBe('Antananarivo');
      expect(dto.category).toBe('Suite');
      expect(dto.capacity).toBe(2);
      expect(dto.description).toBe('Vue mer');
      expect(dto.pricePerNight).toBe(12000);
      expect(dto.totalPrice).toBe(24000); // 12000 × 2 nuits
      expect(dto.nights).toBe(2);
      expect(dto.currency).toBe('EUR');
      expect(dto.available).toBe(true);
      expect(dto.availabilityDegraded).toBe(false);
      // Images triées : primaire d'abord malgré un displayOrder plus élevé.
      expect(dto.images.map((i) => i.url)).toEqual([
        'https://img/primary.png',
        'https://img/2.png',
      ]);
      expect(dto.includedServices).toEqual([
        { name: 'Petit-déjeuner', quantity: 2, notes: null },
      ]);
    });

    /** Chambre présente mais ABSENTE du set daté → indisponible pour ces dates (non dégradé). */
    it('marque indisponible une chambre absente du set daté (données rendues, non dégradé)', async () => {
      dispatchRooms({
        list: [{ id: ROOM_ID, price: 120, capacity: 2, status: AVAILABLE }],
        available: [], // aucune dispo pour ces dates
      });

      const dto = await service.getRoomDetail(HOTEL_ID, ROOM_ID, datedQuery);

      expect(dto.id).toBe(ROOM_ID);
      expect(dto.available).toBe(false);
      expect(dto.availabilityDegraded).toBe(false);
      expect(dto.pricePerNight).toBe(12000); // la fiche reste affichable
    });

    /** Garde-prix : une chambre au prix ≤ 0 (saisie PMS aberrante) n'est jamais réservable, même
     * présente dans le set daté (le PMS `/available` ne garantit pas ce filtre). */
    it('ne rend jamais réservable une chambre au prix ≤ 0, même dans le set daté', async () => {
      dispatchRooms({
        list: [{ id: ROOM_ID, price: -5, capacity: 2, status: AVAILABLE }],
        available: [{ id: ROOM_ID, price: -5, status: AVAILABLE }],
      });

      const dto = await service.getRoomDetail(HOTEL_ID, ROOM_ID, datedQuery);

      expect(dto.available).toBe(false);
    });

    /** Sans dates : éligibilité statique (Available + prix), et AUCUN appel `/available`. */
    it('sans dates : disponibilité par éligibilité statique, sans appel /available', async () => {
      dispatchRooms({
        list: [{ id: ROOM_ID, price: 90, capacity: 2, status: AVAILABLE }],
      });

      const dto = await service.getRoomDetail(HOTEL_ID, ROOM_ID, {});

      expect(dto.available).toBe(true);
      expect(dto.nights).toBeNull();
      expect(dto.totalPrice).toBeNull();
      const paths = (pmsGetList.mock.calls as unknown[][]).map(
        (args) => args[0] as string,
      );
      expect(paths.some((p) => p.includes('/available'))).toBe(false);
    });

    /** Sans dates : une chambre en maintenance est rendue mais NON disponible. */
    it('sans dates : une chambre non Available est rendue mais indisponible', async () => {
      dispatchRooms({
        list: [{ id: ROOM_ID, price: 90, capacity: 2, status: MAINTENANCE }],
      });

      const dto = await service.getRoomDetail(HOTEL_ID, ROOM_ID, {});

      expect(dto.available).toBe(false);
    });

    /** Chambre absente de l'hôtel → 404 (fiche introuvable). */
    it('propage un 404 quand la chambre est absente de l’hôtel', async () => {
      dispatchRooms({ list: [{ id: 'autre', price: 90, status: AVAILABLE }] });

      await expect(
        service.getRoomDetail(HOTEL_ID, ROOM_ID, datedQuery),
      ).rejects.toThrow(PmsRequestError);
    });

    /** Hôtel introuvable → 404 sans jamais chercher la chambre. */
    it('propage un 404 hôtel sans lister les chambres', async () => {
      pmsGet.mockRejectedValue(new PmsRequestError('Hotel not found', 404));

      await expect(
        service.getRoomDetail(HOTEL_ID, ROOM_ID, datedQuery),
      ).rejects.toThrow(PmsRequestError);
      expect(pmsGetList).not.toHaveBeenCalled();
    });

    /** Panne (non-404) sur la liste des chambres → dégradation de page (rethrow → 503). */
    it('rethrow une panne (non-404) de la liste des chambres', async () => {
      dispatchRooms({ listError: new PmsUnavailableError('rooms down') });

      await expect(
        service.getRoomDetail(HOTEL_ID, ROOM_ID, datedQuery),
      ).rejects.toThrow(PmsUnavailableError);
    });

    /** Panne du cross-check daté → availabilityDegraded, repli statique, réponse NON cachée. */
    it('dégrade la disponibilité datée sans échouer, et ne cache pas', async () => {
      dispatchRooms({
        list: [{ id: ROOM_ID, price: 90, capacity: 2, status: AVAILABLE }],
        availableError: new PmsUnavailableError('availability down'),
      });

      const dto = await service.getRoomDetail(HOTEL_ID, ROOM_ID, datedQuery);

      expect(dto.availabilityDegraded).toBe(true);
      expect(dto.available).toBe(true); // repli sur l'éligibilité statique
      const writtenKeys = (redisSet.mock.calls as unknown[][]).map(
        (args) => args[0] as string,
      );
      expect(writtenKeys.some((k) => k.startsWith('catalog:room:'))).toBe(
        false,
      );
    });

    /** Services inclus : seuls les actifs et nommés sont exposés. */
    it('n’expose que les services inclus actifs et nommés', async () => {
      dispatchRooms({
        list: [
          {
            id: ROOM_ID,
            price: 90,
            status: AVAILABLE,
            includedServices: [
              { serviceName: 'Wifi', includedQuantity: 1, isActive: true },
              { serviceName: 'Spa', isActive: false }, // inactif
              { serviceName: '   ', isActive: true }, // sans nom
            ],
          },
        ],
      });

      const dto = await service.getRoomDetail(HOTEL_ID, ROOM_ID, {});

      expect(dto.includedServices.map((s) => s.name)).toEqual(['Wifi']);
    });

    /** Exposant de devise réel (MGA = ×1) sur le prix de la fiche. */
    it('encode le prix avec l’exposant réel de la devise', async () => {
      hotelFixture = { id: HOTEL_ID, currency: 'MGA' };
      dispatchRooms({
        list: [{ id: ROOM_ID, price: 12000, status: AVAILABLE }],
      });

      const dto = await service.getRoomDetail(HOTEL_ID, ROOM_ID, {});

      expect(dto.pricePerNight).toBe(12000); // MGA : 0 décimale
    });

    /** Cross-check daté : dates ancrées UTC + MinCapacity poussés au PMS. */
    it('ancre les dates UTC et pousse MinCapacity au cross-check de disponibilité', async () => {
      dispatchRooms({
        list: [{ id: ROOM_ID, price: 90, capacity: 4, status: AVAILABLE }],
        available: [{ id: ROOM_ID, price: 90, status: AVAILABLE }],
      });

      await service.getRoomDetail(HOTEL_ID, ROOM_ID, datedQuery);

      const availablePath = (pmsGetList.mock.calls as unknown[][])
        .map((args) => args[0] as string)
        .find((p) => p.includes('/available'));
      expect(availablePath).toContain(
        `CheckInDate=${datedQuery.checkInDate}T00%3A00%3A00Z`,
      );
      expect(availablePath).toContain('MinCapacity=2');
    });

    /** Cache : écriture sous le préfixe room avec un TTL entier ; un hit sert sans PMS. */
    it('écrit puis sert la fiche depuis le cache (préfixe room, TTL entier)', async () => {
      dispatchRooms({
        list: [{ id: ROOM_ID, price: 90, status: AVAILABLE }],
        available: [{ id: ROOM_ID, price: 90, status: AVAILABLE }],
      });

      await service.getRoomDetail(HOTEL_ID, ROOM_ID, datedQuery);

      const roomWrite = (redisSet.mock.calls as unknown[][]).find((args) =>
        (args[0] as string).startsWith('catalog:room:'),
      );
      expect(roomWrite).toBeDefined();
      expect(Number.isInteger(roomWrite?.[2])).toBe(true);
      expect(roomWrite?.[2]).toBe(60);

      // Hit : la valeur cachée est servie sans PMS.
      redisGet.mockImplementation((key: string) =>
        Promise.resolve(
          key.startsWith('catalog:room:')
            ? JSON.stringify({ id: ROOM_ID, available: true })
            : null,
        ),
      );
      pmsGet.mockClear();
      pmsGetList.mockClear();
      const cached = await service.getRoomDetail(HOTEL_ID, ROOM_ID, datedQuery);
      expect(cached.id).toBe(ROOM_ID);
      expect(pmsGet).not.toHaveBeenCalled();
      expect(pmsGetList).not.toHaveBeenCalled();
    });
  });
});
