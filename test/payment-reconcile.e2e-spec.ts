import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
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
import { CONFIRM_LOCK_KEY_PREFIX } from '../src/modules/payment/confirmation-lock.service';
import { PaymentReconciler } from '../src/modules/payment/payment-reconciler';
import {
  PaymentReconcileStore,
  RECONCILE_DUE_KEY,
  RECONCILE_IDLE_DUE_KEY,
  RECONCILE_INDEX_KEY,
  RECONCILE_KEY_PREFIX,
  RECONCILE_LOCK_KEY,
  type ReconcileRecord,
} from '../src/modules/payment/reconcile.store';
import { RedisService } from '../src/redis/redis.service';

const PMS_HOST = 'http://pms.reconcile.local';
const PMS_PREFIX = '/api/v1';
const SERVICE_KEY = 'e2e-service-key-reconcile';

function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const CHECK_IN = isoDatePlus(50);
const CHECK_OUT = isoDatePlus(52);

/** Appel PMS observé : méthode, chemin, clé de service et authentification voyageur. */
interface SeenCall {
  method: string;
  path: string;
  serviceKey: string | undefined;
  authorization: string | undefined;
  cookie: string | undefined;
  correlationId: string | undefined;
}

/**
 * Réconciliation paiement → confirmation (#5, story 3.4) contre un **Redis réel** et un **PMS
 * mocké** (nock). Ce qui n'est prouvable qu'ici :
 * - les scripts Lua réels de l'index (inscription idempotente, mise à jour sans résurrection) ;
 * - le parcours HTTP complet : intent émis par `/api/v1` → candidat inscrit → passe du job →
 *   confirmation rejouée sous `X-Service-Key`, sans cookie ni JWT ;
 * - la frontière `X-Service-Key` (AC-7) : présente sur les trois routes de service, **absente** de
 *   tous les autres appels PMS du parcours ;
 * - l'exclusivité réelle avec le verrou single-flight du navigateur (#3) et le verrou de passe.
 *
 * ⚠️ Isolation : Redis est partagé par les suites e2e exécutées en parallèle. Identifiants uniques,
 * jamais de purge par motif ; lot réduit à 1 et échéance du candidat ramenée sous zéro : chaque
 * passe traite le candidat du test, le plus ancien de l'échéancier.
 */
