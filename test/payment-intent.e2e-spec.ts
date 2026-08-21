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
  type CheckoutHoldRecord,
  HOLD_INDEX_KEY,
  HOLD_KEY_PREFIX,
} from '../src/modules/booking/checkout-hold.service';
import { RedisService } from '../src/redis/redis.service';

const PMS_HOST = 'http://pms.payment.local';
const PMS_PREFIX = '/api/v1';

/** Date-only UTC décalée de `days` jours. */
function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const CHECK_IN = isoDatePlus(40);
const CHECK_OUT = isoDatePlus(42);

interface IntentEnvelope {
  success: boolean;
  data: {
    clientSecret: string;
    publishableKey: string;
    paymentIntentId: string;
    amount: number;
    currency: string;
    captureMethod: string;
  };
}

interface ErrorEnvelope {
  success: boolean;
  message: string;
  errors?: Record<string, string[]>;
}

/**
 * Demande de PaymentIntent (story 3.1 — FR-12 / FR-14 / AR-14) contre un **Redis réel**
 * (`redis://127.0.0.1:6379`) et un **PMS mocké** (nock).
 *
 * Ce qui n'est prouvable qu'ici, et pas en test unitaire :
 * - le **gel de hold réellement écrit dans Redis** (`paymentStarted`), donc l'effet concret de
 *   FR-14 sur l'enregistrement que le balayeur relira ;
 * - le **corps réellement envoyé** au PMS et les en-têtes qui l'accompagnent ;
 * - le **refus sans cookie de session**, tel que le navigateur le reçoit ;
 * - l'absence de `paymentId` PMS et de tout texte PMS dans la réponse ;
 * - les directives de cache d'une réponse porteuse d'un `clientSecret`.
 *
 * ⚠️ **Isolation : identifiants uniques par test**, jamais de purge par motif — le Redis est
 * partagé par les suites e2e exécutées en parallèle (règle établie en 2.4).
 */
