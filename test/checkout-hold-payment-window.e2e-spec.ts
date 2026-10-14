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
  BOOKING_OPTIONS,
  type BookingOptions,
} from '../src/modules/booking/booking.constants';
import {
  type CheckoutHoldRecord,
  CheckoutHoldService,
  HOLD_INDEX_KEY,
  HOLD_KEY_PREFIX,
} from '../src/modules/booking/checkout-hold.service';
import { CheckoutHoldSweeper } from '../src/modules/booking/checkout-hold.sweeper';
import { CONFIRM_LOCK_KEY_PREFIX } from '../src/modules/payment/confirmation-lock.service';
import { PaymentReconcileStore } from '../src/modules/payment/reconcile.store';
import { RedisService } from '../src/redis/redis.service';

const PMS_HOST = 'http://pms.payment-window.local';
const PMS_PREFIX = '/api/v1';
const SERVICE_KEY = 'e2e-service-key-payment-window';

function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const CHECK_IN = isoDatePlus(60);
const CHECK_OUT = isoDatePlus(62);

/** Appel PMS observé : méthode, chemin, clé de service et authentification voyageur. */
interface SeenCall {
  method: string;
  path: string;
  serviceKey: string | undefined;
  authorization: string | undefined;
}

/**
 * #4 (story 3.3) — cohérence réservation ↔ paiement, contre un **Redis réel** (scripts Lua réels)
 * et un **PMS mocké** (nock). Ce qui n'est prouvable qu'ici :
 * - l'émission de l'intent date la fenêtre de paiement dans l'enregistrement de hold (Lua réel) ;
 * - le hold `paymentStarted` reste dans l'index du balayeur jusqu'à son issue (AC-2) ;
 * - formulaire abandonné au-delà de la fenêtre : annulation sous le JWT du voyageur, paiement lu
 *   sous `X-Service-Key` seule, hold libéré (AC-2) ;
 * - argent engagé ou doute : jamais d'annulation (AC-3), attente sans tentative ;
 * - le gel d'un intent émis survit à un refus ultérieur (constat de la livraison de #3) ;
 * - confirmation sur une chambre prise : 409 `room-unavailable` et statut de débit (AC-7, AC-8).
 *
 * ⚠️ Isolation : Redis est partagé par les suites e2e exécutées en parallèle. Identifiants uniques,
 * jamais de purge par motif ; lot réduit à 1 et échéance du hold ramenée sous zéro : chaque passe
 * traite le hold du test, le plus ancien de l'index.
 */
