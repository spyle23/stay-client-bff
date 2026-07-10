import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import nock from 'nock';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { correlationMiddleware } from '../src/common/correlation/correlation.middleware';

const PMS_HOST = 'http://pms.search.local';

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

interface SearchBody {
  success: boolean;
  data: {
    hotelId: string;
    name: string | null;
    fromPricePerNight: number;
    fromTotalPrice: number;
    nights: number;
    thumbnailUrl: string | null;
    currency: string;
  }[];
  pagination: { totalCount: number };
}

/**
 * Intégration `GET /api/v1/search/hotels` contre un **Redis réel** (127.0.0.1:6379) et un
 * **PMS mocké** (nock). Prouve : fan-out + agrégation, rejet 400 SANS appel PMS, 503 si PMS down,
 * cache (2ᵉ appel identique ne resollicite pas le PMS), en-tête de corrélation.
 */
describe('/api/v1/search/hotels (e2e — Redis réel + PMS mocké)', () => {
  let app: INestApplication<App>;
  const checkIn = isoDatePlus(30);
  const checkOut = isoDatePlus(32); // 2 nuits

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    process.env.PMS_BASE_URL = `${PMS_HOST}/api/v1`;
    // Retries rapides pour le test de dégradation (le défaut ferait ~1 s de backoff).
    process.env.PMS_MAX_RETRIES = '1';
    process.env.PMS_RETRY_BASE_DELAY_MS = '1';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    // Reproduit le bootstrap de main.ts non porté par les providers (middleware + préfixe).
    app.use(correlationMiddleware);
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
    await app.init();

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1'); // supertest + Redis local
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(async () => {
    nock.enableNetConnect();
    await app.close();
  });

  it('200 : fan-out + agrégation « à partir de » (cents) + en-tête de corrélation', async () => {
    nock(PMS_HOST)
      .get('/api/v1/Hotels/search')
      .query(true)
      .reply(
        200,
        hotelListBody([
          {
            id: 'h1',
            name: 'Hôtel Test',
            city: 'Antananarivo',
            country: 'Madagascar',
            category: '4-star',
            currency: 'EUR',
            logoUrl: 'https://img/logo.png',
            latitude: -18.9,
            longitude: 47.5,
          },
        ]),
      );
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/h1/available')
      .query(true)
      .reply(200, roomListBody([{ price: 120, capacity: 2 }], 1));

    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels')
      .query({
        destination: 'Antananarivo',
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guests: 2,
        currency: 'EUR',
      });

    const body = res.body as SearchBody;
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.pagination.totalCount).toBe(1);
    expect(body.data[0].hotelId).toBe('h1');
    expect(body.data[0].fromPricePerNight).toBe(12000);
    expect(body.data[0].fromTotalPrice).toBe(24000);
    expect(body.data[0].nights).toBe(2);
    expect(body.data[0].thumbnailUrl).toBe('https://img/logo.png');
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('400 SANS appel PMS quand les voyageurs ≤ 0 (preuve directe : interception PMS NON consommée)', async () => {
    // Interception PMS armée mais qui NE DOIT PAS être sollicitée (AC-2).
    const pmsScope = nock(PMS_HOST)
      .get('/api/v1/Hotels/search')
      .query(true)
      .reply(200, hotelListBody([]));

    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels')
      .query({
        destination: 'Antananarivo',
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guests: 0,
        currency: 'EUR',
      });

    expect(res.status).toBe(400);
    const body = res.body as {
      success: boolean;
      errors?: Record<string, string[]>;
    };
    expect(body.success).toBe(false);
    expect(body.errors?.guests).toBeDefined();
    // Preuve AC-2 : aucune requête PMS émise (l'interception reste en attente).
    expect(pmsScope.isDone()).toBe(false);
    expect(nock.pendingMocks().length).toBeGreaterThan(0);
  });

  it('400 SANS appel PMS quand la date de départ ≤ arrivée', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels')
      .query({
        destination: 'Antananarivo',
        checkInDate: checkOut,
        checkOutDate: checkIn, // inversées
        guests: 2,
        currency: 'EUR',
      });

    expect(res.status).toBe(400);
  });

  it('503 (dégradation gracieuse) quand le PMS est injoignable', async () => {
    nock(PMS_HOST)
      .get('/api/v1/Hotels/search')
      .query(true)
      .times(2)
      .replyWithError('ECONNREFUSED');

    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels')
      .query({
        destination: 'Nosy Be',
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guests: 2,
        currency: 'EUR',
      });

    expect(res.status).toBe(503);
    const body = res.body as { success: boolean };
    expect(body.success).toBe(false);
  });

  it('cache : un 2ᵉ appel identique ne resollicite pas le PMS', async () => {
    nock(PMS_HOST)
      .get('/api/v1/Hotels/search')
      .query(true)
      .reply(
        200,
        hotelListBody([{ id: 'c1', currency: 'EUR', name: 'Cache Hotel' }]),
      );
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/c1/available')
      .query(true)
      .reply(200, roomListBody([{ price: 80 }], 1));

    const query = {
      destination: `Cache-${Date.now()}`,
      checkInDate: checkIn,
      checkOutDate: checkOut,
      guests: 2,
      currency: 'EUR',
    };

    const first = await request(app.getHttpServer())
      .get('/api/v1/search/hotels')
      .query(query);
    expect(first.status).toBe(200);

    // Interceptions consommées : un 2ᵉ appel sans cache tenterait le PMS → 503.
    const second = await request(app.getHttpServer())
      .get('/api/v1/search/hotels')
      .query(query);
    expect(second.status).toBe(200);
    const body = second.body as SearchBody;
    expect(body.data[0].hotelId).toBe('c1');
  });
});
