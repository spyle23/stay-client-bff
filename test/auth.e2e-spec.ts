import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import nock from 'nock';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { correlationMiddleware } from '../src/common/correlation/correlation.middleware';
import { PmsRequestError } from '../src/integration/pms/pms-errors';
import {
  AUTH_OPTIONS,
  type AuthOptions,
  SESSION_KEY_PREFIX,
} from '../src/modules/auth/auth.constants';
import {
  buildSessionCookieValue,
  generateSessionId,
  verifySessionCookieValue,
} from '../src/modules/auth/session-cookie';
import {
  type PmsAuthResponse,
  SessionService,
} from '../src/modules/auth/session.service';
import { RedisService } from '../src/redis/redis.service';

const PMS_HOST = 'http://pms.auth.local';
const PMS_PREFIX = '/api/v1';

/**
 * Intégration du domaine `auth` (story 2.1) contre un **Redis réel** (`redis://127.0.0.1:6379`,
 * conteneur `redis:7-alpine`) et un **PMS mocké** (nock) — même dispositif que `health.e2e-spec`.
 *
 * Deux niveaux couverts :
 * 1. **HTTP** (supertest) — login/session/logout : cookie, enveloppe, absence de jeton, whitelist ;
 * 2. **service + Redis réel** — refresh single-flight sous concurrence (AC-7) : c'est le **verrou
 *    Redis réel** qui est éprouvé ici, ce qu'un faux client ne peut pas prouver. Aucune route HTTP
 *    n'emprunte encore `withCustomerAuth` (elle arrive en 2.4/Epic 4) : on résout le service
 *    depuis le conteneur Nest plutôt que d'inventer une route de test.
 */