describe('booking/payment window (e2e — Redis réel + PMS mocké)', () => {
  let app: NestExpressApplication;
  let redis: RedisService;
  let sweeper: CheckoutHoldSweeper;
  let holds: CheckoutHoldService;
  let reconcileStore: PaymentReconcileStore;
  let options: AuthOptions;
  let booking: BookingOptions;

  let hotelId: string;
  let roomId: string;
  let reservationId: string;
  let userId: string;
  let sid: string;
  let cookie: string;
  let pmsStatus: number;
  let intentStatus: string | null;
  let paymentStatus: number;
  let stripeReadable: boolean;
  let seen: SeenCall[];

  const paymentPath = () =>
    `${PMS_PREFIX}/reservations/${reservationId}/payment`;
  const cancelPath = () =>
    `${PMS_PREFIX}/roomreservations/${reservationId}/cancel`;
  const confirmPath = () =>
    `${PMS_PREFIX}/reservations/${reservationId}/confirm`;

  function record(
    method: string,
    path: string,
    headers: Record<string, string | string[] | undefined>,
  ): void {
    const pick = (name: string) => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    seen.push({
      method,
      path,
      serviceKey: pick('x-service-key'),
      authorization: pick('authorization'),
    });
  }

  /** Réservation (JWT voyageur), hôtel, intent et paiement (route de service), pilotés par le test. */
  function mockPms(): void {
    nock(PMS_HOST)
      .persist()
      .get(`${PMS_PREFIX}/roomreservations/${reservationId}`)
      .reply(function () {
        record('GET', `/roomreservations/${reservationId}`, this.req.headers);
        return [
          200,
          {
            success: true,
            data: {
              id: reservationId,
              reservationCode: 'RES-20261014-W1ND0',
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
              grandTotal: 168,
              status: pmsStatus,
            },
          },
        ];
      })
      .get(`${PMS_PREFIX}/Hotels/${hotelId}`)
      .reply(200, { success: true, data: { id: hotelId, currency: 'EUR' } })
      .post(`${PMS_PREFIX}/payments/room-reservation/intent`)
      .reply(function () {
        record('POST', '/payments/room-reservation/intent', this.req.headers);
        return [
          200,
          {
            success: true,
            data: {
              paymentId: randomUUID(),
              clientSecret: 'fake-intent-client-secret',
              paymentIntentId: 'fake-intent-id',
              amountInCents: 16_800,
              currency: 'eur',
              publishableKey: 'fake-publishable-key',
              captureMethod: 'manual',
            },
          },
        ];
      })
      .get(paymentPath())
      .reply(function () {
        record('GET', paymentPath(), this.req.headers);
        return [
          200,
          {
            success: true,
            data: {
              reservationId,
              payment:
                intentStatus === null
                  ? null
                  : {
                      paymentId: '9c8b7a6d-5e4f-4321-8abc-def012345678',
                      status: paymentStatus,
                      amount: 168,
                      currency: 'EUR',
                      intentStatus: stripeReadable ? intentStatus : null,
                      amountCapturable: 0,
                      amountReceived: 0,
                      stripeReadable,
                      createdAt: new Date().toISOString(),
                      paidAt: null,
                    },
            },
          },
        ];
      });
  }

  /** Annulation PMS (JWT du voyageur) : la réservation passe `Cancelled` (status 5). */
  function mockCancel(): nock.Scope {
    return nock(PMS_HOST)
      .post(cancelPath())
      .reply(function () {
        record('POST', cancelPath(), this.req.headers);
        pmsStatus = 5;
        return [200, { success: true, message: 'Reservation cancelled' }];
      });
  }

  async function seedHold(): Promise<void> {
    const hold: CheckoutHoldRecord = {
      reservationId,
      sid,
      userId,
      hotelId,
      roomId,
      expiresAt: Date.now() + 900_000,
      stayKey: `booking:idem:v1:${randomUUID()}`,
      paymentStarted: false,
      intentIssued: false,
      attempts: 0,
    };
    await redis.set(
      HOLD_KEY_PREFIX + reservationId,
      JSON.stringify(hold),
      3600,
    );
    await redis.raw.zadd(HOLD_INDEX_KEY, hold.expiresAt, reservationId);
  }

  async function readHold(): Promise<CheckoutHoldRecord | null> {
    const raw = await redis.get(HOLD_KEY_PREFIX + reservationId);
    return raw ? (JSON.parse(raw) as CheckoutHoldRecord) : null;
  }

  /** Réécrit l'enregistrement (fenêtre vieillie) sans toucher à l'index. */
  async function patchHold(patch: Partial<CheckoutHoldRecord>): Promise<void> {
    const current = await readHold();
    await redis.set(
      HOLD_KEY_PREFIX + reservationId,
      JSON.stringify({ ...current, ...patch }),
      3600,
    );
  }

  async function makeDue(): Promise<void> {
    // Score négatif et décroissant : toujours le plus ancien, même face à un reliquat d'un run.
    await redis.raw.zadd(HOLD_INDEX_KEY, -Date.now(), reservationId);
  }

  async function indexScore(): Promise<number | null> {
    const score = await redis.raw.zscore(HOLD_INDEX_KEY, reservationId);
    return score === null ? null : Number(score);
  }

  async function emitIntent(): Promise<void> {
    await request(app.getHttpServer())
      .post(`/api/v1/payment/reservations/${reservationId}/intent`)
      .set('Cookie', cookie)
      .expect(200);
  }

  const calls = (method: string, path: string) =>
    seen.filter((c) => c.method === method && c.path === path);

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    process.env.PMS_BASE_URL = `${PMS_HOST}${PMS_PREFIX}`;
    process.env.SERVICE_KEY = SERVICE_KEY;
    process.env.PMS_RETRY_BASE_DELAY_MS = '5';
    process.env.BOOKING_SWEEPER_BATCH = '1';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.use(correlationMiddleware);
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
    await app.init();

    redis = app.get(RedisService);
    sweeper = app.get(CheckoutHoldSweeper);
    holds = app.get(CheckoutHoldService);
    reconcileStore = app.get(PaymentReconcileStore);
    options = app.get<AuthOptions>(AUTH_OPTIONS);
    booking = app.get<BookingOptions>(BOOKING_OPTIONS);

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  beforeEach(async () => {
    hotelId = randomUUID();
    roomId = randomUUID();
    reservationId = randomUUID();
    userId = randomUUID();
    pmsStatus = 1;
    intentStatus = 'requires_payment_method';
    paymentStatus = 1;
    stripeReadable = true;
    seen = [];
    sid = `e2e-window-${randomUUID()}`;
    await redis.set(
      SESSION_KEY_PREFIX + sid,
      JSON.stringify({
        userId,
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
    cookie = buildSessionCookie(sid, 3600, {
      cookieName: options.cookieName,
      sessionSecret: options.sessionSecret,
      cookieSecure: options.cookieSecure,
    }).split(';')[0];
    mockPms();
    await seedHold();
  });

  afterEach(async () => {
    nock.cleanAll();
    await redis.del(SESSION_KEY_PREFIX + sid);
    await redis.del(HOLD_KEY_PREFIX + reservationId);
    await redis.raw.zrem(HOLD_INDEX_KEY, reservationId);
    await redis.del(CONFIRM_LOCK_KEY_PREFIX + reservationId);
    await reconcileStore.remove(reservationId);
  });

  afterAll(async () => {
    nock.enableNetConnect();
    await app.close();
  });

  describe('formulaire de paiement abandonné (AC-2)', () => {
    it('l’émission de l’intent date la fenêtre ; le hold reste suivi jusqu’à son échéance', async () => {
      const before = Date.now();
      await emitIntent();

      const hold = await readHold();
      expect(hold?.paymentStarted).toBe(true);
      expect(hold?.intentIssued).toBe(true);
      expect(hold?.intentIssuedAt).toBeGreaterThanOrEqual(before);
      expect(hold?.intentIssuedAt).toBeLessThanOrEqual(Date.now());

      // Hold échu (15 min) mais fenêtre de paiement en cours : aucune annulation, et le hold reste
      // dans l'index, repoussé à la fin de la fenêtre (fin du `forget` immédiat).
      const cancel = mockCancel();
      await makeDue();
      await sweeper.sweep();

      expect(cancel.isDone()).toBe(false);
      expect(await indexScore()).toBe(
        (hold?.intentIssuedAt ?? 0) + booking.paymentWindowSeconds * 1000,
      );
      expect((await readHold())?.attempts).toBe(0);
    });

    it('fenêtre écoulée : paiement lu sous X-Service-Key, annulation sous JWT, hold libéré', async () => {
      await emitIntent();
      await patchHold({
        intentIssuedAt: Date.now() - booking.paymentWindowSeconds * 1000 - 1,
      });
      const cancel = mockCancel();
      await makeDue();

      await sweeper.sweep();

      expect(cancel.isDone()).toBe(true);
      const [read] = calls('GET', paymentPath());
      expect(read.serviceKey).toBe(SERVICE_KEY);
      expect(read.authorization).toBeUndefined();
      const [cancelCall] = calls('POST', cancelPath());
      expect(cancelCall.authorization).toBe('Bearer access-1');
      expect(cancelCall.serviceKey).toBeUndefined();
      // Hold libéré : enregistrement et index retirés.
      expect(await readHold()).toBeNull();
      expect(await indexScore()).toBeNull();
    });
  });

  describe('jamais d’annulation d’un paiement engagé (AC-3)', () => {
    it('requires_capture : aucune annulation, le hold sort de l’index (confirmation, réconciliation)', async () => {
      intentStatus = 'requires_capture';
      await emitIntent();
      await patchHold({ intentIssuedAt: Date.now() - 10 * 3_600_000 });
      const cancel = mockCancel();
      await makeDue();

      await sweeper.sweep();

      expect(cancel.isDone()).toBe(false);
      expect(await indexScore()).toBeNull();
      expect(await readHold()).not.toBeNull();
    });

    it('Stripe illisible : doute, report sans tentative (Lua réel)', async () => {
      stripeReadable = false;
      await emitIntent();
      await patchHold({ intentIssuedAt: Date.now() - 10 * 3_600_000 });
      const cancel = mockCancel();
      await makeDue();

      await sweeper.sweep();

      expect(cancel.isDone()).toBe(false);
      expect(await indexScore()).toBeGreaterThan(Date.now());
      expect((await readHold())?.attempts).toBe(0);
    });
  });

  describe('gel d’un intent émis (constat de la livraison de #3)', () => {
    it('clearPaymentStarted ne relâche pas le gel d’un intent émis (Lua réel)', async () => {
      await emitIntent();

      await expect(holds.clearPaymentStarted(reservationId)).resolves.toBe(
        'kept',
      );

      expect((await readHold())?.paymentStarted).toBe(true);
    });
  });

  describe('chambre devenue indisponible avant la capture (AC-7, AC-8)', () => {
    function mockConfirmConflict(): nock.Scope {
      return nock(PMS_HOST)
        .post(confirmPath())
        .reply(function () {
          record('POST', confirmPath(), this.req.headers);
          pmsStatus = 5;
          return [
            409,
            {
              success: false,
              errors: ['Room is no longer available for this reservation'],
            },
          ];
        });
    }

    it.each([
      ['autorisation annulée', 5, 'canceled', 'none'],
      ['argent remboursé (AC-5)', 6, 'succeeded', 'refunded'],
    ])(
      '%s : 409 room-unavailable, statut de débit « %s », hold libéré',
      async (_label, status, intent, debit) => {
        await emitIntent();
        const conflict = mockConfirmConflict();
        paymentStatus = status;
        intentStatus = intent;

        const res = await request(app.getHttpServer())
          .post(`/api/v1/payment/reservations/${reservationId}/confirm`)
          .set('Cookie', cookie)
          .expect(409);

        expect(conflict.isDone()).toBe(true);
        const body = res.body as { errors: Record<string, string[]> };
        expect(body.errors.reason).toEqual(['room-unavailable']);
        expect(body.errors.debit).toEqual([debit]);
        // Aucun texte du PMS ne traverse la frontière.
        expect(JSON.stringify(res.body)).not.toMatch(/no longer available/);
        expect(await readHold()).toBeNull();
      },
    );
  });
});