describe('payment/reconcile (e2e — Redis réel + PMS mocké)', () => {
  let app: NestExpressApplication;
  let redis: RedisService;
  let reconciler: PaymentReconciler;
  let store: PaymentReconcileStore;
  let options: AuthOptions;

  let hotelId: string;
  let roomId: string;
  let reservationId: string;
  let userId: string;
  let sid: string;
  let cookie: string;
  let pmsStatus: number;
  let intentStatus: string | null;
  let seen: SeenCall[];
  let errorSpy: jest.SpyInstance;

  const statePath = () => `${PMS_PREFIX}/reservations/${reservationId}`;
  const paymentPath = () => `${statePath()}/payment`;
  const confirmPath = () => `${statePath()}/confirm`;

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
      cookie: pick('cookie'),
      correlationId: pick('x-correlation-id'),
    });
  }

  /** Routes de service de #153 : état de la réservation et de son paiement, pilotés par le test. */
  function mockServiceReads(): void {
    nock(PMS_HOST)
      .persist()
      .get(statePath())
      .reply(function () {
        record('GET', statePath(), this.req.headers);
        return [
          200,
          {
            success: true,
            data: {
              id: reservationId,
              reservationCode: 'RES-20261014-R3C0N',
              status: pmsStatus,
              hotelId,
              checkInDate: `${CHECK_IN}T00:00:00Z`,
              checkOutDate: `${CHECK_OUT}T00:00:00Z`,
              grandTotal: 168,
              currency: 'EUR',
              createdAt: new Date().toISOString(),
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
                      status: 1,
                      amount: 168,
                      currency: 'EUR',
                      intentStatus,
                      amountCapturable:
                        intentStatus === 'requires_capture' ? 16_800 : 0,
                      amountReceived: intentStatus === 'succeeded' ? 16_800 : 0,
                      stripeReadable: true,
                      createdAt: new Date().toISOString(),
                      paidAt: null,
                    },
            },
          },
        ];
      });
  }

  /** Confirmation PMS : passe la réservation `Confirmed` (status 2) à un 200. */
  function mockConfirm(
    reply: () => [number, unknown] = () => [
      200,
      {
        success: true,
        data: {
          reservationId,
          grandTotal: 168,
          droppedServices: [],
          reservationCode: 'RES-20261014-R3C0N',
          currency: 'EUR',
          capturedAmount: 168,
          alreadyConfirmed: false,
        },
      },
    ],
  ): nock.Scope {
    return nock(PMS_HOST)
      .post(confirmPath())
      .reply(function () {
        record('POST', confirmPath(), this.req.headers);
        const [status, body] = reply();
        if (status === 200) {
          pmsStatus = 2;
        }
        return [status, body];
      });
  }

  /** Lectures et écriture du tunnel voyageur (intent) : elles ne portent JAMAIS la clé de service. */
  function mockTunnel(): void {
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
              reservationCode: 'RES-20261014-R3C0N',
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
      .reply(function () {
        record('GET', `/Hotels/${hotelId}`, this.req.headers);
        return [200, { success: true, data: { id: hotelId, currency: 'EUR' } }];
      })
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
      attempts: 0,
    };
    await redis.set(
      HOLD_KEY_PREFIX + reservationId,
      JSON.stringify(hold),
      3600,
    );
    await redis.raw.zadd(HOLD_INDEX_KEY, hold.expiresAt, reservationId);
  }

  /** Candidat inscrit directement (âge choisi), puis rendu échu en tête de l'échéancier. */
  async function seedCandidate(
    ageMs = 120_000,
    overrides: Partial<ReconcileRecord> = {},
  ): Promise<void> {
    await store.enroll(reservationId, Date.now() - ageMs);
    if (Object.keys(overrides).length > 0) {
      const current = await readRecord();
      await redis.set(
        RECONCILE_KEY_PREFIX + reservationId,
        JSON.stringify({ ...current, ...overrides }),
        3600,
      );
    }
    await makeDue();
  }

  async function makeDue(): Promise<void> {
    // Score négatif et décroissant : toujours le plus ancien, même face à un reliquat d'un run interrompu.
    await redis.raw.zadd(RECONCILE_DUE_KEY, -Date.now(), reservationId);
  }

  async function readRecord(): Promise<ReconcileRecord | null> {
    const raw = await redis.get(RECONCILE_KEY_PREFIX + reservationId);
    return raw ? (JSON.parse(raw) as ReconcileRecord) : null;
  }

  async function isCandidate(): Promise<boolean> {
    return (
      (await redis.raw.zscore(RECONCILE_INDEX_KEY, reservationId)) !== null
    );
  }

  const alerts = (): Record<string, unknown>[] =>
    errorSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .filter(
        (arg): arg is Record<string, unknown> =>
          typeof arg === 'object' &&
          arg !== null &&
          (arg as Record<string, unknown>).event === 'integrity.alert' &&
          (arg as Record<string, unknown>).reservationId === reservationId,
      );

  const confirmCalls = () =>
    seen.filter((c) => c.method === 'POST' && c.path === confirmPath());

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    process.env.PMS_BASE_URL = `${PMS_HOST}${PMS_PREFIX}`;
    process.env.SERVICE_KEY = SERVICE_KEY;
    process.env.PMS_RETRY_BASE_DELAY_MS = '5';
    // Un seul candidat par passe : celui du test, ramené en tête de l'échéancier.
    process.env.PAYMENT_RECONCILE_BATCH = '1';
    process.env.PAYMENT_RECONCILE_INTERVAL_MS = '10000';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.use(correlationMiddleware);
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
    await app.init();

    redis = app.get(RedisService);
    reconciler = app.get(PaymentReconciler);
    store = app.get(PaymentReconcileStore);
    options = app.get<AuthOptions>(AUTH_OPTIONS);

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  beforeEach(async () => {
    hotelId = randomUUID();
    roomId = randomUUID();
    reservationId = randomUUID();
    userId = randomUUID();
    pmsStatus = 1;
    intentStatus = 'requires_capture';
    seen = [];
    errorSpy = jest.spyOn(Logger.prototype, 'error');
    sid = `e2e-reconcile-${randomUUID()}`;
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
  });

  afterEach(async () => {
    errorSpy.mockRestore();
    nock.cleanAll();
    await redis.del(SESSION_KEY_PREFIX + sid);
    await redis.del(HOLD_KEY_PREFIX + reservationId);
    await redis.raw.zrem(HOLD_INDEX_KEY, reservationId);
    await redis.del(CONFIRM_LOCK_KEY_PREFIX + reservationId);
    await store.remove(reservationId);
  });

  afterAll(async () => {
    nock.enableNetConnect();
    await app.close();
  });

  describe('parcours complet (AC-1, AC-2, AC-7)', () => {
    it('intent émis, confirmation du navigateur perdue : la passe confirme sous X-Service-Key seule', async () => {
      mockTunnel();
      mockServiceReads();
      const confirm = mockConfirm();
      await seedHold();

      // AC-1 : l'émission de l'intent inscrit la réservation, hors session et hors hold.
      await request(app.getHttpServer())
        .post(`/api/v1/payment/reservations/${reservationId}/intent`)
        .set('Cookie', cookie)
        .expect(200);
      expect(await isCandidate()).toBe(true);

      // Le navigateur ne confirme jamais (onglet fermé). Session détruite : le filet n'en dépend pas.
      await redis.del(SESSION_KEY_PREFIX + sid);
      await makeDue();
      await reconciler.reconcile();

      // AC-2 : confirmation rejouée, réservation Confirmed, candidat sorti, hold oublié.
      expect(confirm.isDone()).toBe(true);
      expect(pmsStatus).toBe(2);
      expect(await isCandidate()).toBe(false);
      expect(
        await redis.raw.zscore(RECONCILE_DUE_KEY, reservationId),
      ).toBeNull();
      expect(await readRecord()).toBeNull();
      expect(await redis.raw.zscore(HOLD_INDEX_KEY, reservationId)).toBeNull();
      // `forget`, jamais `release` : l'enregistrement de hold (et sa clé d'idempotence) survit.
      expect(await redis.get(HOLD_KEY_PREFIX + reservationId)).not.toBeNull();

      // AC-7 : X-Service-Key sur les trois routes de service, et sur elles seules.
      const service = new Set([
        `GET ${statePath()}`,
        `GET ${paymentPath()}`,
        `POST ${confirmPath()}`,
      ]);
      const serviceCalls = seen.filter((c) =>
        service.has(`${c.method} ${c.path}`),
      );
      const otherCalls = seen.filter(
        (c) => !service.has(`${c.method} ${c.path}`),
      );
      expect(serviceCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
        `GET ${statePath()}`,
        `GET ${paymentPath()}`,
        `POST ${confirmPath()}`,
      ]);
      for (const call of serviceCalls) {
        expect(call.serviceKey).toBe(SERVICE_KEY);
        // Sans cookie ni JWT de voyageur.
        expect(call.authorization).toBeUndefined();
        expect(call.cookie).toBeUndefined();
        expect(call.correlationId).toMatch(/^reconcile-/);
      }
      expect(otherCalls.length).toBeGreaterThan(0);
      for (const call of otherCalls) {
        expect(call.serviceKey).toBeUndefined();
      }
    });

    it('déjà Confirmed par le navigateur : sort de l’index sans confirmer', async () => {
      mockServiceReads();
      const confirm = mockConfirm();
      pmsStatus = 2;
      await seedCandidate();

      await reconciler.reconcile();

      expect(confirm.isDone()).toBe(false);
      expect(await isCandidate()).toBe(false);
    });
  });

  describe('aucune action sans argent engagé (AC-3)', () => {
    it.each([['requires_payment_method'], ['canceled'], [null]])(
      'Pending + %p : aucune confirmation, le candidat reste',
      async (status) => {
        intentStatus = status;
        mockServiceReads();
        const confirm = mockConfirm();
        await seedCandidate();

        await reconciler.reconcile();

        expect(confirm.isDone()).toBe(false);
        expect(await isCandidate()).toBe(true);
        // #185 : rangé parmi les paiements abandonnés, une seule échéance, dans le futur.
        expect(
          await redis.raw.zscore(RECONCILE_DUE_KEY, reservationId),
        ).toBeNull();
        const due = Number(
          await redis.raw.zscore(RECONCILE_IDLE_DUE_KEY, reservationId),
        );
        expect(due).toBeGreaterThan(Date.now());
        expect(await readRecord()).toMatchObject({
          idleRounds: 1,
          failures: 0,
        });
      },
    );

    it('Cancelled sans argent engagé : sort de l’index', async () => {
      intentStatus = 'canceled';
      pmsStatus = 5;
      mockServiceReads();
      await seedCandidate();

      await reconciler.reconcile();

      expect(confirmCalls()).toHaveLength(0);
      expect(await isCandidate()).toBe(false);
    });
  });

  describe('exclusivité (AC-4)', () => {
    it('confirmation du navigateur en vol (même verrou single-flight) : aucun POST concurrent', async () => {
      mockServiceReads();
      const confirm = mockConfirm();
      await seedCandidate();
      await redis.raw.set(
        CONFIRM_LOCK_KEY_PREFIX + reservationId,
        'navigateur',
        'PX',
        60_000,
      );

      await reconciler.reconcile();

      expect(confirm.isDone()).toBe(false);
      expect(await isCandidate()).toBe(true);
      // Le verrou du navigateur n'est jamais volé ni rendu par la réconciliation.
      expect(await redis.get(CONFIRM_LOCK_KEY_PREFIX + reservationId)).toBe(
        'navigateur',
      );
    });

    it('verrou de passe tenu par une autre instance : rien n’est traité', async () => {
      mockServiceReads();
      await seedCandidate();
      const acquired = await redis.raw.set(
        RECONCILE_LOCK_KEY,
        'autre-instance',
        'PX',
        5_000,
        'NX',
      );
      try {
        await reconciler.reconcile();
        if (acquired === 'OK') {
          expect(seen).toHaveLength(0);
        }
      } finally {
        if (acquired === 'OK') {
          await redis.raw.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            RECONCILE_LOCK_KEY,
            'autre-instance',
          );
        }
      }
    });

    it('rend le verrou de confirmation après la passe', async () => {
      mockServiceReads();
      mockConfirm();
      await seedCandidate();
      await reconciler.reconcile();
      expect(
        await redis.get(CONFIRM_LOCK_KEY_PREFIX + reservationId),
      ).toBeNull();
    });
  });

  describe('rejeu jusqu’à cohérence (AC-5) et alerte (AC-6)', () => {
    it('panne transitoire du PMS : candidat conservé, nouvel essai différé', async () => {
      mockServiceReads();
      nock(PMS_HOST)
        .post(confirmPath())
        .times(3)
        .reply(function () {
          record('POST', confirmPath(), this.req.headers);
          return [503, { success: false }];
        });
      await seedCandidate();

      await reconciler.reconcile();

      expect(await isCandidate()).toBe(true);
      const rec = await readRecord();
      expect(rec).toMatchObject({ failures: 1, attempts: 1, refusal: null });
      expect(
        Number(await redis.raw.zscore(RECONCILE_DUE_KEY, reservationId)),
      ).toBeGreaterThan(Date.now());
    });

    it('refus déterministe : alerte immédiate, puis plus jamais rejoué', async () => {
      mockServiceReads();
      nock(PMS_HOST)
        .post(confirmPath())
        .reply(function () {
          record('POST', confirmPath(), this.req.headers);
          return [
            409,
            {
              success: false,
              message:
                'The authorised amount does not match the amount due for this reservation.',
            },
          ];
        });
      await seedCandidate();

      await reconciler.reconcile();

      expect(confirmCalls()).toHaveLength(1);
      expect((await readRecord())?.refusal).toBe('amount-mismatch');
      expect(alerts()).toEqual([
        expect.objectContaining({
          event: 'integrity.alert',
          kind: 'deterministic-refusal',
          reservationId,
          intentStatus: 'requires_capture',
          attempts: 1,
        }),
      ]);

      await makeDue();
      await reconciler.reconcile();

      expect(confirmCalls()).toHaveLength(1);
      expect(await isCandidate()).toBe(true);
      expect(alerts()).toHaveLength(1);
    });

    it('argent engagé non confirmé au-delà du seuil : payment-not-confirmed, sans PII ni secret', async () => {
      mockServiceReads();
      nock(PMS_HOST).post(confirmPath()).times(3).replyWithError('ECONNRESET');
      await seedCandidate(901_000);

      await reconciler.reconcile();

      const [alert] = alerts();
      expect(alert).toMatchObject({
        kind: 'payment-not-confirmed',
        reservationId,
        paymentId: '9c8b7a6d-5e4f-4321-8abc-def012345678',
        intentStatus: 'requires_capture',
        attempts: 1,
      });
      expect(alert.ageSeconds).toBeGreaterThanOrEqual(901);
      expect(alert.correlationId).toMatch(/^reconcile-/);
      expect(JSON.stringify(alert)).not.toMatch(
        new RegExp(`${SERVICE_KEY}|lea@example|Voyageuse|${sid}`),
      );
      expect((await readRecord())?.lastAlertAt).toEqual(expect.any(Number));
    });

    it('Cancelled dont l’intent est succeeded : captured-not-confirmable, candidat conservé', async () => {
      intentStatus = 'succeeded';
      pmsStatus = 5;
      mockServiceReads();
      await seedCandidate();

      await reconciler.reconcile();

      expect(confirmCalls()).toHaveLength(0);
      expect(await isCandidate()).toBe(true);
      expect(alerts()).toEqual([
        expect.objectContaining({ kind: 'captured-not-confirmable' }),
      ]);
    });
  });

  describe('paiements abandonnés (#185)', () => {
    it('AC-1 : relectures successives sans argent engagé, échéance de plus en plus espacée', async () => {
      intentStatus = null;
      mockServiceReads();
      const confirm = mockConfirm();
      await seedCandidate();

      const delays: number[] = [];
      for (let pass = 0; pass < 3; pass++) {
        const before = Date.now();
        await reconciler.reconcile();
        const due = Number(
          await redis.raw.zscore(RECONCILE_IDLE_DUE_KEY, reservationId),
        );
        delays.push(due - before);
        // Remis en tête de l'échéancier prioritaire pour la passe suivante (lot de 1).
        await makeDue();
      }

      expect(confirm.isDone()).toBe(false);
      expect((await readRecord())?.idleRounds).toBe(3);
      // Intervalle de la suite : 10 s → ~10 s, ~20 s, ~40 s (marge pour la durée de la passe).
      expect(delays[0]).toBeGreaterThanOrEqual(10_000);
      expect(delays[0]).toBeLessThan(20_000);
      expect(delays[1]).toBeGreaterThanOrEqual(20_000);
      expect(delays[1]).toBeLessThan(40_000);
      expect(delays[2]).toBeGreaterThanOrEqual(40_000);
    });

    it('AC-2 : abandonné puis autorisé : confirmation rejouée, candidat sorti des deux échéanciers', async () => {
      intentStatus = null;
      mockServiceReads();
      const confirm = mockConfirm();
      await seedCandidate();
      await reconciler.reconcile();
      expect((await readRecord())?.idleRounds).toBe(1);

      intentStatus = 'requires_capture';
      await makeDue();
      await reconciler.reconcile();

      expect(confirm.isDone()).toBe(true);
      expect(await isCandidate()).toBe(false);
      expect(
        await redis.raw.zscore(RECONCILE_DUE_KEY, reservationId),
      ).toBeNull();
      expect(
        await redis.raw.zscore(RECONCILE_IDLE_DUE_KEY, reservationId),
      ).toBeNull();
    });

    it('AC-3 : un abandon échu plus ancien ne prend pas la place d’un paiement engagé (lot de 1)', async () => {
      const abandoned = randomUUID();
      try {
        await store.enroll(abandoned, Date.now() - 300_000);
        const current = JSON.parse(
          (await redis.get(RECONCILE_KEY_PREFIX + abandoned))!,
        ) as ReconcileRecord;
        // Abandon déjà lu, dû depuis bien plus longtemps que le candidat du test.
        await store.update(
          { ...current, idleRounds: 2 },
          -Date.now() - 1_000_000,
        );
        expect(await redis.raw.zscore(RECONCILE_DUE_KEY, abandoned)).toBeNull();

        mockServiceReads();
        const confirm = mockConfirm();
        await seedCandidate();

        await reconciler.reconcile();

        expect(confirm.isDone()).toBe(true);
        expect(seen.some((c) => c.path.includes(abandoned))).toBe(false);
        // L'abandon n'a pas été lu : toujours dû, toujours parmi les abandons.
        expect(
          Number(await redis.raw.zscore(RECONCILE_IDLE_DUE_KEY, abandoned)),
        ).toBeLessThan(0);
      } finally {
        await store.remove(abandoned);
      }
    });

    it('une réémission d’intent replace un abandon dans l’échéancier prioritaire', async () => {
      await store.enroll(reservationId, 1_000_000);
      const current = (await readRecord())!;
      await store.update({ ...current, idleRounds: 4 }, 5_000_000);
      expect(
        await redis.raw.zscore(RECONCILE_DUE_KEY, reservationId),
      ).toBeNull();

      await store.enroll(reservationId, 2_000_000);

      expect(
        await redis.raw.zscore(RECONCILE_IDLE_DUE_KEY, reservationId),
      ).toBeNull();
      expect(
        Number(await redis.raw.zscore(RECONCILE_DUE_KEY, reservationId)),
      ).toBe(2_000_000 + 10_000);
      // Première émission conservée.
      expect(
        Number(await redis.raw.zscore(RECONCILE_INDEX_KEY, reservationId)),
      ).toBe(1_000_000);
    });

    it('le retrait vide aussi l’échéancier des abandons', async () => {
      await store.enroll(reservationId, Date.now());
      const current = (await readRecord())!;
      await store.update({ ...current, idleRounds: 1 }, 5_000_000);
      await store.remove(reservationId);
      expect(
        await redis.raw.zscore(RECONCILE_IDLE_DUE_KEY, reservationId),
      ).toBeNull();
      expect(await isCandidate()).toBe(false);
    });

    it('AC-1 : un abandon échu est servi depuis l’échéancier des abandons, pas avant (Redis réel)', async () => {
      const later = randomUUID();
      try {
        await store.enroll(reservationId, Date.now() - 300_000);
        const current = (await readRecord())!;
        await store.update({ ...current, idleRounds: 2 }, -Date.now());
        await store.enroll(later, Date.now() - 300_000);
        const other = JSON.parse(
          (await redis.get(RECONCILE_KEY_PREFIX + later))!,
        ) as ReconcileRecord;
        await store.update({ ...other, idleRounds: 3 }, Date.now() + 600_000);

        // Lot large : la place restante après les prioritaires revient aux abandons échus.
        const due = await store.due(Date.now(), 500);

        expect(due).toContain(reservationId);
        expect(due).not.toContain(later);
        expect(new Set(due).size).toBe(due.length);
      } finally {
        await store.remove(later);
      }
    });
  });

  describe('scripts Lua réels de l’index (AC-1)', () => {
    it('une réémission garde l’instant de la première émission', async () => {
      await store.enroll(reservationId, 1_000_000);
      await store.enroll(reservationId, 2_000_000);
      expect(
        Number(await redis.raw.zscore(RECONCILE_INDEX_KEY, reservationId)),
      ).toBe(1_000_000);
      expect((await readRecord())?.issuedAt).toBe(1_000_000);
    });

    it('une mise à jour ne ressuscite jamais un candidat retiré entre-temps', async () => {
      await store.enroll(reservationId, Date.now());
      const current = (await readRecord())!;
      await store.remove(reservationId);

      const applied = await store.update({ ...current, failures: 3 }, 42);

      expect(applied).toBe(false);
      expect(await readRecord()).toBeNull();
      expect(await isCandidate()).toBe(false);
      expect(
        await redis.raw.zscore(RECONCILE_DUE_KEY, reservationId),
      ).toBeNull();
    });

    it('l’état vit au-delà de l’âge maximal (TTL)', async () => {
      await store.enroll(reservationId, Date.now());
      const ttl = await redis.raw.ttl(RECONCILE_KEY_PREFIX + reservationId);
      expect(ttl).toBeGreaterThan(691_200);
    });
  });
});
