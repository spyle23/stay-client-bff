import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import nock from 'nock';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { correlationMiddleware } from '../src/common/correlation/correlation.middleware';

const PMS_HOST = 'http://pms.nearby.local';

/** Date-only UTC `AAAA-MM-JJ` décalée de `days` jours (garde les dates dans le futur). */
function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nearbyBody(hotels: Record<string, unknown>[]) {
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

interface NearbyBody {
  success: boolean;
  data: {
    hotelId: string;
    distanceKm: number | null;
    fromTotalPrice: number;
    currency: string;
  }[];
  pagination: { totalCount: number };
}

/**
 * Intégration `GET /api/v1/search/hotels/nearby` (FR-2) contre un **Redis réel** et un **PMS mocké**
 * (nock). Prouve : candidats via `/Hotels/nearby` + fan-out dispo, tri par distance, `distanceKm`
 * dans la sortie, rejet 400 SANS appel PMS (coords invalides), 503 si PMS down, cache.
 */
describe('/api/v1/search/hotels/nearby (e2e — Redis réel + PMS mocké)', () => {
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

  it('200 : candidats /Hotels/nearby + fan-out, triés par distance, distanceKm exposé', async () => {
    nock(PMS_HOST)
      .get('/api/v1/Hotels/nearby')
      .query(true)
      .reply(
        200,
        nearbyBody([
          { id: 'loin', currency: 'EUR', distanceKm: 6.4 },
          { id: 'proche', currency: 'EUR', distanceKm: 0.8 },
        ]),
      );
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/loin/available')
      .query(true)
      .reply(200, roomListBody([{ price: 90 }], 1));
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/proche/available')
      .query(true)
      .reply(200, roomListBody([{ price: 120 }], 1));

    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels/nearby')
      .query({
        latitude: -18.9,
        longitude: 47.5,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guests: 2,
        currency: 'EUR',
      });

    const body = res.body as NearbyBody;
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.pagination.totalCount).toBe(2);
    // Tri par distance croissante par défaut (FR-2).
    expect(body.data.map((h) => h.hotelId)).toEqual(['proche', 'loin']);
    expect(body.data[0].distanceKm).toBe(0.8);
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('400 SANS appel PMS quand la latitude est hors bornes (preuve : interception non consommée)', async () => {
    const pmsScope = nock(PMS_HOST)
      .get('/api/v1/Hotels/nearby')
      .query(true)
      .reply(200, nearbyBody([]));

    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels/nearby')
      .query({
        latitude: 200, // hors [-90, 90]
        longitude: 47.5,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guests: 2,
        currency: 'EUR',
      });

    expect(res.status).toBe(400);
    const body = res.body as { success: boolean };
    expect(body.success).toBe(false);
    expect(pmsScope.isDone()).toBe(false);
    expect(nock.pendingMocks().length).toBeGreaterThan(0);
  });

  it('400 SANS appel PMS quand les coordonnées manquent', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels/nearby')
      .query({
        // latitude/longitude absents
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guests: 2,
        currency: 'EUR',
      });

    expect(res.status).toBe(400);
  });

  it('503 (dégradation) quand /Hotels/nearby est injoignable', async () => {
    nock(PMS_HOST)
      .get('/api/v1/Hotels/nearby')
      .query(true)
      .times(2)
      .replyWithError('ECONNREFUSED');

    const res = await request(app.getHttpServer())
      .get('/api/v1/search/hotels/nearby')
      .query({
        // Coordonnées distinctes des autres tests → pas de hit de cache masquant le 503.
        latitude: -20.1,
        longitude: 48.2,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guests: 2,
        currency: 'EUR',
      });

    expect(res.status).toBe(503);
  });

  it('cache : un 2ᵉ appel identique ne resollicite pas le PMS', async () => {
    nock(PMS_HOST)
      .get('/api/v1/Hotels/nearby')
      .query(true)
      .reply(200, nearbyBody([{ id: 'c1', currency: 'EUR', distanceKm: 2.2 }]));
    nock(PMS_HOST)
      .get('/api/v1/Rooms/hotel/c1/available')
      .query(true)
      .reply(200, roomListBody([{ price: 80 }], 1));

    // Coordonnées uniques pour éviter un hit de cache d'un run précédent.
    const jitter = Date.now() % 1000;
    const query = {
      latitude: -18 - jitter / 100000,
      longitude: 47.5,
      checkInDate: checkIn,
      checkOutDate: checkOut,
      guests: 2,
      currency: 'EUR',
    };

    const first = await request(app.getHttpServer())
      .get('/api/v1/search/hotels/nearby')
      .query(query);
    expect(first.status).toBe(200);

    const second = await request(app.getHttpServer())
      .get('/api/v1/search/hotels/nearby')
      .query(query);
    expect(second.status).toBe(200);
    const body = second.body as NearbyBody;
    expect(body.data[0].hotelId).toBe('c1');
  });
});
