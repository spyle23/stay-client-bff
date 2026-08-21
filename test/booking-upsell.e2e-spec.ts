import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import nock from 'nock';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { correlationMiddleware } from '../src/common/correlation/correlation.middleware';
import {
  AUTH_OPTIONS,
  type AuthOptions,
  SESSION_KEY_PREFIX,
} from '../src/modules/auth/auth.constants';
import { buildSessionCookie } from '../src/modules/auth/session-cookie';
import {
  HOLD_INDEX_KEY,
  HOLD_KEY_PREFIX,
} from '../src/modules/booking/checkout-hold.service';
import { RedisService } from '../src/redis/redis.service';

const PMS_HOST = 'http://pms.upsell.local';
const PMS_PREFIX = '/api/v1';

function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const CHECK_IN = isoDatePlus(30);
const CHECK_OUT = isoDatePlus(32);
const SERVICE_DATE = isoDatePlus(31);

interface CatalogEnvelope {
  success: boolean;
  data: {
    services: {
      serviceId: string;
      name: string;
      unitPrice: number;
      currency: string;
      unit: string | null;
    }[];
    degraded: boolean;
  };
}

interface ReservationEnvelope {
  success: boolean;
  data: {
    reservationId: string;
    roomTotal: number;
    servicesTotal: number;
    total: number;
    services: {
      serviceId: string;
      quantity: number;
      lineTotal: number;
      status: string;
    }[];
  };
}

interface ErrorEnvelope {
  success: boolean;
  message: string;
  errors?: Record<string, string[]>;
}

/**
 * Upsell de services (story 2.6 — FR-11 / dépendance D6) contre un **Redis réel** et un **PMS
 * mocké** (nock).
 *
 * Ce que seul ce niveau prouve :
 * - le **corps réellement envoyé** au PMS à la création (lignes de service, dates ancrées UTC,
 *   et surtout la clé `services` **absente** quand le panier est vide) ;
 * - que le total qui traverse le BFF est bien le **grand total** du PMS, pas le total chambre ;
 * - que le refus « panier gelé par le paiement » ressort en motif métier lisible, pas en 503 ;
 * - qu'une panne du catalogue **n'interrompt pas** le tunnel.
 *
 * Isolation : identifiants tirés par test (même discipline que `booking-reservation.e2e-spec.ts`),
 * aucune purge Redis par motif — le Redis est partagé entre suites.
 */
