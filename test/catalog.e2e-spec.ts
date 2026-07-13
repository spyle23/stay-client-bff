import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import nock from 'nock';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { correlationMiddleware } from '../src/common/correlation/correlation.middleware';

const PMS_HOST = 'http://pms.catalog.local';
const AVAILABLE = 1; // RoomStatus.Available

/** Date-only UTC `AAAA-MM-JJ` décalée de `days` jours (garde les dates dans le futur). */
function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function hotelBody(hotel: Record<string, unknown>) {
  return { success: true, data: hotel, message: null, errors: null };
}
function roomListBody(rooms: Record<string, unknown>[]) {
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
    message: null,
    errors: null,
  };
}
function imagesBody(images: Record<string, unknown>[]) {
  return { success: true, data: images, message: null, errors: null };
}

interface HotelDetailBody {
  success: boolean;
  data: {
    id: string;
    name: string | null;
    currency: string;
    rooms: {
      id: string;
      pricePerNight: number;
      totalPrice: number | null;
      nights: number | null;
      currency: string;
    }[];
    gallery: { url: string; roomNumber: string | null }[];
    roomsUnavailable: boolean;
  };
}

/**
 * Intégration `GET /api/v1/catalog/hotels/:id` contre un **Redis réel** (127.0.0.1:6379) et un
 * **PMS mocké** (nock). Prouve : agrégation détail + chambres + galerie, 404 hôtel introuvable,
 * **rejet d'un id non-GUID**, repli sans dates, garde whitelist (param inconnu → 400), cache.
 *
 * Chaque test utilise un **GUID unique** : le Redis étant réel, un id partagé ferait fuiter le
 * cache (détail ET galerie) d'un test à l'autre.
 */
