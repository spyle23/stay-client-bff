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
  COMM_LOCALE_KEY_PREFIX,
  HOLD_INDEX_KEY,
  HOLD_KEY_PREFIX,
} from '../src/modules/booking/checkout-hold.service';
import { CONFIRM_LOCK_KEY_PREFIX } from '../src/modules/payment/confirmation-lock.service';
import { RedisService } from '../src/redis/redis.service';

const PMS_HOST = 'http://pms.confirm.local';
const PMS_PREFIX = '/api/v1';
const SERVICE_KEY = 'e2e-service-key-confirm';

function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const CHECK_IN = isoDatePlus(40);
const CHECK_OUT = isoDatePlus(42);

interface ProofEnvelope {
  success: boolean;
  data: Record<string, unknown> & {
    reservationCode: string;
    status: string;
    total: number;
    capturedAmount: number | null;
    alreadyConfirmed: boolean;
    communicationLocale: string | null;
    communicationLocaleState: string;
  };
}

interface ErrorEnvelope {
  success: boolean;
  message: string;
  errors?: Record<string, string[]>;
}

/** Appel PMS observé : méthode, chemin et présence de la clé de service (AC-12). */
interface SeenCall {
  method: string;
  path: string;
  serviceKey: string | undefined;
  authorization: string | undefined;
}

/**
 * Confirmation ferme post-paiement (story 3.2, #3) contre un **Redis réel** et un **PMS mocké**.
 *
 * Ce qui n'est prouvable qu'ici :
 * - le flux HTTP `/api/v1` complet, en-têtes de cache compris ;
 * - la frontière `X-Service-Key` (AC-12) : présente sur `POST /reservations/{id}/confirm`, absente
 *   de TOUS les autres appels PMS du parcours ;
 * - le single-flight sur le vrai verrou Redis (deux requêtes HTTP concurrentes → un seul POST PMS) ;
 * - l'effet réel sur l'index du balayeur (`forget`) et la conservation de l'enregistrement de hold.
 *
 * ⚠️ Isolation : identifiants uniques par test, jamais de purge par motif (Redis partagé).
 */
