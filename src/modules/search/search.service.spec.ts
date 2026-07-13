import type { CorrelationService } from '../../common/correlation/correlation.service';
import type { ApiListResponse } from '../../integration/pms/api-response.types';
import type { PmsClientService } from '../../integration/pms/pms-client.service';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import type { RedisService } from '../../redis/redis.service';
import type { components } from '../../types/generated/pms';
import type { SearchOptions } from './search.constants';
import { SearchService, type SearchHotelsResult } from './search.service';
import type { SearchHotelsQueryDto } from './dto/search-hotels.query.dto';
import type { SearchNearbyQueryDto } from './dto/search-nearby.query.dto';

type PmsHotel = components['schemas']['HotelDto'];
type PmsHotelWithDistance = components['schemas']['HotelWithDistanceDto'];
type PmsRoom = components['schemas']['RoomDto'];

function hotelList(hotels: Partial<PmsHotel>[]): ApiListResponse<PmsHotel> {
  return {
    success: true,
    data: hotels,
    pagination: meta(hotels.length),
  };
}
function nearbyList(
  hotels: Partial<PmsHotelWithDistance>[],
): ApiListResponse<PmsHotelWithDistance> {
  return {
    success: true,
    data: hotels,
    pagination: meta(hotels.length),
  };
}
function roomList(rooms: Partial<PmsRoom>[]): ApiListResponse<PmsRoom> {
  return {
    success: true,
    data: rooms,
    pagination: meta(rooms.length),
  };
}

/** Chemins PMS `/Rooms/hotel/.../available` réellement appelés par le fan-out. */
function roomCallPaths(mock: jest.Mock): string[] {
  return (mock.mock.calls as unknown[][])
    .map((args) => (typeof args[0] === 'string' ? args[0] : ''))
    .filter((path) => path.includes('/Rooms/hotel/'));
}
function meta(count: number) {
  return {
    page: 1,
    pageSize: 100,
    totalCount: count,
    totalPages: 1,
    hasPreviousPage: false,
    hasNextPage: false,
  };
}

const baseQuery: SearchHotelsQueryDto = {
  destination: 'Antananarivo',
  checkInDate: '2026-08-01',
  checkOutDate: '2026-08-03', // 2 nuits
  guests: 2,
  currency: 'EUR',
  page: 1,
  pageSize: 12,
};

const baseNearby: SearchNearbyQueryDto = {
  latitude: -18.9,
  longitude: 47.5,
  checkInDate: '2026-08-01',
  checkOutDate: '2026-08-03', // 2 nuits
  guests: 2,
  currency: 'EUR',
  page: 1,
  pageSize: 12,
};

/** 1ᵉʳ chemin `/Hotels/nearby` réellement appelé (candidats de proximité). */
function nearbyCallPath(mock: jest.Mock): string | undefined {
  return (mock.mock.calls as unknown[][])
    .map((args) => (typeof args[0] === 'string' ? args[0] : ''))
    .find((path) => path.includes('/Hotels/nearby'));
}