describe('/api/v1/catalog/hotels/:id (e2e — Redis réel + PMS mocké)', () => {
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

  it('200 : détail + chambres datées (total dérivé) + galerie composée + corrélation', async () => {
    const id = randomUUID();
    nock(PMS_HOST)
      .get(`/api/v1/Hotels/${id}`)
      .reply(
        200,
        hotelBody({
          id,
          name: 'Hôtel Test',
          category: '4-star',
          city: 'Antananarivo',
          currency: 'EUR',
          logoUrl: 'https://img/logo.png',
          rcs: 'SECRET-RCS',
        }),
      );
    // Chambres affichées (datées).
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${id}/available`)
      .query(true)
      .reply(
        200,
        roomListBody([
          {
            id: 'r1',
            number: '101',
            price: 120,
            capacity: 2,
            status: AVAILABLE,
          },
        ]),
      );
    // Source de la galerie : liste NON datée (indépendante de la disponibilité).
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${id}`)
      .query(true)
      .reply(
        200,
        roomListBody([
          {
            id: 'r1',
            number: '101',
            price: 120,
            capacity: 2,
            status: AVAILABLE,
          },
        ]),
      );
    nock(PMS_HOST)
      .get('/api/v1/Files/rooms/r1/images')
      .reply(200, imagesBody([{ url: 'https://img/r1.png', isPrimary: true }]));

    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/hotels/${id}`)
      .query({ checkInDate: checkIn, checkOutDate: checkOut, guests: 2 });

    const body = res.body as HotelDetailBody;
    expect(res.status).toBe(200);
    expect(body.data.rooms[0].pricePerNight).toBe(12000);
    expect(body.data.rooms[0].totalPrice).toBe(24000); // 12000 × 2 nuits
    expect(body.data.rooms[0].currency).toBe('EUR');
    expect(body.data.gallery.map((g) => g.url)).toEqual([
      'https://img/logo.png',
      'https://img/r1.png',
    ]);
    expect(body.data.roomsUnavailable).toBe(false);
    expect(body.data).not.toHaveProperty('rcs');
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('404 quand le PMS ne trouve pas l’hôtel', async () => {
    const id = randomUUID();
    nock(PMS_HOST)
      .get(`/api/v1/Hotels/${id}`)
      .reply(404, { success: false, message: 'Hotel not found', data: null });

    const res = await request(app.getHttpServer()).get(
      `/api/v1/catalog/hotels/${id}`,
    );

    expect(res.status).toBe(404);
    expect((res.body as { success: boolean }).success).toBe(false);
  });

  /**
   * Revue (sécurité) : l'id est interpolé dans les chemins PMS → un id non-GUID doit être rejeté
   * AVANT tout appel, sinon un appelant pourrait injecter une query ou une traversée de chemin.
   */
  it('400 : un id non-GUID est rejeté sans aucun appel PMS', async () => {
    const pmsScope = nock(PMS_HOST)
      .get(/\/api\/v1\/Hotels\/.*/)
      .reply(200, hotelBody({ id: 'x', currency: 'EUR' }));

    const res = await request(app.getHttpServer()).get(
      '/api/v1/catalog/hotels/..%2F..%2FReservations',
    );

    expect(res.status).toBe(400);
    expect(pmsScope.isDone()).toBe(false);
  });

  it('sans dates : chambres via l’endpoint non daté, prix/nuit seul', async () => {
    const id = randomUUID();
    nock(PMS_HOST)
      .get(`/api/v1/Hotels/${id}`)
      .reply(200, hotelBody({ id, name: 'H2', currency: 'EUR' }));
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${id}`)
      .query(true)
      .times(2) // affichage + source de galerie
      .reply(
        200,
        roomListBody([{ id: 'r1', price: 90, capacity: 2, status: AVAILABLE }]),
      );
    nock(PMS_HOST)
      .get('/api/v1/Files/rooms/r1/images')
      .reply(200, imagesBody([]));

    const res = await request(app.getHttpServer()).get(
      `/api/v1/catalog/hotels/${id}`,
    );

    const body = res.body as HotelDetailBody;
    expect(res.status).toBe(200);
    expect(body.data.rooms[0].pricePerNight).toBe(9000);
    expect(body.data.rooms[0].totalPrice).toBeNull();
    expect(body.data.rooms[0].nights).toBeNull();
  });

  it('400 : un paramètre non déclaré au DTO est rejeté (garde whitelist)', async () => {
    const id = randomUUID();
    const pmsScope = nock(PMS_HOST)
      .get(`/api/v1/Hotels/${id}`)
      .reply(200, hotelBody({ id, currency: 'EUR' }));

    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/hotels/${id}`)
      .query({ foo: 'bar' });

    expect(res.status).toBe(400);
    expect(pmsScope.isDone()).toBe(false);
  });

  it('cache : un 2ᵉ appel identique ne resollicite pas le PMS', async () => {
    const id = randomUUID();
    nock(PMS_HOST)
      .get(`/api/v1/Hotels/${id}`)
      .reply(200, hotelBody({ id, name: 'Cache Hotel', currency: 'EUR' }));
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${id}/available`)
      .query(true)
      .reply(200, roomListBody([{ id: 'r1', price: 80, status: AVAILABLE }]));
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${id}`)
      .query(true)
      .reply(200, roomListBody([{ id: 'r1', price: 80, status: AVAILABLE }]));
    nock(PMS_HOST)
      .get('/api/v1/Files/rooms/r1/images')
      .reply(200, imagesBody([]));

    const query = { checkInDate: checkIn, checkOutDate: checkOut, guests: 2 };

    const first = await request(app.getHttpServer())
      .get(`/api/v1/catalog/hotels/${id}`)
      .query(query);
    expect(first.status).toBe(200);

    // Interceptions consommées : un 2ᵉ appel sans cache tenterait le PMS → échec réseau.
    const second = await request(app.getHttpServer())
      .get(`/api/v1/catalog/hotels/${id}`)
      .query(query);
    expect(second.status).toBe(200);
    expect((second.body as HotelDetailBody).data.name).toBe('Cache Hotel');
  });
});