describe('auth (e2e — Redis réel + PMS mocké)', () => {
  let app: INestApplication<App>;
  let sessions: SessionService;
  let redis: RedisService;
  let options: AuthOptions;

  const authBody = (
    overrides: Partial<PmsAuthResponse> = {},
  ): { success: true; data: PmsAuthResponse } => ({
    success: true,
    data: {
      userId: '11111111-1111-1111-1111-111111111111',
      email: 'voyageur@example.com',
      firstName: 'Rakoto',
      lastName: 'Randria',
      role: 4,
      accessToken: 'access-1',
      accessTokenExpiration: new Date(Date.now() + 3_600_000).toISOString(),
      refreshToken: 'refresh-1',
      refreshTokenExpiration: new Date(
        Date.now() + 7 * 86_400_000,
      ).toISOString(),
      ...overrides,
    },
  });

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    process.env.PMS_BASE_URL = `${PMS_HOST}${PMS_PREFIX}`;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(correlationMiddleware);
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
    await app.init();

    sessions = app.get(SessionService);
    redis = app.get(RedisService);
    options = app.get<AuthOptions>(AUTH_OPTIONS);

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

  /** Extrait le `sid` du `Set-Cookie` en vérifiant la signature (comme le ferait le navigateur). */
  function sidFromSetCookie(header: string | string[] | undefined): string {
    const raw = Array.isArray(header) ? header[0] : (header ?? '');
    const value = /stay_sid=([^;]+)/.exec(raw)?.[1] ?? '';
    const sid = verifySessionCookieValue(
      decodeURIComponent(value),
      options.sessionSecret,
    );
    expect(sid).not.toBeNull();
    return sid as string;
  }

  describe('POST /api/v1/auth/login', () => {
    it('200 : cookie opaque HttpOnly/Secure/SameSite=Lax, session en Redis, aucun jeton renvoyé', async () => {
      nock(PMS_HOST)
        .post(`${PMS_PREFIX}/auth/login`, {
          email: 'voyageur@example.com',
          password: 'secret123',
        })
        .reply(200, authBody());

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'voyageur@example.com', password: 'secret123' });

      expect(res.status).toBe(200);
      const setCookie = res.headers['set-cookie'] as unknown as string[];
      const cookie = setCookie[0];
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');

      // Invariant NFR-8 : ni le corps ni le cookie ne transportent de jeton.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('access-1');
      expect(serialized).not.toContain('refresh-1');
      expect(cookie).not.toContain('access-1');
      expect(res.body).toEqual({
        success: true,
        data: {
          authenticated: true,
          user: {
            userId: '11111111-1111-1111-1111-111111111111',
            email: 'voyageur@example.com',
            firstName: 'Rakoto',
            lastName: 'Randria',
          },
        },
      });

      // Les jetons, eux, sont bien côté serveur.
      const sid = sidFromSetCookie(setCookie);
      const stored = await redis.get(SESSION_KEY_PREFIX + sid);
      expect(stored).toContain('access-1');
      expect(stored).toContain('refresh-1');
      const ttl = await redis.raw.ttl(SESSION_KEY_PREFIX + sid);
      expect(ttl).toBeGreaterThan(0);

      await redis.del(SESSION_KEY_PREFIX + sid);
    });

    it('403 sans cookie quand le compte n’est pas un Customer (AC-4)', async () => {
      nock(PMS_HOST)
        .post(`${PMS_PREFIX}/auth/login`)
        .reply(200, authBody({ role: 2 })); // Manager

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'manager@example.com', password: 'secret123' });

      expect(res.status).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body).toMatchObject({ success: false });
    });

    it('normalise un refus d’identifiants en 401 générique, sans divulguer le message du PMS', async () => {
      nock(PMS_HOST)
        .post(`${PMS_PREFIX}/auth/login`)
        .reply(400, { success: false, message: 'Invalid email or password.' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'voyageur@example.com', password: 'mauvais' });

      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body).toMatchObject({ success: false });
      // Anti-énumération **serveur** : le texte du PMS distingue « compte inconnu » de
      // « mot de passe incorrect ». Il ne doit pas être lisible dans la réponse HTTP.
      expect(JSON.stringify(res.body)).not.toContain(
        'Invalid email or password',
      );
    });

    it('normalise l’email en minuscules avant de le transmettre au PMS', async () => {
      // Le PMS stocke l'email en minuscules à l'inscription mais compare brut à la connexion :
      // sans normalisation, une majuscule saisie rendrait le compte inaccessible.
      const scope = nock(PMS_HOST)
        .post(`${PMS_PREFIX}/auth/login`, {
          email: 'voyageur@example.com',
          password: 'secret123',
        })
        .reply(200, authBody());

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: '  Voyageur@Example.COM ', password: 'secret123' });

      expect(res.status).toBe(200);
      expect(scope.isDone()).toBe(true);

      const sid = sidFromSetCookie(res.headers['set-cookie']);
      await redis.del(SESSION_KEY_PREFIX + sid);
    });

    it('interdit la mise en cache de la réponse de connexion', async () => {
      nock(PMS_HOST).post(`${PMS_PREFIX}/auth/login`).reply(200, authBody());

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'voyageur@example.com', password: 'secret123' });

      expect(res.headers['cache-control']).toBe('no-store, private');
      const sid = sidFromSetCookie(res.headers['set-cookie']);
      await redis.del(SESSION_KEY_PREFIX + sid);
    });

    it('400 sur un champ non déclaré (whitelist stricte), sans appel PMS', async () => {
      const scope = nock(PMS_HOST)
        .post(`${PMS_PREFIX}/auth/login`)
        .reply(200, authBody());

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          email: 'voyageur@example.com',
          password: 'secret123',
          role: 'Manager',
        });

      expect(res.status).toBe(400);
      expect(scope.isDone()).toBe(false);
      nock.removeInterceptor({
        proto: 'http',
        host: 'pms.auth.local',
        path: `${PMS_PREFIX}/auth/login`,
        method: 'POST',
      });
    });

    it('400 sur un email malformé, sans appel PMS', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'pas-un-email', password: 'secret123' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/auth/session', () => {
    it('200 « anonyme » sans cookie (jamais 401 pour un visiteur)', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/v1/auth/session',
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: { authenticated: false, user: null },
      });
    });

    it('200 « anonyme » pour un cookie falsifié', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/session')
        .set('Cookie', `stay_sid=${generateSessionId()}.signature-forgee`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ data: { authenticated: false } });
    });

    it('efface le cookie orphelin (signature valide, session absente de Redis)', async () => {
      const orphan = buildSessionCookieValue(
        generateSessionId(),
        options.sessionSecret,
      );

      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/session')
        .set('Cookie', `stay_sid=${orphan}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ data: { authenticated: false } });
      // Sans cet effacement, le cookie mort survit jusqu'à son Max-Age et la garde `proxy.ts`
      // (test de présence) laisse passer /account pendant des jours.
      expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain(
        'Max-Age=0',
      );
    });

    it('interdit la mise en cache de la réponse porteuse d’identité', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/v1/auth/session',
      );

      expect(res.headers['cache-control']).toBe('no-store, private');
      expect(res.headers.vary).toContain('Cookie');
    });

    it('renvoie l’identité pour une session valide (snapshot Redis, AUCUN appel PMS)', async () => {
      nock(PMS_HOST).post(`${PMS_PREFIX}/auth/login`).reply(200, authBody());
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'voyageur@example.com', password: 'secret123' });
      const cookie = (login.headers['set-cookie'] as unknown as string[])[0];
      // Aucun interceptor PMS restant : un appel PMS ferait échouer la requête (net bloqué).
      nock.cleanAll();

      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/session')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      const body = res.body as { data: { authenticated: boolean } };
      expect(body.data).toMatchObject({
        authenticated: true,
        user: { email: 'voyageur@example.com' },
      });
      expect(JSON.stringify(res.body)).not.toContain('access-1');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('révoque côté PMS (Bearer proxifié), détruit la session, expire le cookie et refuse le rejeu', async () => {
      nock(PMS_HOST).post(`${PMS_PREFIX}/auth/login`).reply(200, authBody());
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'voyageur@example.com', password: 'secret123' });
      const cookie = (login.headers['set-cookie'] as unknown as string[])[0];
      const sid = sidFromSetCookie(login.headers['set-cookie']);

      let seenAuthorization: string | undefined;
      nock(PMS_HOST)
        .post(`${PMS_PREFIX}/auth/logout`)
        .reply(200, function () {
          seenAuthorization = this.req.headers.authorization;
          return { success: true, data: null };
        });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(seenAuthorization).toBe('Bearer access-1');
      expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain(
        'Max-Age=0',
      );
      expect(await redis.get(SESSION_KEY_PREFIX + sid)).toBeNull();

      // Rejeu du cookie détruit : la session n'est plus exploitable (invariant AC-5), vérifié
      // par `/auth/session`. La route reste **idempotente** (200 + cookie ré-effacé) plutôt que
      // de renvoyer 401 : un 401 laisserait le cookie mort dans le navigateur jusqu'à son
      // Max-Age, ce qui neutraliserait la garde `proxy.ts` (simple test de présence).
      const replay = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie);
      expect(replay.status).toBe(200);
      expect(
        (replay.headers['set-cookie'] as unknown as string[])[0],
      ).toContain('Max-Age=0');

      const after = await request(app.getHttpServer())
        .get('/api/v1/auth/session')
        .set('Cookie', cookie);
      expect(after.body).toMatchObject({ data: { authenticated: false } });
    });

    it('idempotent sans cookie : 200 et cookie effacé, sans appel PMS', async () => {
      const res = await request(app.getHttpServer()).post(
        '/api/v1/auth/logout',
      );

      expect(res.status).toBe(200);
      expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain(
        'Max-Age=0',
      );
      expect(res.body).toMatchObject({
        data: { authenticated: false, user: null },
      });
    });
  });

  describe('refresh single-flight (verrou Redis réel — AC-2 / AC-7)', () => {
    async function openSession(): Promise<string> {
      nock(PMS_HOST).post(`${PMS_PREFIX}/auth/login`).reply(200, authBody());
      const { sid } = await sessions.login('voyageur@example.com', 'secret123');
      return sid;
    }

    it('401 → un SEUL refresh PMS pour deux appels concurrents → rejeu avec le nouveau jeton', async () => {
      const sid = await openSession();
      nock.cleanAll();

      // Un seul refresh autorisé ; le second (rotation PMS oblige) serait un 400.
      const refresh = nock(PMS_HOST)
        .post(`${PMS_PREFIX}/auth/refresh-token`, {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
        })
        .reply(
          200,
          authBody({ accessToken: 'access-2', refreshToken: 'refresh-2' }),
        );
      const secondRefresh = nock(PMS_HOST)
        .post(`${PMS_PREFIX}/auth/refresh-token`)
        .reply(400, {
          success: false,
          message: 'Invalid or expired refresh token.',
        });

      const call = () =>
        sessions.withCustomerAuth(sid, (token) =>
          token === 'access-1'
            ? Promise.reject(new PmsRequestError('expiré', 401))
            : Promise.resolve(token),
        );

      const [a, b] = await Promise.all([call(), call()]);

      expect(a).toBe('access-2');
      expect(b).toBe('access-2');
      expect(refresh.isDone()).toBe(true);
      // La preuve du single-flight : le second interceptor n'a jamais été consommé.
      expect(secondRefresh.isDone()).toBe(false);

      const stored = await redis.get(SESSION_KEY_PREFIX + sid);
      expect(stored).toContain('access-2');
      expect(stored).not.toContain('"accessToken":"access-1"');

      nock.cleanAll();
      await redis.del(SESSION_KEY_PREFIX + sid);
    });

    it('refresh refusé (400) → session détruite en Redis + 401', async () => {
      const sid = await openSession();
      nock.cleanAll();
      nock(PMS_HOST).post(`${PMS_PREFIX}/auth/refresh-token`).reply(400, {
        success: false,
        message: 'Invalid or expired refresh token.',
      });

      await expect(
        sessions.withCustomerAuth(sid, () =>
          Promise.reject(new PmsRequestError('expiré', 401)),
        ),
      ).rejects.toMatchObject({ status: 401 });

      expect(await redis.get(SESSION_KEY_PREFIX + sid)).toBeNull();
    });

    it('libère le verrou de refresh (aucune clé de verrou résiduelle)', async () => {
      const sid = await openSession();
      nock.cleanAll();
      nock(PMS_HOST)
        .post(`${PMS_PREFIX}/auth/refresh-token`)
        .reply(
          200,
          authBody({ accessToken: 'access-2', refreshToken: 'refresh-2' }),
        );

      let first = true;
      await sessions.withCustomerAuth(sid, (token) => {
        if (first) {
          first = false;
          return Promise.reject(new PmsRequestError('expiré', 401));
        }
        return Promise.resolve(token);
      });

      const locks = await redis.raw.keys('auth:refresh:lock:v1:*');
      expect(locks).toEqual([]);

      await redis.del(SESSION_KEY_PREFIX + sid);
    });
  });
});