describe('SearchService', () => {
  let getList: jest.Mock;
  let get: jest.Mock;
  let set: jest.Mock;
  let service: SearchService;
  const options: SearchOptions = {
    maxHotels: 25,
    concurrency: 6,
    cacheTtlSeconds: 45,
    nearbyDefaultRadiusKm: 10,
    nearbyMaxRadiusKm: 100,
    nearbyMaxResults: 25,
  };

  beforeEach(() => {
    getList = jest.fn();
    get = jest.fn().mockResolvedValue(null);
    set = jest.fn().mockResolvedValue(undefined);
    const correlation = {
      getCorrelationId: () => 'cid-test',
    } as unknown as CorrelationService;
    service = new SearchService(
      { getList } as unknown as PmsClientService,
      { get, set } as unknown as RedisService,
      correlation,
      options,
    );
  });

  it('agrège « à partir de » = min des chambres dispo et convertit en cents (décimal PMS → cents)', async () => {
    getList.mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/search')) {
        return Promise.resolve(
          hotelList([
            {
              id: 'h1',
              name: 'Hôtel A',
              city: 'Antananarivo',
              country: 'Madagascar',
              category: '4-star',
              currency: 'EUR',
              logoUrl: 'https://img/logo-a.png',
              latitude: -18.9,
              longitude: 47.5,
            },
          ]),
        );
      }
      return Promise.resolve(
        roomList([
          { price: 120.5, capacity: 2 },
          { price: 200, capacity: 4 },
        ]),
      );
    });

    const result = await service.searchHotels(baseQuery);

    expect(result.totalCount).toBe(1);
    expect(result.items).toHaveLength(1);
    const hotel = result.items[0];
    expect(hotel.hotelId).toBe('h1');
    expect(hotel.nights).toBe(2);
    expect(hotel.fromPricePerNight).toBe(12050); // 120.50 € → cents
    expect(hotel.fromTotalPrice).toBe(24100); // 120.50 × 2 nuits → cents
    expect(hotel.currency).toBe('EUR');
    expect(hotel.availableRoomCount).toBe(2);
    expect(hotel.thumbnailUrl).toBe('https://img/logo-a.png');
    expect(set).toHaveBeenCalled(); // résultat mis en cache
  });

  it("segmente par devise : un hôtel USD est exclu d'une recherche EUR (aucun appel dispo)", async () => {
    getList.mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/search')) {
        return Promise.resolve(
          hotelList([
            { id: 'eur', currency: 'EUR' },
            { id: 'usd', currency: 'USD' },
          ]),
        );
      }
      return Promise.resolve(roomList([{ price: 100 }]));
    });

    const result = await service.searchHotels(baseQuery);

    expect(result.items.map((h) => h.hotelId)).toEqual(['eur']);
    expect(roomCallPaths(getList)).toEqual([
      expect.stringContaining('/Rooms/hotel/eur/available'),
    ]);
  });

  it('renvoie le cache sans appeler le PMS quand la clé existe', async () => {
    const cached: SearchHotelsResult = {
      items: [],
      page: 1,
      pageSize: 12,
      totalCount: 0,
    };
    get.mockResolvedValueOnce(JSON.stringify(cached));

    const result = await service.searchHotels(baseQuery);

    expect(result).toEqual(cached);
    expect(getList).not.toHaveBeenCalled();
  });

  it('borne le fan-out au plafond `maxHotels` (25) même si le PMS renvoie plus de candidats', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `h${i}`,
      currency: 'EUR',
    }));
    getList.mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/search')) {
        return Promise.resolve(hotelList(many));
      }
      return Promise.resolve(roomList([{ price: 100 }]));
    });

    await service.searchHotels(baseQuery);

    expect(roomCallPaths(getList)).toHaveLength(25);
  });

  it('échec PARTIEL : un hôtel dont la dispo échoue est exclu, la recherche aboutit', async () => {
    getList.mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/search')) {
        return Promise.resolve(
          hotelList([
            { id: 'ok', currency: 'EUR' },
            { id: 'ko', currency: 'EUR' },
          ]),
        );
      }
      if (path.includes('/Rooms/hotel/ko/')) {
        return Promise.reject(new PmsUnavailableError('timeout'));
      }
      return Promise.resolve(roomList([{ price: 90 }]));
    });

    const result = await service.searchHotels(baseQuery);

    expect(result.items.map((h) => h.hotelId)).toEqual(['ok']);
  });

  it('dégradation GLOBALE : des candidats existent mais toutes les dispo échouent → PmsUnavailableError (503)', async () => {
    getList.mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/search')) {
        return Promise.resolve(
          hotelList([
            { id: 'a', currency: 'EUR' },
            { id: 'b', currency: 'EUR' },
          ]),
        );
      }
      return Promise.reject(new PmsUnavailableError('circuit ouvert'));
    });

    await expect(service.searchHotels(baseQuery)).rejects.toBeInstanceOf(
      PmsUnavailableError,
    );
  });

  it("propage l'indisponibilité PMS de l'étape candidats (503)", async () => {
    getList.mockRejectedValueOnce(new PmsUnavailableError('PMS down'));
    await expect(service.searchHotels(baseQuery)).rejects.toBeInstanceOf(
      PmsUnavailableError,
    );
  });

  it("pagine l'ensemble agrégé disponible", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `h${i}`,
      currency: 'EUR',
    }));
    getList.mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/search')) {
        return Promise.resolve(hotelList(many));
      }
      return Promise.resolve(roomList([{ price: 100 }]));
    });

    const result = await service.searchHotels({
      ...baseQuery,
      page: 2,
      pageSize: 2,
    });

    expect(result.totalCount).toBe(5);
    expect(result.items).toHaveLength(2);
  });

  it("envoie au PMS des dates ancrées en UTC (évite l'erreur Npgsql date-only)", async () => {
    getList.mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/search')) {
        return Promise.resolve(hotelList([{ id: 'h1', currency: 'EUR' }]));
      }
      return Promise.resolve(roomList([{ price: 100 }]));
    });

    await service.searchHotels(baseQuery);

    const roomPath = decodeURIComponent(roomCallPaths(getList)[0]);
    expect(roomPath).toContain('CheckInDate=2026-08-01T00:00:00Z');
    expect(roomPath).toContain('CheckOutDate=2026-08-03T00:00:00Z');
  });

  it('panne PARTIELLE masquée corrigée : 1 hôtel vide + 1 en panne → 503 (jamais « 0 résultat »)', async () => {
    getList.mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/search')) {
        return Promise.resolve(
          hotelList([
            { id: 'vide', currency: 'EUR' },
            { id: 'panne', currency: 'EUR' },
          ]),
        );
      }
      if (path.includes('/Rooms/hotel/panne/')) {
        return Promise.reject(new PmsUnavailableError('timeout'));
      }
      return Promise.resolve(roomList([])); // hôtel 'vide' : 0 chambre dispo
    });

    await expect(service.searchHotels(baseQuery)).rejects.toBeInstanceOf(
      PmsUnavailableError,
    );
  });

  it('4xx métier par hôtel → exclu SANS dégradation (tous 4xx → liste vide, pas de 503)', async () => {
    getList.mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/search')) {
        return Promise.resolve(
          hotelList([
            { id: 'a', currency: 'EUR' },
            { id: 'b', currency: 'EUR' },
          ]),
        );
      }
      return Promise.reject(new PmsRequestError('Introuvable', 404));
    });

    const result = await service.searchHotels(baseQuery);
    expect(result.totalCount).toBe(0);
    expect(result.items).toEqual([]);
  });

  it('data:null des candidats → liste vide sans crash', async () => {
    getList.mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/search')) {
        return Promise.resolve({
          success: true,
          data: null,
          pagination: meta(0),
        } as unknown as ApiListResponse<PmsHotel>);
      }
      return Promise.resolve(roomList([{ price: 100 }]));
    });

    const result = await service.searchHotels(baseQuery);
    expect(result.totalCount).toBe(0);
    expect(getList).toHaveBeenCalledTimes(1); // aucun fan-out (0 candidat)
  });

  it('prix ≤ 0 ignoré : un hôtel sans chambre à prix positif est exclu', async () => {
    getList.mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/search')) {
        return Promise.resolve(hotelList([{ id: 'gratuit', currency: 'EUR' }]));
      }
      return Promise.resolve(roomList([{ price: 0 }, { price: -10 }]));
    });

    const result = await service.searchHotels(baseQuery);
    expect(result.items).toEqual([]);
  });

  it("devise NULLE exclue (pas de repli EUR) d'une recherche EUR", async () => {
    getList.mockImplementation((path: string) => {
      if (path.startsWith('/Hotels/search')) {
        return Promise.resolve(
          hotelList([
            { id: 'eur', currency: 'EUR' },
            { id: 'null', currency: null },
          ]),
        );
      }
      return Promise.resolve(roomList([{ price: 100 }]));
    });

    const result = await service.searchHotels(baseQuery);
    expect(result.items.map((h) => h.hotelId)).toEqual(['eur']);
  });

  describe('searchNearby (FR-2 — proximité)', () => {
    it('appelle /Hotels/nearby avec lat/long/rayon/MaxResults et propage distanceKm', async () => {
      getList.mockImplementation((path: string) => {
        if (path.startsWith('/Hotels/nearby')) {
          return Promise.resolve(
            nearbyList([
              {
                id: 'h1',
                currency: 'EUR',
                distanceKm: 1.2,
                latitude: -18.9,
                longitude: 47.5,
              },
            ]),
          );
        }
        return Promise.resolve(roomList([{ price: 100, capacity: 2 }]));
      });

      const result = await service.searchNearby(baseNearby);

      const path = decodeURIComponent(nearbyCallPath(getList) ?? '');
      expect(path).toContain('Latitude=-18.9');
      expect(path).toContain('Longitude=47.5');
      expect(path).toContain('RadiusKm=10'); // défaut appliqué (radiusKm absent)
      expect(path).toContain('MaxResults=25');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].distanceKm).toBe(1.2);
    });

    it('trie les résultats par distance croissante (défaut FR-2)', async () => {
      getList.mockImplementation((path: string) => {
        if (path.startsWith('/Hotels/nearby')) {
          // Volontairement dans le désordre : le service doit re-trier par distance.
          return Promise.resolve(
            nearbyList([
              { id: 'loin', currency: 'EUR', distanceKm: 8 },
              { id: 'proche', currency: 'EUR', distanceKm: 0.5 },
              { id: 'moyen', currency: 'EUR', distanceKm: 3 },
            ]),
          );
        }
        return Promise.resolve(roomList([{ price: 100 }]));
      });

      const result = await service.searchNearby(baseNearby);

      expect(result.items.map((h) => h.hotelId)).toEqual([
        'proche',
        'moyen',
        'loin',
      ]);
      expect(result.items.map((h) => h.distanceKm)).toEqual([0.5, 3, 8]);
    });

    it('écarte une distanceKm négative/non-finie (null) et ne la trie pas en tête', async () => {
      getList.mockImplementation((path: string) => {
        if (path.startsWith('/Hotels/nearby')) {
          return Promise.resolve(
            nearbyList([
              { id: 'neg', currency: 'EUR', distanceKm: -5 },
              { id: 'ok', currency: 'EUR', distanceKm: 2 },
            ]),
          );
        }
        return Promise.resolve(roomList([{ price: 100 }]));
      });

      const result = await service.searchNearby(baseNearby);

      const neg = result.items.find((h) => h.hotelId === 'neg');
      const ok = result.items.find((h) => h.hotelId === 'ok');
      expect(neg?.distanceKm).toBeNull(); // négatif → null (pas « à -5 km »)
      expect(ok?.distanceKm).toBe(2);
      // Distance nulle triée en dernier (Infinity) : le négatif ne trône pas en tête.
      expect(result.items[0].hotelId).toBe('ok');
    });

    it('segmente par devise (un hôtel USD est exclu de la proximité EUR)', async () => {
      getList.mockImplementation((path: string) => {
        if (path.startsWith('/Hotels/nearby')) {
          return Promise.resolve(
            nearbyList([
              { id: 'eur', currency: 'EUR', distanceKm: 1 },
              { id: 'usd', currency: 'USD', distanceKm: 0.2 },
            ]),
          );
        }
        return Promise.resolve(roomList([{ price: 100 }]));
      });

      const result = await service.searchNearby(baseNearby);
      expect(result.items.map((h) => h.hotelId)).toEqual(['eur']);
    });

    it('borne le rayon demandé au maximum configuré (100 km)', async () => {
      getList.mockImplementation((path: string) => {
        if (path.startsWith('/Hotels/nearby')) {
          return Promise.resolve(
            nearbyList([{ id: 'h1', currency: 'EUR', distanceKm: 5 }]),
          );
        }
        return Promise.resolve(roomList([{ price: 100 }]));
      });

      await service.searchNearby({ ...baseNearby, radiusKm: 9999 });

      const path = decodeURIComponent(nearbyCallPath(getList) ?? '');
      expect(path).toContain('RadiusKm=100');
    });

    it('0 candidat dans le rayon → liste vide (PAS de dégradation 503)', async () => {
      getList.mockImplementation((path: string) => {
        if (path.startsWith('/Hotels/nearby')) {
          return Promise.resolve(nearbyList([]));
        }
        return Promise.resolve(roomList([{ price: 100 }]));
      });

      const result = await service.searchNearby(baseNearby);
      expect(result.totalCount).toBe(0);
      expect(result.items).toEqual([]);
      expect(getList).toHaveBeenCalledTimes(1); // aucun fan-out
    });

    it('indisponibilité PMS de /Hotels/nearby → PmsUnavailableError (503)', async () => {
      getList.mockRejectedValueOnce(new PmsUnavailableError('nearby down'));
      await expect(service.searchNearby(baseNearby)).rejects.toBeInstanceOf(
        PmsUnavailableError,
      );
    });

    it('clé de cache DISTINCTE de la recherche par destination (pas de collision)', async () => {
      // Le cache de destination ne doit PAS servir la proximité : la clé nearby étant absente,
      // `get` renvoie null → le PMS est bien sollicité et la clé écrite porte le préfixe nearby.
      get.mockResolvedValue(null);
      getList.mockImplementation((path: string) => {
        if (path.startsWith('/Hotels/nearby')) {
          return Promise.resolve(
            nearbyList([{ id: 'h1', currency: 'EUR', distanceKm: 2 }]),
          );
        }
        return Promise.resolve(roomList([{ price: 100 }]));
      });

      await service.searchNearby(baseNearby);
      expect(nearbyCallPath(getList)).toBeDefined();
      // La clé écrite porte le préfixe nearby (distinct de `search:hotels:v1:`).
      const writeCalls = set.mock.calls as unknown[][];
      const writtenKey =
        typeof writeCalls[0]?.[0] === 'string' ? writeCalls[0][0] : '';
      expect(writtenKey).toContain('search:nearby:v1:');
    });

    it('ancre les dates du fan-out en UTC (même correctif Npgsql que la destination)', async () => {
      getList.mockImplementation((path: string) => {
        if (path.startsWith('/Hotels/nearby')) {
          return Promise.resolve(
            nearbyList([{ id: 'h1', currency: 'EUR', distanceKm: 1 }]),
          );
        }
        return Promise.resolve(roomList([{ price: 100 }]));
      });

      await service.searchNearby(baseNearby);

      const roomPath = decodeURIComponent(roomCallPaths(getList)[0]);
      expect(roomPath).toContain('CheckInDate=2026-08-01T00:00:00Z');
      expect(roomPath).toContain('CheckOutDate=2026-08-03T00:00:00Z');
    });
  });

  describe('filtres & tri (FR-3 — story 1.8)', () => {
    /** Mock générique : candidats destination + dispo paramétrable par hôtel. */
    function mockSearch(
      hotels: Partial<PmsHotel>[],
      roomsByHotel: Record<string, Partial<PmsRoom>[]>,
    ) {
      getList.mockImplementation((path: string) => {
        if (path.startsWith('/Hotels/search')) {
          return Promise.resolve(hotelList(hotels));
        }
        const match = /\/Rooms\/hotel\/([^/]+)\/available/.exec(path);
        const id = match ? match[1] : '';
        return Promise.resolve(roomList(roomsByHotel[id] ?? []));
      });
    }

    it('filtre par fourchette de prix (sur le total du séjour, en cents)', async () => {
      // 2 nuits : prix/nuit 100 → total 20000 c ; 50 → 10000 c.
      mockSearch(
        [
          { id: 'cher', currency: 'EUR' },
          { id: 'pas-cher', currency: 'EUR' },
        ],
        { cher: [{ price: 100 }], 'pas-cher': [{ price: 50 }] },
      );

      const result = await service.searchHotels({
        ...baseQuery,
        minPrice: 15000,
      });

      expect(result.items.map((h) => h.hotelId)).toEqual(['cher']);
      expect(result.totalCount).toBe(1);
    });

    it('ignore une fourchette de prix incohérente (min > max) — aucun filtrage', async () => {
      mockSearch(
        [
          { id: 'a', currency: 'EUR' },
          { id: 'b', currency: 'EUR' },
        ],
        { a: [{ price: 100 }], b: [{ price: 50 }] },
      );

      const result = await service.searchHotels({
        ...baseQuery,
        minPrice: 20000,
        maxPrice: 5000,
      });

      expect(result.totalCount).toBe(2);
    });

    it("filtre par catégorie d'hôtel (insensible casse/accents, multi-valeurs)", async () => {
      mockSearch(
        [
          { id: 'quatre', currency: 'EUR', category: '4-star' },
          { id: 'boutique', currency: 'EUR', category: 'Boutique' },
          { id: 'autre', currency: 'EUR', category: 'Hostel' },
        ],
        {
          quatre: [{ price: 100 }],
          boutique: [{ price: 100 }],
          autre: [{ price: 100 }],
        },
      );

      const result = await service.searchHotels({
        ...baseQuery,
        category: ['4-STAR', 'boutiqué'],
      });

      expect(result.items.map((h) => h.hotelId).sort()).toEqual([
        'boutique',
        'quatre',
      ]);
    });

    it('capacité : resserre MinCapacity du fan-out (max(guests, minCapacity))', async () => {
      mockSearch([{ id: 'h1', currency: 'EUR' }], {
        h1: [{ price: 100, capacity: 6 }],
      });

      await service.searchHotels({ ...baseQuery, guests: 2, minCapacity: 4 });

      const roomPath = decodeURIComponent(roomCallPaths(getList)[0]);
      expect(roomPath).toContain('MinCapacity=4');
    });

    it('équipements : garde les hôtels dont une chambre porte TOUS les tokens ; recalcule le prix min', async () => {
      mockSearch(
        [
          { id: 'wifi', currency: 'EUR' },
          { id: 'sans', currency: 'EUR' },
        ],
        {
          // wifi : chambre chère AVEC wifi (200) + chambre pas chère SANS wifi (50).
          wifi: [
            { price: 200, amenities: 'WiFi, Parking' },
            { price: 50, amenities: 'Parking' },
          ],
          sans: [{ price: 50, amenities: 'Parking' }],
        },
      );

      const result = await service.searchHotels({
        ...baseQuery,
        amenities: ['wifi'],
      });

      expect(result.items.map((h) => h.hotelId)).toEqual(['wifi']);
      // Prix min recalculé PARMI les chambres wifi (200), pas la chambre à 50 sans wifi.
      expect(result.items[0].fromPricePerNight).toBe(20000);
      expect(result.items[0].availableRoomCount).toBe(1);
    });

    it("expose l'union des équipements (facette) indépendamment du filtre", async () => {
      mockSearch([{ id: 'h1', currency: 'EUR' }], {
        h1: [
          { price: 100, amenities: 'WiFi, Parking' },
          { price: 120, amenities: 'Piscine ; wifi' },
        ],
      });

      const result = await service.searchHotels(baseQuery);

      // Dé-dupliqué par forme normalisée (wifi une seule fois), formes d'affichage conservées.
      expect(result.items[0].amenities).toEqual(['WiFi', 'Parking', 'Piscine']);
    });

    it('trie par prix croissant puis décroissant (sur le total du séjour)', async () => {
      const hotels = [
        { id: 'c', currency: 'EUR' },
        { id: 'a', currency: 'EUR' },
        { id: 'b', currency: 'EUR' },
      ];
      const rooms = {
        a: [{ price: 50 }],
        b: [{ price: 100 }],
        c: [{ price: 150 }],
      };
      mockSearch(hotels, rooms);
      const asc = await service.searchHotels({
        ...baseQuery,
        sort: 'price_asc',
      });
      expect(asc.items.map((h) => h.hotelId)).toEqual(['a', 'b', 'c']);

      mockSearch(hotels, rooms);
      const desc = await service.searchHotels({
        ...baseQuery,
        sort: 'price_desc',
      });
      expect(desc.items.map((h) => h.hotelId)).toEqual(['c', 'b', 'a']);
    });

    it('sort=distance est un no-op en mode destination (ordre inchangé)', async () => {
      mockSearch(
        [
          { id: 'x', currency: 'EUR' },
          { id: 'y', currency: 'EUR' },
        ],
        { x: [{ price: 100 }], y: [{ price: 100 }] },
      );

      const result = await service.searchHotels({
        ...baseQuery,
        sort: 'distance',
      });

      // Aucun distanceKm en destination → ordre d'insertion préservé.
      expect(result.items.map((h) => h.hotelId)).toEqual(['x', 'y']);
      expect(result.items.every((h) => h.distanceKm === null)).toBe(true);
    });

    it('applique aussi les filtres/tri en mode proximité (prix, tri prix prime sur distance)', async () => {
      getList.mockImplementation((path: string) => {
        if (path.startsWith('/Hotels/nearby')) {
          return Promise.resolve(
            nearbyList([
              { id: 'proche-cher', currency: 'EUR', distanceKm: 0.5 },
              { id: 'loin-pas-cher', currency: 'EUR', distanceKm: 9 },
            ]),
          );
        }
        const match = /\/Rooms\/hotel\/([^/]+)\/available/.exec(path);
        const id = match ? match[1] : '';
        const price = id === 'proche-cher' ? 200 : 50;
        return Promise.resolve(roomList([{ price }]));
      });

      const result = await service.searchNearby({
        ...baseNearby,
        sort: 'price_asc',
      });

      // Tri prix ↑ prime sur le défaut distance : le moins cher (loin) passe devant.
      expect(result.items.map((h) => h.hotelId)).toEqual([
        'loin-pas-cher',
        'proche-cher',
      ]);
    });

    it('clé de cache distincte selon les filtres (une vue filtrée ne sert pas la vue non filtrée)', async () => {
      mockSearch([{ id: 'h1', currency: 'EUR' }], { h1: [{ price: 100 }] });
      await service.searchHotels(baseQuery);
      await service.searchHotels({ ...baseQuery, minPrice: 5000 });

      const keys = (set.mock.calls as unknown[][]).map((c) =>
        typeof c[0] === 'string' ? c[0] : '',
      );
      expect(new Set(keys).size).toBe(2); // deux clés différentes
    });
  });
});