describe('booking upsell (e2e — Redis réel + PMS mocké)', () => {
  let app: NestExpressApplication;
  let redis: RedisService;
  let options: AuthOptions;

  let hotelId: string;
  let roomId: string;
  let reservationId: string;
  let serviceId: string;
  let userId: string;
  let cookie: string;
  let openedSids: string[] = [];

  const servicesPath = () => `${PMS_PREFIX}/hotels/${hotelId}/services`;
  const createPath = () =>
    `${PMS_PREFIX}/roomreservations/hotels/${hotelId}/reservations`;
  const basketPath = () =>
    `${PMS_PREFIX}/roomreservations/${reservationId}/services`;
  const reservationPath = () =>
    `${PMS_PREFIX}/roomreservations/${reservationId}`;

  /** Catalogue PMS : un spa vendable à 30 (décimal, comme le vrai `HotelServiceDto`). */
  const catalogBody = (overrides: Record<string, unknown>[] = []) => ({
    success: true,
    data: [
      {
        id: serviceId,
        hotelId,
        name: 'Spa',
        price: 30,
        unit: 'par séance',
        description: 'Accès spa',
        isActive: true,
        isExternallyBookable: true,
        externalQuantity: 0,
      },
      ...overrides,
    ],
  });

  const reservationBody = (withServices: boolean) => ({
    success: true,
    data: {
      id: reservationId,
      reservationCode: 'RES-20260901-A1B2C',
      hotelId,
      hotelName: 'Hôtel Colline',
      roomId,
      roomNumber: '204',
      customerId: userId,
      checkInDate: `${CHECK_IN}T00:00:00Z`,
      checkOutDate: `${CHECK_OUT}T00:00:00Z`,
      numberOfGuests: 2,
      numberOfNights: 2,
      pricePerNight: 84,
      totalPrice: 168,
      servicesTotal: withServices ? 60 : 0,
      grandTotal: withServices ? 228 : 168,
      services: withServices
        ? [
            {
              id: randomUUID(),
              serviceId,
              serviceName: 'Spa',
              price: 30,
              quantity: 2,
              totalPrice: 60,
              serviceDate: `${SERVICE_DATE}T00:00:00Z`,
              status: 1,
            },
          ]
        : [],
      status: 1,
    },
  });

  /** Lectures `catalog` du pré-contrôle (hôtel + chambres + dispo + images). */
  function mockPrecheck() {
    const room = {
      id: roomId,
      hotelId,
      number: '204',
      category: 'Double Confort',
      capacity: 2,
      price: 84,
      status: 1,
    };
    nock(PMS_HOST)
      .get(`${PMS_PREFIX}/Hotels/${hotelId}`)
      .times(4)
      .reply(200, { success: true, data: { id: hotelId, currency: 'EUR' } })
      .get(`${PMS_PREFIX}/Rooms/hotel/${hotelId}`)
      .query(true)
      .times(4)
      .reply(200, { success: true, data: [room], pagination: {} })
      .get(`${PMS_PREFIX}/Rooms/hotel/${hotelId}/available`)
      .query(true)
      .times(4)
      .reply(200, { success: true, data: [room], pagination: {} })
      .get(`${PMS_PREFIX}/Files/rooms/${roomId}/images`)
      .times(4)
      .reply(200, { success: true, data: [] });
  }

  const createBody = (overrides: Record<string, unknown> = {}) => ({
    hotelId,
    roomId,
    checkInDate: CHECK_IN,
    checkOutDate: CHECK_OUT,
    guests: 2,
    expectedTotal: 16_800,
    expectedCurrency: 'EUR',
    ...overrides,
  });

  async function openSession(accountId: string): Promise<string> {
    const newSid = `e2e-upsell-${randomUUID()}`;
    await redis.set(
      SESSION_KEY_PREFIX + newSid,
      JSON.stringify({
        userId: accountId,
        email: 'lea@example.com',
        firstName: 'Léa',
        lastName: 'Voyageuse',
        role: 4,
        accessToken: 'access-1',
        accessTokenExpiration: new Date(Date.now() + 3_600_000).toISOString(),
        refreshToken: 'refresh-1',
        refreshTokenExpiration: new Date(
          Date.now() + 7 * 86_400_000,
        ).toISOString(),
      }),
      3600,
    );
    openedSids.push(newSid);
    return buildSessionCookie(newSid, 3600, {
      cookieName: options.cookieName,
      sessionSecret: options.sessionSecret,
      cookieSecure: options.cookieSecure,
    }).split(';')[0];
  }

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    process.env.PMS_BASE_URL = `${PMS_HOST}${PMS_PREFIX}`;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', true);
    app.use(correlationMiddleware);
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
    await app.init();

    redis = app.get(RedisService);
    options = app.get<AuthOptions>(AUTH_OPTIONS);

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  beforeEach(async () => {
    hotelId = randomUUID();
    roomId = randomUUID();
    reservationId = randomUUID();
    serviceId = randomUUID();
    userId = randomUUID();
    openedSids = [];
    cookie = await openSession(userId);
  });

  afterEach(async () => {
    nock.cleanAll();
    for (const openedSid of openedSids) {
      await redis.del(SESSION_KEY_PREFIX + openedSid);
    }
    await redis.del(HOLD_KEY_PREFIX + reservationId);
    await redis.raw.zrem(HOLD_INDEX_KEY, reservationId);
  });

  afterAll(async () => {
    nock.enableNetConnect();
    await app.close();
  });

  // --- Catalogue ---------------------------------------------------------------------------

  it('sert le catalogue en unités mineures, sans les services déjà inclus', async () => {
    mockPrecheck();
    nock(PMS_HOST).get(servicesPath()).reply(200, catalogBody());

    const res = await request(app.getHttpServer())
      .get('/api/v1/booking/services')
      .set('Cookie', cookie)
      .query({
        hotelId,
        roomId,
        checkInDate: CHECK_IN,
        checkOutDate: CHECK_OUT,
        guests: 2,
      })
      .expect(200);

    const body = res.body as CatalogEnvelope;
    expect(body.data.degraded).toBe(false);
    expect(body.data.services).toEqual([
      {
        serviceId,
        name: 'Spa',
        description: 'Accès spa',
        unitPrice: 3_000,
        currency: 'EUR',
        unit: 'par séance',
      },
    ]);
  });

  it('n’interrompt pas le tunnel quand le catalogue PMS tombe', async () => {
    mockPrecheck();
    nock(PMS_HOST).get(servicesPath()).reply(500, { success: false });

    const res = await request(app.getHttpServer())
      .get('/api/v1/booking/services')
      .set('Cookie', cookie)
      .query({
        hotelId,
        roomId,
        checkInDate: CHECK_IN,
        checkOutDate: CHECK_OUT,
        guests: 2,
      })
      .expect(200);

    const body = res.body as CatalogEnvelope;
    expect(body.data).toEqual({ services: [], degraded: true });
  });

  it('refuse la lecture du catalogue sans session', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/booking/services')
      .query({
        hotelId,
        roomId,
        checkInDate: CHECK_IN,
        checkOutDate: CHECK_OUT,
        guests: 2,
      })
      .expect(401);
  });

  // --- Création ----------------------------------------------------------------------------

  it('envoie les lignes de service au PMS, dates ancrées UTC et sans prix', async () => {
    mockPrecheck();
    nock(PMS_HOST).get(servicesPath()).times(2).reply(200, catalogBody());

    let sentBody: Record<string, unknown> = {};
    nock(PMS_HOST)
      .post(createPath(), (body: Record<string, unknown>) => {
        sentBody = body;
        return true;
      })
      .reply(201, reservationBody(true));

    await request(app.getHttpServer())
      .post('/api/v1/booking/reservations')
      .set('Cookie', cookie)
      .send(
        createBody({
          expectedTotal: 22_800,
          services: [{ serviceId, quantity: 2, serviceDate: SERVICE_DATE }],
        }),
      )
      .expect(201);

    expect(sentBody.services).toEqual([
      { serviceId, quantity: 2, serviceDate: `${SERVICE_DATE}T00:00:00Z` },
    ]);
    // Le prix ne traverse jamais la frontière : il est relu du catalogue des deux côtés.
    expect(JSON.stringify(sentBody)).not.toContain('price');
  });

  it('OMET la clé `services` sans panier — corps identique à l’avant-D6', async () => {
    mockPrecheck();

    let sentBody: Record<string, unknown> = {};
    nock(PMS_HOST)
      .post(createPath(), (body: Record<string, unknown>) => {
        sentBody = body;
        return true;
      })
      .reply(201, reservationBody(false));

    await request(app.getHttpServer())
      .post('/api/v1/booking/reservations')
      .set('Cookie', cookie)
      .send(createBody())
      .expect(201);

    expect(sentBody).not.toHaveProperty('services');
  });

  it('expose le grand total comme montant qui engage', async () => {
    mockPrecheck();
    nock(PMS_HOST).get(servicesPath()).times(2).reply(200, catalogBody());
    nock(PMS_HOST).post(createPath()).reply(201, reservationBody(true));

    const res = await request(app.getHttpServer())
      .post('/api/v1/booking/reservations')
      .set('Cookie', cookie)
      .send(
        createBody({
          expectedTotal: 22_800,
          services: [{ serviceId, quantity: 2, serviceDate: SERVICE_DATE }],
        }),
      )
      .expect(201);

    const body = res.body as ReservationEnvelope;
    expect(body.data.roomTotal).toBe(16_800);
    expect(body.data.servicesTotal).toBe(6_000);
    expect(body.data.total).toBe(22_800);
    expect(body.data.services).toHaveLength(1);
  });

  it('refuse un total annoncé qui oublie les services, sans rien écrire au PMS', async () => {
    mockPrecheck();
    nock(PMS_HOST).get(servicesPath()).reply(200, catalogBody());
    const create = nock(PMS_HOST).post(createPath()).reply(201, {});

    const res = await request(app.getHttpServer())
      .post('/api/v1/booking/reservations')
      .set('Cookie', cookie)
      .send(
        createBody({
          expectedTotal: 16_800, // total chambre seul
          services: [{ serviceId, quantity: 2, serviceDate: SERVICE_DATE }],
        }),
      )
      .expect(409);

    expect((res.body as ErrorEnvelope).errors?.reason).toEqual([
      'price-changed',
    ]);
    expect(create.isDone()).toBe(false);
  });

  it('rejette un panier hors bornes de validation (quantité nulle)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/booking/reservations')
      .set('Cookie', cookie)
      .send(
        createBody({
          services: [{ serviceId, quantity: 0, serviceDate: SERVICE_DATE }],
        }),
      )
      .expect(400);
  });

  // --- Modification du panier ----------------------------------------------------------------

  it('remplace le panier et relit la réservation', async () => {
    let sentBody: Record<string, unknown> = {};
    nock(PMS_HOST)
      .put(basketPath(), (body: Record<string, unknown>) => {
        sentBody = body;
        return true;
      })
      .reply(200, { success: true });
    nock(PMS_HOST)
      .get(reservationPath())
      .reply(200, reservationBody(true))
      .get(`${PMS_PREFIX}/Hotels/${hotelId}`)
      .times(2)
      .reply(200, { success: true, data: { id: hotelId, currency: 'EUR' } });

    const res = await request(app.getHttpServer())
      .put(`/api/v1/booking/reservations/${reservationId}/services`)
      .set('Cookie', cookie)
      .send({
        services: [{ serviceId, quantity: 2, serviceDate: SERVICE_DATE }],
      })
      .expect(200);

    expect(sentBody).toEqual({
      services: [
        { serviceId, quantity: 2, serviceDate: `${SERVICE_DATE}T00:00:00Z` },
      ],
    });
    expect((res.body as ReservationEnvelope).data.total).toBe(22_800);
  });

  it('traduit le panier gelé par un paiement en 409 lisible, jamais en 503', async () => {
    nock(PMS_HOST).put(basketPath()).reply(400, {
      success: false,
      message:
        'Cannot modify services: a payment is already engaged for this reservation',
    });

    const res = await request(app.getHttpServer())
      .put(`/api/v1/booking/reservations/${reservationId}/services`)
      .set('Cookie', cookie)
      .send({ services: [] })
      .expect(409);

    const body = res.body as ErrorEnvelope;
    expect(body.errors?.reason).toEqual(['services-locked']);
    // Aucun texte du PMS ne doit fuiter jusqu'au navigateur.
    expect(body.message).not.toContain('payment is already engaged');
  });

  it('refuse la modification du panier sans session', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/booking/reservations/${reservationId}/services`)
      .send({ services: [] })
      .expect(401);
  });
});
