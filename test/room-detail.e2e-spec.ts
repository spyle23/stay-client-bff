import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import nock from 'nock';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { correlationMiddleware } from '../src/common/correlation/correlation.middleware';

const PMS_HOST = 'http://pms.room-detail.local';
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

interface RoomDetailBody {
  success: boolean;
  data: {
    id: string;
    hotelId: string;
    hotelName: string | null;
    pricePerNight: number;
    totalPrice: number | null;
    nights: number | null;
    currency: string;
    available: boolean;
    availabilityDegraded: boolean;
    images: { url: string }[];
    includedServices: { name: string; quantity: number | null }[];
  };
}

/**
 * Intégration `GET /api/v1/catalog/hotels/:hotelId/rooms/:roomId` (story 1.10) contre un **Redis
 * réel** (127.0.0.1:6379) et un **PMS mocké** (nock). Prouve : composition publique (hôtel + liste
 * non datée + set daté + images), disponibilité par cross-check, 404 chambre absente, rejet id
 * non-GUID, garde whitelist, repli sans dates, cache.
 *
 * GUID unique par test : le Redis étant réel, un id partagé ferait fuiter le cache d'un test à l'autre.
 */
describe('/api/v1/catalog/hotels/:hotelId/rooms/:roomId (e2e — Redis réel + PMS mocké)', () => {
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

  it('200 : fiche datée disponible (total dérivé, images triées, services inclus, corrélation)', async () => {
    const hotelId = randomUUID();
    const roomId = randomUUID();
    nock(PMS_HOST)
      .get(`/api/v1/Hotels/${hotelId}`)
      .reply(
        200,
        hotelBody({
          id: hotelId,
          name: 'Hôtel Test',
          city: 'Antananarivo',
          currency: 'EUR',
          rcs: 'SECRET-RCS',
        }),
      );
    // Liste NON datée (trouve la chambre, même indisponible).
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${hotelId}`)
      .query(true)
      .reply(
        200,
        roomListBody([
          {
            id: roomId,
            number: '101',
            category: 'Suite',
            capacity: 2,
            price: 120,
            status: AVAILABLE,
            includedServices: [
              {
                serviceName: 'Petit-déjeuner',
                includedQuantity: 2,
                isActive: true,
              },
            ],
          },
        ]),
      );
    // Set daté (cross-check de disponibilité).
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${hotelId}/available`)
      .query(true)
      .reply(
        200,
        roomListBody([{ id: roomId, price: 120, status: AVAILABLE }]),
      );
    nock(PMS_HOST)
      .get(`/api/v1/Files/rooms/${roomId}/images`)
      .reply(
        200,
        imagesBody([
          { url: 'https://img/2.png', displayOrder: 2 },
          { url: 'https://img/primary.png', isPrimary: true, displayOrder: 9 },
        ]),
      );

    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/hotels/${hotelId}/rooms/${roomId}`)
      .query({ checkInDate: checkIn, checkOutDate: checkOut, guests: 2 });

    const body = res.body as RoomDetailBody;
    expect(res.status).toBe(200);
    expect(body.data.id).toBe(roomId);
    expect(body.data.hotelName).toBe('Hôtel Test');
    expect(body.data.pricePerNight).toBe(12000);
    expect(body.data.totalPrice).toBe(24000); // 12000 × 2 nuits
    expect(body.data.nights).toBe(2);
    expect(body.data.available).toBe(true);
    expect(body.data.availabilityDegraded).toBe(false);
    expect(body.data.images.map((i) => i.url)).toEqual([
      'https://img/primary.png',
      'https://img/2.png',
    ]);
    expect(body.data.includedServices[0].name).toBe('Petit-déjeuner');
    expect(body.data).not.toHaveProperty('rcs');
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('indisponible : chambre absente du set daté → available=false', async () => {
    const hotelId = randomUUID();
    const roomId = randomUUID();
    nock(PMS_HOST)
      .get(`/api/v1/Hotels/${hotelId}`)
      .reply(200, hotelBody({ id: hotelId, currency: 'EUR' }));
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${hotelId}`)
      .query(true)
      .reply(
        200,
        roomListBody([
          { id: roomId, price: 120, capacity: 2, status: AVAILABLE },
        ]),
      );
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${hotelId}/available`)
      .query(true)
      .reply(200, roomListBody([])); // aucune dispo pour ces dates
    nock(PMS_HOST)
      .get(`/api/v1/Files/rooms/${roomId}/images`)
      .reply(200, imagesBody([]));

    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/hotels/${hotelId}/rooms/${roomId}`)
      .query({ checkInDate: checkIn, checkOutDate: checkOut, guests: 2 });

    const body = res.body as RoomDetailBody;
    expect(res.status).toBe(200);
    expect(body.data.available).toBe(false);
    expect(body.data.availabilityDegraded).toBe(false);
    expect(body.data.pricePerNight).toBe(12000); // fiche affichable
  });

  it('404 : chambre absente de l’hôtel', async () => {
    const hotelId = randomUUID();
    const roomId = randomUUID();
    nock(PMS_HOST)
      .get(`/api/v1/Hotels/${hotelId}`)
      .reply(200, hotelBody({ id: hotelId, currency: 'EUR' }));
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${hotelId}`)
      .query(true)
      .reply(
        200,
        roomListBody([{ id: randomUUID(), price: 90, status: AVAILABLE }]),
      );

    const res = await request(app.getHttpServer()).get(
      `/api/v1/catalog/hotels/${hotelId}/rooms/${roomId}`,
    );

    expect(res.status).toBe(404);
    expect((res.body as { success: boolean }).success).toBe(false);
  });

  /** Sécurité : un roomId non-GUID est rejeté AVANT tout appel PMS (id interpolé dans les chemins). */
  it('400 : un roomId non-GUID est rejeté sans aucun appel PMS', async () => {
    const hotelId = randomUUID();
    const pmsScope = nock(PMS_HOST)
      .get(/\/api\/v1\/Hotels\/.*/)
      .reply(200, hotelBody({ id: hotelId, currency: 'EUR' }));

    const res = await request(app.getHttpServer()).get(
      `/api/v1/catalog/hotels/${hotelId}/rooms/not-a-guid`,
    );

    expect(res.status).toBe(400);
    expect(pmsScope.isDone()).toBe(false);
  });

  it('400 : un paramètre non déclaré au DTO est rejeté (garde whitelist)', async () => {
    const hotelId = randomUUID();
    const roomId = randomUUID();
    const pmsScope = nock(PMS_HOST)
      .get(`/api/v1/Hotels/${hotelId}`)
      .reply(200, hotelBody({ id: hotelId, currency: 'EUR' }));

    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/hotels/${hotelId}/rooms/${roomId}`)
      .query({ foo: 'bar' });

    expect(res.status).toBe(400);
    expect(pmsScope.isDone()).toBe(false);
  });

  it('sans dates : prix par nuit, disponibilité statique, aucun appel /available', async () => {
    const hotelId = randomUUID();
    const roomId = randomUUID();
    nock(PMS_HOST)
      .get(`/api/v1/Hotels/${hotelId}`)
      .reply(200, hotelBody({ id: hotelId, currency: 'EUR' }));
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${hotelId}`)
      .query(true)
      .reply(
        200,
        roomListBody([
          { id: roomId, price: 90, capacity: 2, status: AVAILABLE },
        ]),
      );
    nock(PMS_HOST)
      .get(`/api/v1/Files/rooms/${roomId}/images`)
      .reply(200, imagesBody([]));

    const res = await request(app.getHttpServer()).get(
      `/api/v1/catalog/hotels/${hotelId}/rooms/${roomId}`,
    );

    const body = res.body as RoomDetailBody;
    expect(res.status).toBe(200);
    expect(body.data.pricePerNight).toBe(9000);
    expect(body.data.totalPrice).toBeNull();
    expect(body.data.available).toBe(true);
  });

  it('cache : un 2ᵉ appel identique ne resollicite pas le PMS', async () => {
    const hotelId = randomUUID();
    const roomId = randomUUID();
    nock(PMS_HOST)
      .get(`/api/v1/Hotels/${hotelId}`)
      .reply(200, hotelBody({ id: hotelId, name: 'Cache', currency: 'EUR' }));
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${hotelId}`)
      .query(true)
      .reply(200, roomListBody([{ id: roomId, price: 80, status: AVAILABLE }]));
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${hotelId}/available`)
      .query(true)
      .reply(200, roomListBody([{ id: roomId, price: 80, status: AVAILABLE }]));
    nock(PMS_HOST)
      .get(`/api/v1/Files/rooms/${roomId}/images`)
      .reply(200, imagesBody([]));

    const query = { checkInDate: checkIn, checkOutDate: checkOut, guests: 2 };
    const first = await request(app.getHttpServer())
      .get(`/api/v1/catalog/hotels/${hotelId}/rooms/${roomId}`)
      .query(query);
    expect(first.status).toBe(200);

    // Interceptions consommées : un 2ᵉ appel sans cache tenterait le PMS → échec réseau.
    const second = await request(app.getHttpServer())
      .get(`/api/v1/catalog/hotels/${hotelId}/rooms/${roomId}`)
      .query(query);
    expect(second.status).toBe(200);
    expect((second.body as RoomDetailBody).data.hotelName).toBe('Cache');
  });
});