describe('payment/confirm (e2e — Redis réel + PMS mocké)', () => {
  let app: NestExpressApplication;
  let redis: RedisService;
  let options: AuthOptions;

  let hotelId: string;
  let roomId: string;
  let reservationId: string;
  let userId: string;
  let cookie: string;
  let openedSids: string[] = [];
  let pmsStatus: number;
  let seen: SeenCall[];

  const reservationPath = () =>
    `${PMS_PREFIX}/roomreservations/${reservationId}`;
  const confirmPath = () =>
    `${PMS_PREFIX}/reservations/${reservationId}/confirm`;

  /** Réservation de 2 nuits × 84 € = 168,00 €, statut piloté par `pmsStatus`. */
  const reservationBody = () => ({
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
      customerName: 'Léa Voyageuse',
      customerEmail: 'lea@example.com',
      checkInDate: `${CHECK_IN}T00:00:00Z`,
      checkOutDate: `${CHECK_OUT}T00:00:00Z`,
      numberOfGuests: 2,
      numberOfNights: 2,
      pricePerNight: 84,
      totalPrice: 168,
      grandTotal: 168,
      servicesTotal: 0,
      services: [],
      specialRequests: 'Allergie aux arachides',
      status: pmsStatus,
    },
  });

  const confirmationBody = (overrides: Record<string, unknown> = {}) => ({
    success: true,
    message: 'Reservation confirmed',
    data: {
      reservationId,
      grandTotal: 168,
      droppedServices: [],
      reservationCode: 'RES-20260901-A1B2C',
      currency: 'EUR',
      capturedAmount: 168,
      alreadyConfirmed: false,
      ...overrides,
    },
  });

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

  /** Lectures PMS du parcours (réservation + devise), observées. */
  function mockReads(): void {
    nock(PMS_HOST)
      .persist()
      .get(reservationPath())
      .reply(function () {
        record('GET', reservationPath(), this.req.headers);
        return [200, reservationBody()];
      })
      .get(`${PMS_PREFIX}/Hotels/${hotelId}`)
      .reply(function () {
        record('GET', `/Hotels/${hotelId}`, this.req.headers);
        return [200, { success: true, data: { id: hotelId, currency: 'EUR' } }];
      });
  }

  /** Confirmation PMS : passe la réservation `Confirmed` (status 2) à la réponse. */
  function mockConfirm(
    reply: () => [number, unknown] = () => [200, confirmationBody()],
    times = 1,
    delayMs = 0,
  ): nock.Scope {
    return nock(PMS_HOST)
      .post(confirmPath())
      .times(times)
      .delay(delayMs)
      .reply(function () {
        record('POST', confirmPath(), this.req.headers);
        const [status, body] = reply();
        if (status === 200) {
          pmsStatus = 2;
        }
        return [status, body];
      });
  }

  async function seedHold(): Promise<void> {
    const hold: CheckoutHoldRecord = {
      reservationId,
      sid: openedSids[0],
      userId,
      hotelId,
      roomId,
      expiresAt: Date.now() + 900_000,
      stayKey: `booking:idem:v1:${randomUUID()}`,
      paymentStarted: true,
      attempts: 0,
    };
    await redis.set(
      HOLD_KEY_PREFIX + reservationId,
      JSON.stringify(hold),
      3600,
    );
    await redis.raw.zadd(HOLD_INDEX_KEY, hold.expiresAt, reservationId);
  }

  async function indexed(): Promise<boolean> {
    return (await redis.raw.zscore(HOLD_INDEX_KEY, reservationId)) !== null;
  }

  async function openSession(accountId: string): Promise<string> {
    const newSid = `e2e-confirm-${randomUUID()}`;
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
    process.env.SERVICE_KEY = SERVICE_KEY;
    // Rejeux rapides : la confirmation garde ses retries par défaut (route idempotente, #152).
    process.env.PMS_RETRY_BASE_DELAY_MS = '5';

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
    pmsStatus = 1;
    seen = [];
    cookie = await openSession(userId);
  });

  afterEach(async () => {
    nock.cleanAll();
    for (const openedSid of openedSids) {
      await redis.del(SESSION_KEY_PREFIX + openedSid);
    }
    await redis.del(HOLD_KEY_PREFIX + reservationId);
    await redis.del(COMM_LOCALE_KEY_PREFIX + reservationId);
    await redis.del(CONFIRM_LOCK_KEY_PREFIX + reservationId);
    await redis.raw.zrem(HOLD_INDEX_KEY, reservationId);
  });

  afterAll(async () => {
    nock.enableNetConnect();
    await app.close();
  });

  const postConfirm = (id: string = reservationId, withCookie = cookie) =>
    request(app.getHttpServer())
      .post(`/api/v1/payment/reservations/${id}/confirm`)
      .set('Cookie', withCookie);

  describe('flux nominal', () => {
    it('200 : preuve réduite, montant capturé relu, aucune PII', async () => {
      mockReads();
      const scope = mockConfirm();
      await seedHold();
      await redis.set(COMM_LOCALE_KEY_PREFIX + reservationId, 'en', 3600);

      const response = await postConfirm().expect(200);
      const body = response.body as ProofEnvelope;

      expect(scope.isDone()).toBe(true);
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        reservationId,
        reservationCode: 'RES-20260901-A1B2C',
        status: 'Confirmed',
        hotelName: 'Hôtel Colline',
        currency: 'EUR',
        total: 16_800,
        capturedAmount: 16_800,
        alreadyConfirmed: false,
        communicationLocale: 'en',
        communicationLocaleState: 'hotel_default_fallback',
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(
        /lea@example\.com|Voyageuse|arachides|validationToken|customer/i,
      );
    });

    it('jamais mis en cache : no-store et Vary: Cookie', async () => {
      mockReads();
      mockConfirm();

      const response = await postConfirm().expect(200);

      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers.vary).toContain('Cookie');
    });

    it('oublie le hold (index du balayeur) sans le libérer (enregistrement conservé)', async () => {
      mockReads();
      mockConfirm();
      await seedHold();
      expect(await indexed()).toBe(true);

      await postConfirm().expect(200);

      expect(await indexed()).toBe(false);
      // `forget`, pas `release` : l'enregistrement et la clé d'idempotence expirent par leur TTL.
      expect(await redis.get(HOLD_KEY_PREFIX + reservationId)).not.toBeNull();
      // Verrou single-flight rendu.
      expect(
        await redis.get(CONFIRM_LOCK_KEY_PREFIX + reservationId),
      ).toBeNull();
    });
  });

  describe('AC-12 — frontière de la clé de service', () => {
    it('X-Service-Key sur POST /reservations/{id}/confirm, et nulle part ailleurs', async () => {
      mockReads();
      mockConfirm();

      await postConfirm().expect(200);

      const confirmCalls = seen.filter((c) => c.path === confirmPath());
      const others = seen.filter((c) => c.path !== confirmPath());
      expect(confirmCalls).toHaveLength(1);
      expect(confirmCalls[0].serviceKey).toBe(SERVICE_KEY);
      // La confirmation est une route de service : aucun JWT voyageur n'y part.
      expect(confirmCalls[0].authorization).toBeUndefined();
      expect(others.length).toBeGreaterThan(0);
      for (const call of others) {
        expect(call.serviceKey).toBeUndefined();
      }
      // La clé ne revient jamais au navigateur.
    });

    it('la clé de service ne sort jamais dans une réponse', async () => {
      mockReads();
      mockConfirm();

      const response = await postConfirm().expect(200);

      expect(JSON.stringify(response.body)).not.toContain(SERVICE_KEY);
      expect(JSON.stringify(response.headers)).not.toContain(SERVICE_KEY);
    });
  });

  describe('idempotence', () => {
    it('rejeu : la réservation déjà Confirmed rend la même preuve SANS appeler la confirmation', async () => {
      mockReads();
      const scope = mockConfirm(undefined, 1);

      const first = (await postConfirm().expect(200)).body as ProofEnvelope;
      const second = (await postConfirm().expect(200)).body as ProofEnvelope;

      expect(scope.isDone()).toBe(true);
      expect(seen.filter((c) => c.path === confirmPath())).toHaveLength(1);
      expect(second.data.reservationCode).toBe(first.data.reservationCode);
      expect(second.data.total).toBe(first.data.total);
      expect(second.data.alreadyConfirmed).toBe(true);
    });

    it('deux onglets concurrents : UN seul POST de confirmation au PMS, deux 200', async () => {
      mockReads();
      mockConfirm(undefined, 2, 400);

      const [a, b] = await Promise.all([postConfirm(), postConfirm()]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(seen.filter((c) => c.path === confirmPath())).toHaveLength(1);
      const codes = [a.body as ProofEnvelope, b.body as ProofEnvelope].map(
        (p) => p.data.reservationCode,
      );
      expect(codes[0]).toBe(codes[1]);
    });
  });

  describe('refus', () => {
    it('400 sur un identifiant qui n’est pas un GUID, sans appel PMS', async () => {
      await postConfirm('pas-un-guid').expect(400);
      expect(seen).toHaveLength(0);
    });

    it('401 sans cookie de session', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/payment/reservations/${reservationId}/confirm`)
        .expect(401);
    });

    it('404 pour la réservation d’une autre session, aucune confirmation tentée', async () => {
      nock(PMS_HOST)
        .get(reservationPath())
        .reply(403, { success: false, errors: ['Forbidden'] });
      const scope = mockConfirm();

      const response = await postConfirm().expect(404);

      expect((response.body as ErrorEnvelope).errors?.reason).toEqual([
        'reservation-not-found',
      ]);
      expect(scope.isDone()).toBe(false);
    });

    it('502 « capture échouée » après rejeux : motif capture-failed, hold toujours indexé', async () => {
      mockReads();
      await seedHold();
      mockConfirm(
        () => [502, { success: false, errors: ['Payment capture failed'] }],
        3,
      );

      const response = await postConfirm().expect(502);
      const body = response.body as ErrorEnvelope;

      expect(body.errors?.reason).toEqual(['capture-failed']);
      expect(JSON.stringify(body)).not.toContain('Payment capture failed');
      // Aucun forget ni release après un échec (AC-5).
      expect(await indexed()).toBe(true);
    });

    it('400 « paiement non autorisé » : 409 payment-not-authorized', async () => {
      mockReads();
      mockConfirm(() => [
        400,
        { success: false, errors: ['Reservation payment is not authorized'] },
      ]);

      const response = await postConfirm().expect(409);

      expect((response.body as ErrorEnvelope).errors?.reason).toEqual([
        'payment-not-authorized',
      ]);
    });

    it('PMS en panne : 503 sans motif (le front propose de réessayer)', async () => {
      mockReads();
      mockConfirm(() => [500, { success: false }], 3);

      const response = await postConfirm().expect(503);

      expect((response.body as ErrorEnvelope).errors?.reason).toBeUndefined();
    });
  });
});
