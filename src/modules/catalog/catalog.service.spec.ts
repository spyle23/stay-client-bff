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
});
