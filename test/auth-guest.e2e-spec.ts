import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import nock from 'nock';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { correlationMiddleware } from '../src/common/correlation/correlation.middleware';
import { satisfiesPmsPasswordPolicy } from '../src/modules/auth/guest-password';
import {
  AUTH_OPTIONS,
  type AuthOptions,
  SESSION_KEY_PREFIX,
} from '../src/modules/auth/auth.constants';
import { verifySessionCookieValue } from '../src/modules/auth/session-cookie';
import type { PmsAuthResponse } from '../src/modules/auth/session.service';
import { RedisService } from '../src/redis/redis.service';

const PMS_HOST = 'http://pms.guest.local';
const PMS_PREFIX = '/api/v1';
const REGISTER_PATH = `${PMS_PREFIX}/auth/register/customer`;

/**
 * Checkout invité (story 2.3 — FR-8) contre un **Redis réel** (`redis://127.0.0.1:6379`) et un
 * **PMS mocké** (nock). Ce qui n'est prouvable qu'ici :
 * - le corps réellement envoyé au PMS (mot de passe conforme, `confirmPassword` présent) ;
 * - l'absence de retry sur cette écriture non idempotente (AC-10) ;
 * - la distinction 409 (collision) / 400 (validation) telle que la voit le navigateur ;
 * - la session écrite en Redis et l'absence totale de jeton dans la réponse HTTP.
 */