describe('payment/intent (e2e — Redis réel + PMS mocké)', () => {
  let app: NestExpressApplication;
  let redis: RedisService;
  let options: AuthOptions;

  let hotelId: string;
  let roomId: string;
  let reservationId: string;
  let userId: string;
  let cookie: string;
  let openedSids: string[] = [];

  const intentPath = () => `${PMS_PREFIX}/payments/room-reservation/intent`;
  const reservationPath = () =>
    `${PMS_PREFIX}/roomreservations/${reservationId}`;

  /** Réservation `Pending` de 2 nuits × 84 € = 168,00 € (16 800 unités mineures). */
  const reservationBody = (overrides: Record<string, unknown> = {}) => ({
    success: true,
    data: {
      id: reservationId,
      reservationCode: 'RES-20260901-A1B2C',
      hotelId,
      hotelName: 'Hôtel Colline',
      roomId,
      roomNumber: '204',
      roomCategory: 'Double Confort',
      customerId: userId,
      checkInDate: `${CHECK_IN}T00:00:00Z`,
      checkOutDate: `${CHECK_OUT}T00:00:00Z`,
      numberOfGuests: 2,
      numberOfNights: 2,
      pricePerNight: 84,
      totalPrice: 168,
      status: 1,
      ...overrides,
    },
  });

  const pmsIntentBody = (overrides: Record<string, unknown> = {}) => ({
    success: true,
    data: {
      paymentId: randomUUID(),
      clientSecret: 'fake-intent-client-secret',
      paymentIntentId: 'fake-intent-id',
      amountInCents: 16_800,
      currency: 'eur',
      publishableKey: 'fake-publishable-key',
      captureMethod: 'manual',
      ...overrides,
    },
  });

  /** Lectures dont `BookingService.getReservation` a besoin (réservation + devise de l'hôtel). */
  function mockReservationRead(overrides: Record<string, unknown> = {}) {
    nock(PMS_HOST)
      .get(reservationPath())
      .times(2)
      .reply(200, reservationBody(overrides))
      .get(`${PMS_PREFIX}/Hotels/${hotelId}`)
      .times(3)
      .reply(200, { success: true, data: { id: hotelId, currency: 'EUR' } });
  }

  /** Hold réel en Redis — l'objet même que `markPaymentStarted` doit modifier. */
  async function seedHold(): Promise<void> {
    const record: CheckoutHoldRecord = {
      reservationId,
      sid: openedSids[0],
      userId,
      hotelId,
      roomId,
      expiresAt: Date.now() + 900_000,
      stayKey: `booking:idem:v1:${randomUUID()}`,
      paymentStarted: false,
      attempts: 0,
    };
    await redis.set(
      HOLD_KEY_PREFIX + reservationId,
      JSON.stringify(record),
      3600,
    );
    await redis.raw.zadd(HOLD_INDEX_KEY, record.expiresAt, reservationId);
  }

  async function readHold(): Promise<CheckoutHoldRecord | null> {
    const raw = await redis.get(HOLD_KEY_PREFIX + reservationId);
    return raw ? (JSON.parse(raw) as CheckoutHoldRecord) : null;
  }

  async function openSession(accountId: string): Promise<string> {
    const newSid = `e2e-payment-${randomUUID()}`;
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

  const postIntent = (id: string = reservationId) =>
    request(app.getHttpServer())
      .post(`/api/v1/payment/reservations/${id}/intent`)
      .set('Cookie', cookie);

  describe('cas nominal', () => {
    it('200 : renvoie de quoi monter le Payment Element, et rien de plus', async () => {
      mockReservationRead();
      await seedHold();
      const scope = nock(PMS_HOST)
        .post(intentPath(), { roomReservationId: reservationId })
        .reply(200, pmsIntentBody());

      const response = await postIntent().expect(200);
      const body = response.body as IntentEnvelope;

      expect(body.success).toBe(true);
      expect(body.data).toEqual({
        clientSecret: 'fake-intent-client-secret',
        publishableKey: 'fake-publishable-key',
        paymentIntentId: 'fake-intent-id',
        amount: 16_800,
        currency: 'EUR',
        captureMethod: 'manual',
      });
      // Le paymentId du PMS reste côté serveur (il servira à la réconciliation, story 3.4).
      expect(body.data).not.toHaveProperty('paymentId');
      expect(scope.isDone()).toBe(true);
    });

    it('ne met jamais en cache une réponse porteuse d’un clientSecret', async () => {
      mockReservationRead();
      await seedHold();
      nock(PMS_HOST).post(intentPath()).reply(200, pmsIntentBody());

      const response = await postIntent().expect(200);

      // Sans ces directives, un proxy d'entreprise pourrait resservir le secret d'un autre visiteur.
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(response.headers.vary).toContain('Cookie');
    });
  });

  describe('FR-14 — gel du hold', () => {
    it('écrit paymentStarted dans Redis avant de répondre', async () => {
      mockReservationRead();
      await seedHold();
      nock(PMS_HOST).post(intentPath()).reply(200, pmsIntentBody());

      expect((await readHold())?.paymentStarted).toBe(false);

      await postIntent().expect(200);

      // C'est l'enregistrement que le balayeur relit : à partir d'ici il n'annulera plus.
      expect((await readHold())?.paymentStarted).toBe(true);
    });

    it('gèle le hold même si le PMS refuse ensuite', async () => {
      mockReservationRead();
      await seedHold();
      nock(PMS_HOST)
        .post(intentPath())
        .reply(400, {
          success: false,
          errors: ['A payment has already been settled for this reservation'],
        });

      await postIntent().expect(409);

      // Le refus « déjà réglé » signifie qu'un paiement EXISTE : libérer le hold ici annulerait
      // une réservation payée.
      expect((await readHold())?.paymentStarted).toBe(true);
    });
  });

  describe('gardes', () => {
    it('401 sans cookie de session', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/payment/reservations/${reservationId}/intent`)
        .expect(401);
    });

    it('400 sur un identifiant de réservation qui n’est pas un GUID', async () => {
      await postIntent('pas-un-guid').expect(400);
    });

    it('409 et motif machine quand le paiement est déjà autorisé', async () => {
      mockReservationRead();
      await seedHold();
      nock(PMS_HOST)
        .post(intentPath())
        .reply(400, {
          success: false,
          message: 'Bad request',
          errors: ['A payment has already been settled for this reservation'],
        });

      const response = await postIntent().expect(409);
      const body = response.body as ErrorEnvelope;

      expect(body.errors?.reason).toEqual(['already-authorized']);
      // Le texte du PMS ne sort jamais du BFF.
      expect(JSON.stringify(body)).not.toContain('already been settled');
    });

    it('409 quand la réservation n’est plus Pending', async () => {
      // Statut 2 = Confirmed : payer à nouveau serait un double débit.
      mockReservationRead({ status: 2 });
      await seedHold();
      const scope = nock(PMS_HOST)
        .post(intentPath())
        .reply(200, pmsIntentBody());

      const response = await postIntent().expect(409);
      const body = response.body as ErrorEnvelope;

      expect(body.errors?.reason).toEqual(['reservation-not-pending']);
      // Aucun intent n'a été demandé au PMS.
      expect(scope.isDone()).toBe(false);
      expect((await readHold())?.paymentStarted).toBe(false);
    });

    it('409 quand le montant du PMS diverge du total de la réservation', async () => {
      mockReservationRead();
      await seedHold();
      nock(PMS_HOST)
        .post(intentPath())
        .reply(200, pmsIntentBody({ amountInCents: 9_900 }));

      const response = await postIntent().expect(409);
      const body = response.body as ErrorEnvelope;

      expect(body.errors?.reason).toEqual(['amount-mismatch']);
    });

    it('503 quand le PMS est en panne — jamais « paiement refusé »', async () => {
      mockReservationRead();
      await seedHold();
      nock(PMS_HOST).post(intentPath()).times(3).reply(500, { success: false });

      const response = await postIntent().expect(503);
      const body = response.body as ErrorEnvelope;

      expect(body.errors?.reason).toBeUndefined();
    });
  });
});
