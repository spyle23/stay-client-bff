import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import nock from 'nock';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { correlationMiddleware } from '../src/common/correlation/correlation.middleware';

const PMS_HOST = 'http://pms.filters.local';

/** Date-only UTC `AAAA-MM-JJ` décalée de `days` jours (garde les dates dans le futur). */
function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function hotelListBody(hotels: Record<string, unknown>[]) {
  return {
    success: true,
    data: hotels,
    pagination: pageMeta(hotels.length),
    message: null,
    errors: null,
  };
}
function roomListBody(rooms: Record<string, unknown>[], totalCount: number) {
  return {
    success: true,
    data: rooms,
    pagination: pageMeta(totalCount),
    message: null,
    errors: null,
  };
}
function pageMeta(count: number) {
  return {
    page: 1,
    pageSize: 100,
    totalCount: count,
    totalPages: 1,
    hasPreviousPage: false,
    hasNextPage: false,
  };
}

interface FiltersBody {
  success: boolean;
  data: {
    hotelId: string;
    category: string | null;
    fromTotalPrice: number;
    availableRoomCount: number;
    amenities: string[];
  }[];
  pagination: { totalCount: number };
}

/**
 * Intégration filtres & tri (FR-3, story 1.8) sur `GET /api/v1/search/hotels` — **Redis réel**
 * (127.0.0.1:6379) + **PMS mocké** (nock). Prouve : filtrage prix/catégorie/équipements + tri
 * côté BFF, capacité poussée au PMS (`MinCapacity`), garde whitelist (param non déclaré → 400),
 * robustesse (valeur de filtre douteuse ignorée, jamais 400).
 */
describe('/api/v1/search/hotels — filtres & tri (e2e — Redis réel + PMS mocké)', () => {
  let app: INestApplication<App>;
  const checkIn = isoDatePlus(30);
  const checkOut = isoDatePlus(32); // 2 nuits

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    process.env.PMS_BASE_URL = `${PMS_HOST}/api/v1`;
    process.env.PMS_MAX_RETRIES = '1';
    process.env.PMS_RETRY_BASE_DELAY_MS = '1';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(correlationMiddleware);
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
    await app.init();

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(async () => {
    nock.enableNetConnect();
    await app.close();
  });

  /** Query de base avec une destination unique (anti-collision de cache Redis entre tests). */
  function query(extra: Record<string, unknown>) {
    return {
      destination: `Filters-${Math.random().toString(36).slice(2)}`,
      checkInDate: checkIn,
      checkOutDate: checkOut,
      guests: 2,
      currency: 'EUR',
      ...extra,
    };
  }

  it('200 : filtre par fourchette de prix (sur le total du séjour) + tri prix croissant', async () => {
    nock(PMS_HOST)
      .get('/api/v1/Hotels/search')
      .query(true)
      .reply(
        200,
        hotelListBody([
          { id: 'cher', currency: 'EUR' },
          { id: 'moyen', currency: 'EUR' },
          { id: 'pas-cher', currency: 'EUR' },
        ]),
      );
    // 2 nuits : 150→30000c, 100→20000c, 40→8000c.
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/cher/available')
      .query(true)
      .reply(200, roomListBody([{ price: 150 }], 1));
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/moyen/available')
      .query(true)
      .reply(200, roomListBody([{ price: 100 }], 1));
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/pas-cher/available')
      .query(true)
      .reply(200, roomListBody([{ price: 40 }], 1));

    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels')
      .query(query({ minPrice: 15000, sort: 'price_asc' }));

    expect(res.status).toBe(200);
    const body = res.body as FiltersBody;
    // pas-cher (8000c) exclu par minPrice ; tri prix ↑ → moyen avant cher.
    expect(body.data.map((h) => h.hotelId)).toEqual(['moyen', 'cher']);
    expect(body.pagination.totalCount).toBe(2);
  });

  it("200 : filtre par catégorie d'hôtel (insensible casse)", async () => {
    nock(PMS_HOST)
      .get('/api/v1/Hotels/search')
      .query(true)
      .reply(
        200,
        hotelListBody([
          { id: 'quatre', currency: 'EUR', category: '4-star' },
          { id: 'hostel', currency: 'EUR', category: 'Hostel' },
        ]),
      );
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/quatre/available')
      .query(true)
      .reply(200, roomListBody([{ price: 100 }], 1));
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/hostel/available')
      .query(true)
      .reply(200, roomListBody([{ price: 100 }], 1));

    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels')
      .query(query({ category: '4-STAR' }));

    expect(res.status).toBe(200);
    const body = res.body as FiltersBody;
    expect(body.data.map((h) => h.hotelId)).toEqual(['quatre']);
  });

  it('200 : capacité poussée au PMS (MinCapacity resserré à max(guests, minCapacity))', async () => {
    nock(PMS_HOST)
      .get('/api/v1/Hotels/search')
      .query(true)
      .reply(200, hotelListBody([{ id: 'h1', currency: 'EUR' }]));
    // L'interception n'accepte QUE MinCapacity=4 : si le BFF ne resserre pas, aucune correspondance.
    const roomScope = nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/h1/available')
      .query((q) => q.MinCapacity === '4')
      .reply(200, roomListBody([{ price: 100, capacity: 6 }], 1));

    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels')
      .query(query({ guests: 2, minCapacity: 4 }));

    expect(res.status).toBe(200);
    expect(roomScope.isDone()).toBe(true);
  });

  it('200 : filtre équipements (token match) + union exposée au contrat', async () => {
    nock(PMS_HOST)
      .get('/api/v1/Hotels/search')
      .query(true)
      .reply(
        200,
        hotelListBody([
          { id: 'wifi', currency: 'EUR' },
          { id: 'sans', currency: 'EUR' },
        ]),
      );
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/wifi/available')
      .query(true)
      .reply(
        200,
        roomListBody([{ price: 100, amenities: 'WiFi, Parking' }], 1),
      );
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/sans/available')
      .query(true)
      .reply(200, roomListBody([{ price: 100, amenities: 'Parking' }], 1));

    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels')
      .query(query({ amenities: 'wifi' }));

    expect(res.status).toBe(200);
    const body = res.body as FiltersBody;
    expect(body.data.map((h) => h.hotelId)).toEqual(['wifi']);
    expect(body.data[0].amenities).toEqual(
      expect.arrayContaining(['WiFi', 'Parking']),
    );
  });

  it('400 : un query-param NON déclaré est rejeté (garde whitelist)', async () => {
    // Interception armée mais qui NE DOIT PAS être consommée (rejet avant tout appel PMS).
    const pmsScope = nock(PMS_HOST)
      .get('/api/v1/Hotels/search')
      .query(true)
      .reply(200, hotelListBody([]));

    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels')
      .query(query({ bogusFilter: 'x' }));

    expect(res.status).toBe(400);
    expect(pmsScope.isDone()).toBe(false);
  });

  it('200 : une valeur de filtre douteuse est ignorée, jamais un 400 (robustesse AC-7)', async () => {
    nock(PMS_HOST)
      .get('/api/v1/Hotels/search')
      .query(true)
      .reply(200, hotelListBody([{ id: 'h1', currency: 'EUR' }]));
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/h1/available')
      .query(true)
      .reply(200, roomListBody([{ price: 100 }], 1));

    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels')
      // sort inconnu + minPrice négatif → normalisés/ignorés (pas de 400).
      .query(query({ sort: 'lol', minPrice: '-5' }));

    expect(res.status).toBe(200);
    const body = res.body as FiltersBody;
    expect(body.data.map((h) => h.hotelId)).toEqual(['h1']);
  });
});