describe('auth/guest (e2e — Redis réel + PMS mocké)', () => {
  let app: INestApplication<App>;
  let redis: RedisService;
  let options: AuthOptions;

  const GUEST = {
    email: 'invite@example.com',
    firstName: 'Hery',
    lastName: 'Rakoto',
    phone: '+261 34 00 000 00',
  };

  const authBody = (
    overrides: Partial<PmsAuthResponse> = {},
  ): { success: true; data: PmsAuthResponse } => ({
    success: true,
    data: {
      userId: '22222222-2222-2222-2222-222222222222',
      email: 'invite@example.com',
      firstName: 'Hery',
      lastName: 'Rakoto',
      role: 4,
      accessToken: 'guest-access-1',
      accessTokenExpiration: new Date(Date.now() + 3_600_000).toISOString(),
      refreshToken: 'guest-refresh-1',
      refreshTokenExpiration: new Date(
        Date.now() + 7 * 86_400_000,
      ).toISOString(),
      ...overrides,
    },
  });

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    process.env.PMS_BASE_URL = `${PMS_HOST}${PMS_PREFIX}`;
    // ⚠️ Cette suite n'exerce PAS le limiteur (c'est le rôle de `booking-reservation.e2e-spec.ts`) :
    // ses ~20 soumissions partent du même email et de la même adresse et franchiraient les seuils
    // par défaut. On les relève donc ici, plutôt que de purger `throttle:*` après chaque test :
    // sur un Redis réel et **partagé** (`jest-e2e.json` ne fixe pas `maxWorkers`, les 12 suites
    // tournent en parallèle), cette purge effaçait aussi les compteurs de la suite qui teste la
    // limitation — dont les seuils devenaient dépendants de l'ordonnancement.
    process.env.THROTTLE_IP_LIMIT = '1000';
    process.env.THROTTLE_IDENTITY_LIMIT = '1000';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(correlationMiddleware);
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
    await app.init();

    redis = app.get(RedisService);
    options = app.get<AuthOptions>(AUTH_OPTIONS);

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  afterEach(() => {
    // Aucune purge par motif : les seuils relevés en `beforeAll` suffisent à immuniser la suite,
    // et un `KEYS throttle:*` casserait les suites voisines (voir `beforeAll`). Les compteurs
    // laissés derrière expirent seuls avec leur fenêtre.
    nock.cleanAll();
  });

  afterAll(async () => {
    nock.enableNetConnect();
    await app.close();
  });

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

  it('200 : compte léger provisionné, session en Redis, aucun jeton renvoyé', async () => {
    let sentBody: Record<string, string> = {};
    nock(PMS_HOST)
      .post(REGISTER_PATH, (body: Record<string, string>) => {
        sentBody = body;
        return true;
      })
      .reply(201, authBody());

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/guest')
      .send(GUEST);

    expect(res.status).toBe(200);

    // Corps réellement transmis au PMS.
    expect(sentBody.email).toBe('invite@example.com');
    expect(sentBody.firstName).toBe('Hery');
    expect(sentBody.phone).toBe('+261 34 00 000 00');
    expect(sentBody.confirmPassword).toBe(sentBody.password);
    expect(satisfiesPmsPasswordPolicy(sentBody.password)).toBe(true);

    // Cookie opaque, jamais de JWT.
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const cookie = setCookie[0];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('guest-access-1');

    expect(res.body).toEqual({
      success: true,
      data: {
        authenticated: true,
        user: {
          userId: '22222222-2222-2222-2222-222222222222',
          email: 'invite@example.com',
          firstName: 'Hery',
          lastName: 'Rakoto',
        },
      },
    });
    // Ni jeton, ni mot de passe généré dans la réponse HTTP.
    expect(JSON.stringify(res.body)).not.toMatch(/token|password/i);
    expect(JSON.stringify(res.body)).not.toContain(sentBody.password);
    expect(res.headers['cache-control']).toBe('no-store, private');

    // Les jetons vivent côté serveur, dans Redis, avec un TTL.
    const sid = sidFromSetCookie(setCookie);
    const stored = await redis.get(SESSION_KEY_PREFIX + sid);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored as string)).toMatchObject({
      accessToken: 'guest-access-1',
      refreshToken: 'guest-refresh-1',
    });
    await redis.del(SESSION_KEY_PREFIX + sid);
  });

  it('normalise l’email en minuscules avant de le transmettre au PMS', async () => {
    let sentEmail = '';
    nock(PMS_HOST)
      .post(REGISTER_PATH, (body: Record<string, string>) => {
        sentEmail = body.email;
        return true;
      })
      .reply(201, authBody());

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/guest')
      .send({ ...GUEST, email: '  Invite@Example.COM  ' });

    expect(res.status).toBe(200);
    expect(sentEmail).toBe('invite@example.com');
  });

  /**
   * ⚠️ Corps **réel** du PMS relevé en Phase 3 : le texte vit dans `errors`, `message` est `null`
   * (`ApiBadRequest` + `Result.Failure`). Une fixture qui le placerait dans `message` validerait
   * un chemin que la production n'emprunte jamais.
   */
  it('409 générique quand l’email est déjà pris (texte du PMS jamais relayé)', async () => {
    nock(PMS_HOST)
      .post(REGISTER_PATH)
      .reply(400, {
        success: false,
        data: null,
        message: null,
        errors: ['Email is already registered.'],
      });

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/guest')
      .send(GUEST);

    expect(res.status).toBe(409);
    expect(res.headers['set-cookie']).toBeUndefined();
    // Ni dans `message`, ni dans `errors` : le corps du PMS ne doit pas transiter du tout.
    expect(JSON.stringify(res.body)).not.toMatch(/already registered/i);
    expect(res.body).toMatchObject({ success: false });
  });

  it('400 (et non 409) quand le PMS refuse la saisie pour une autre raison', async () => {
    nock(PMS_HOST)
      .post(REGISTER_PATH)
      .reply(400, {
        success: false,
        message: null,
        errors: ['First name is required.'],
      });

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/guest')
      .send(GUEST);

    expect(res.status).toBe(400);
    expect(res.headers['set-cookie']).toBeUndefined();
    // Le texte technique du PMS ne remonte pas davantage au navigateur.
    expect(JSON.stringify(res.body)).not.toMatch(/First name is required/i);
  });

  it('5xx PMS → 503 après UN SEUL appel (écriture non idempotente, AC-10)', async () => {
    let calls = 0;
    const scope = nock(PMS_HOST)
      .post(REGISTER_PATH)
      .times(3)
      .reply(503, { success: false, message: 'indisponible' });
    scope.on('request', () => {
      calls += 1;
    });

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/guest')
      .send(GUEST);

    expect(res.status).toBe(503);
    expect(calls).toBe(1);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('403 sans cookie si le compte résolu n’est pas un Customer', async () => {
    nock(PMS_HOST)
      .post(REGISTER_PATH)
      .reply(201, authBody({ role: 2 }));

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/guest')
      .send(GUEST);

    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('réutilise la session existante du MÊME email sans rappeler le PMS (double soumission)', async () => {
    nock(PMS_HOST).post(REGISTER_PATH).reply(201, authBody());
    const first = await request(app.getHttpServer())
      .post('/api/v1/auth/guest')
      .send(GUEST);
    expect(first.status).toBe(200);
    const cookie = (first.headers['set-cookie'] as unknown as string[])[0];

    // Aucune interception armée : tout appel PMS ferait échouer la requête.
    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/guest')
      .set('Cookie', cookie.split(';')[0])
      .send(GUEST);

    expect(second.status).toBe(200);
    const body = second.body as {
      data: { user: { email: string } };
    };
    expect(body.data.user.email).toBe('invite@example.com');

    await redis.del(SESSION_KEY_PREFIX + sidFromSetCookie(cookie));
  });

  it('remplace une session ouverte sur un AUTRE email (ancienne session détruite)', async () => {
    nock(PMS_HOST).post(REGISTER_PATH).reply(201, authBody());
    const first = await request(app.getHttpServer())
      .post('/api/v1/auth/guest')
      .send({ ...GUEST, email: 'premier@example.com' });
    const firstCookie = (first.headers['set-cookie'] as unknown as string[])[0];
    const firstSid = sidFromSetCookie(firstCookie);

    nock(PMS_HOST)
      .post(REGISTER_PATH)
      .reply(201, authBody({ email: 'second@example.com', userId: 'u-2' }));
    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/guest')
      .set('Cookie', firstCookie.split(';')[0])
      .send({ ...GUEST, email: 'second@example.com' });

    expect(second.status).toBe(200);
    const secondSid = sidFromSetCookie(second.headers['set-cookie']);
    expect(secondSid).not.toBe(firstSid);
    expect(await redis.get(SESSION_KEY_PREFIX + firstSid)).toBeNull();

    await redis.del(SESSION_KEY_PREFIX + secondSid);
  });

  describe('validation de la saisie (aucun appel PMS ne doit partir)', () => {
    it.each([
      ['email manquant', { ...GUEST, email: undefined }],
      ['email invalide', { ...GUEST, email: 'pas-un-email' }],
      ['prénom vide', { ...GUEST, firstName: '   ' }],
      ['nom trop long', { ...GUEST, lastName: 'x'.repeat(101) }],
      ['téléphone manquant', { ...GUEST, phone: undefined }],
      ['téléphone invalide', { ...GUEST, phone: 'appelez-moi' }],
      ['téléphone trop long', { ...GUEST, phone: '+2613400000000000000000' }],
      ['champ non déclaré', { ...GUEST, password: 'ChoisiParMoi1!' }],
    ])('400 : %s', async (_cas, body) => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/guest')
        .send(body);

      expect(res.status).toBe(400);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(nock.pendingMocks()).toHaveLength(0);
    });
  });
});
