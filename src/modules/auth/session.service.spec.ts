import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { CorrelationService } from '../../common/correlation/correlation.service';
import type { PmsClientService } from '../../integration/pms/pms-client.service';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import type { RedisService } from '../../redis/redis.service';
import {
  type AuthOptions,
  CUSTOMER_ROLE,
  REFRESH_LOCK_PREFIX,
  SESSION_KEY_PREFIX,
} from './auth.constants';
import { satisfiesPmsPasswordPolicy } from './guest-password';
import {
  GUEST_ACCOUNT_ORPHANED_CODE,
  GuestEmailConflictError,
  type PmsAuthResponse,
  PMS_AUTH_ENDPOINTS,
  SessionService,
} from './session.service';

const OPTIONS: AuthOptions = {
  sessionSecret: 'secret-de-test-suffisamment-long-0123456789',
  cookieName: 'stay_sid',
  cookieSecure: true,
  maxSessionTtlSeconds: 7 * 24 * 3600,
  refreshLockTtlMs: 10_000,
  refreshWaitTimeoutMs: 300,
  refreshPollIntervalMs: 10,
};

/**
 * Redis en mémoire : `store` pour les sessions, `locks` pour le verrou `SET NX PX`.
 *
 * ⚠️ Le faux client **enregistre les TTL** (`ttls`, `lockTtls`) et **vérifie les options**
 * `PX`/`NX` : sans cela, supprimer l'expiration d'une session (vérité durable interdite par AR-6)
 * ou celle du verrou (immobilisation définitive du refresh) laisserait toute la suite au vert.
 */
function makeRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const locks = new Map<string, string>();
  const lockTtls = new Map<string, number>();
  return {
    store,
    ttls,
    locks,
    lockTtls,
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string, ttlSeconds?: number) => {
      store.set(key, value);
      ttls.set(key, ttlSeconds);
      return Promise.resolve();
    }),
    del: jest.fn((key: string) => {
      store.delete(key);
      ttls.delete(key);
      return Promise.resolve(1);
    }),
    raw: {
      set: jest.fn(
        (
          key: string,
          value: string,
          px?: string,
          ttlMs?: number,
          nx?: string,
        ) => {
          // Le verrou DOIT être posé en `SET key value PX <ttl> NX` : sans `NX` il n'exclut
          // personne, sans `PX` il ne se libère jamais si l'instance meurt.
          expect(px).toBe('PX');
          expect(nx).toBe('NX');
          expect(typeof ttlMs).toBe('number');
          expect(ttlMs).toBeGreaterThan(0);
          if (locks.has(key)) {
            return Promise.resolve(null); // verrou déjà détenu
          }
          locks.set(key, value);
          lockTtls.set(key, ttlMs as number);
          return Promise.resolve('OK');
        },
      ),
      eval: jest.fn(
        (_script: string, _n: number, key: string, token: string) => {
          if (locks.get(key) === token) {
            locks.delete(key);
            lockTtls.delete(key);
          }
          return Promise.resolve(1);
        },
      ),
    },
  };
}

function authResponse(
  overrides: Partial<PmsAuthResponse> = {},
): PmsAuthResponse {
  return {
    userId: 'u-1',
    email: 'voyageur@example.com',
    firstName: 'Rakoto',
    lastName: 'Randria',
    role: CUSTOMER_ROLE,
    accessToken: 'access-1',
    accessTokenExpiration: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: 'refresh-1',
    refreshTokenExpiration: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ...overrides,
  };
}

describe('SessionService', () => {
  let redis: ReturnType<typeof makeRedis>;
  let pms: { post: jest.Mock };
  let service: SessionService;

  beforeEach(() => {
    redis = makeRedis();
    pms = { post: jest.fn() };
    const correlation = {
      getCorrelationId: () => 'cid-test',
    } as unknown as CorrelationService;
    service = new SessionService(
      pms as unknown as PmsClientService,
      redis as unknown as RedisService,
      correlation,
      OPTIONS,
    );
  });

  describe('provisionGuest (story 2.3 — FR-8)', () => {
    const GUEST = {
      email: 'invite@example.com',
      firstName: 'Hery',
      lastName: 'Rakoto',
      phone: '+261340000000',
    };

    it('crée le compte léger puis la session, sans exposer le mot de passe généré', async () => {
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({ email: GUEST.email }),
      });

      const result = await service.provisionGuest(GUEST);

      expect(pms.post).toHaveBeenCalledTimes(1);
      const [path, body, ctx] = pms.post.mock.calls[0] as [
        string,
        Record<string, string>,
        Record<string, unknown>,
      ];
      expect(path).toBe(PMS_AUTH_ENDPOINTS.registerCustomer);
      expect(body).toMatchObject({
        email: GUEST.email,
        firstName: 'Hery',
        lastName: 'Rakoto',
        phone: '+261340000000',
      });
      // `ConfirmPassword` est NotEmpty + Equal(Password) côté PMS : l'omettre produirait un 400
      // de validation, indiscernable d'une collision d'email.
      expect(body.confirmPassword).toBe(body.password);
      expect(satisfiesPmsPasswordPolicy(body.password)).toBe(true);
      // Écriture non idempotente : un rejeu après réponse perdue reviendrait en « email déjà
      // pris » sur un compte que personne ne peut ouvrir (AC-10).
      expect(ctx).toMatchObject({ maxRetries: 0 });

      expect(result.user.email).toBe(GUEST.email);
      expect(JSON.stringify(result.user)).not.toContain(body.password);
      expect(redis.store.get(SESSION_KEY_PREFIX + result.sid)).toBeDefined();
      // Le mot de passe généré ne doit pas non plus être persisté en session.
      expect(redis.store.get(SESSION_KEY_PREFIX + result.sid)).not.toContain(
        body.password,
      );
    });

    it('tire un mot de passe différent à chaque provisioning', async () => {
      pms.post.mockResolvedValue({ success: true, data: authResponse() });

      await service.provisionGuest(GUEST);
      await service.provisionGuest({ ...GUEST, email: 'autre@example.com' });

      const [, first] = pms.post.mock.calls[0] as [
        string,
        { password: string },
      ];
      const [, second] = pms.post.mock.calls[1] as [
        string,
        { password: string },
      ];
      expect(first.password).not.toBe(second.password);
    });

    /**
     * ⚠️ Forme **réelle** de la réponse du PMS, relevée en Phase 3 :
     * `{"success":false,"message":null,"errors":["Email is already registered."]}`.
     * Le motif vit dans `errors`, pas dans `message` — une fixture qui le placerait dans
     * `message` rendrait le test vert alors que la production ne détecte rien.
     */
    const conflictError = () =>
      new PmsRequestError('Le PMS a renvoyé le statut 400.', 400, {
        errors: ['Email is already registered.'],
        responseBody: {
          success: false,
          message: null,
          errors: ['Email is already registered.'],
        },
      });

    it('collision d’email → GuestEmailConflictError, sans session ni cookie', async () => {
      pms.post.mockRejectedValue(conflictError());

      await expect(service.provisionGuest(GUEST)).rejects.toBeInstanceOf(
        GuestEmailConflictError,
      );
      expect(redis.store.size).toBe(0);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it.each([
      ['errors en tableau', { errors: ['Email is already registered.'] }],
      [
        'errors par champ',
        { errors: { email: ['Email is already registered.'] } },
      ],
      ['casse différente', { errors: ['EMAIL IS ALREADY REGISTERED.'] }],
      ['ponctuation absente', { errors: ['Email is already registered'] }],
    ])('reconnaît la collision — %s', async (_cas, options) => {
      pms.post.mockRejectedValue(
        new PmsRequestError('Le PMS a renvoyé le statut 400.', 400, options),
      );

      await expect(service.provisionGuest(GUEST)).rejects.toBeInstanceOf(
        GuestEmailConflictError,
      );
    });

    it('reconnaît aussi la collision portée par `message` (contrat futur)', async () => {
      pms.post.mockRejectedValue(
        new PmsRequestError('Email is already registered.', 400),
      );

      await expect(service.provisionGuest(GUEST)).rejects.toBeInstanceOf(
        GuestEmailConflictError,
      );
    });

    it('un 400 de validation N’EST PAS une collision (propagé tel quel)', async () => {
      const err = new PmsRequestError('Le PMS a renvoyé le statut 400.', 400, {
        errors: ['First name is required.'],
      });
      pms.post.mockRejectedValue(err);

      await expect(service.provisionGuest(GUEST)).rejects.toBe(err);
    });

    it('refuse un rôle non-Customer SANS créer de session', async () => {
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({ role: 2 }),
      });

      await expect(service.provisionGuest(GUEST)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(redis.store.size).toBe(0);
    });

    it('propage une panne PMS (503) sans la convertir en collision', async () => {
      pms.post.mockRejectedValue(new PmsUnavailableError('PMS injoignable'));

      await expect(service.provisionGuest(GUEST)).rejects.toBeInstanceOf(
        PmsUnavailableError,
      );
    });

    /**
     * Le compte PMS est **déjà créé** quand la session échoue : présenter cet échec comme une
     * panne ordinaire (« réessayez ») envoie le voyageur droit sur un 409 portant un compte que
     * personne ne peut ouvrir. Le code machine permet au front de dire autre chose.
     */
    it('panne Redis après création → 503 marqué « compte créé » (jamais 500)', async () => {
      pms.post.mockResolvedValue({ success: true, data: authResponse() });
      redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const failure = await service
        .provisionGuest(GUEST)
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(ServiceUnavailableException);
      const body = (failure as ServiceUnavailableException).getResponse();
      expect(body).toMatchObject({
        errors: { reason: [GUEST_ACCOUNT_ORPHANED_CODE] },
      });
    });

    it('réponse d’auth PMS incomplète après création → même marquage « compte créé »', async () => {
      // Le compte existe (201 reçu) mais le contrat est rompu : c'est un orphelin, pas un refus.
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({ refreshToken: null }),
      });

      const failure = await service
        .provisionGuest(GUEST)
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(ServiceUnavailableException);
      expect(
        (failure as ServiceUnavailableException).getResponse(),
      ).toMatchObject({ errors: { reason: [GUEST_ACCOUNT_ORPHANED_CODE] } });
    });

    it('journalise l’orphelin avec de quoi le rattraper, sans jamais de jeton', async () => {
      const logged: string[] = [];
      jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });
      pms.post.mockResolvedValue({ success: true, data: authResponse() });
      redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await service.provisionGuest(GUEST).catch(() => undefined);

      const alert = logged.join(' | ');
      expect(alert).toContain(GUEST.email);
      expect(alert).toContain('u-1');
      expect(alert).not.toContain('access-1');
      expect(alert).not.toContain('refresh-1');
      jest.restoreAllMocks();
    });
  });

  describe('login', () => {
    it('stocke les jetons côté serveur et ne renvoie que l’identité (aucun jeton)', async () => {
      pms.post.mockResolvedValue({ success: true, data: authResponse() });

      const result = await service.login('voyageur@example.com', 'secret123');

      expect(pms.post).toHaveBeenCalledWith(
        PMS_AUTH_ENDPOINTS.login,
        { email: 'voyageur@example.com', password: 'secret123' },
        { correlationId: 'cid-test' },
      );
      expect(result.user).toEqual({
        userId: 'u-1',
        email: 'voyageur@example.com',
        firstName: 'Rakoto',
        lastName: 'Randria',
      });
      // Invariant NFR-8 : rien de ce qui sort ne contient de jeton.
      expect(JSON.stringify(result.user)).not.toContain('access-1');
      expect(JSON.stringify(result.user)).not.toContain('refresh-1');

      const stored = redis.store.get(SESSION_KEY_PREFIX + result.sid);
      expect(stored).toBeDefined();
      expect(JSON.parse(stored as string)).toMatchObject({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
      });
    });

    it('refuse un rôle non-Customer SANS créer de session (AC-4)', async () => {
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({ role: 2 }), // Manager
      });

      await expect(
        service.login('manager@example.com', 'secret123'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(redis.store.size).toBe(0);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it.each([
      ['refreshToken', { refreshToken: null }],
      ['accessToken', { accessToken: null }],
      ['userId', { userId: null }],
      ['email', { email: null }],
      ['role', { role: null }],
    ])(
      'refuse une réponse PMS sans %s (contrat rompu — jamais de session à moitié)',
      async (_champ, overrides) => {
        pms.post.mockResolvedValue({
          success: true,
          data: authResponse(overrides),
        });

        await expect(
          service.login('a@b.c', 'secret123'),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(redis.store.size).toBe(0);
      },
    );

    it('tolère un rôle sérialisé en chaîne (sans jamais deviner)', async () => {
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({ role: '4' }),
      });

      await expect(service.login('a@b.c', 'secret123')).resolves.toMatchObject({
        user: { email: 'voyageur@example.com' },
      });
    });

    it('refuse un rôle non numérique plutôt que de le dégrader en 0', async () => {
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({ role: 'Customer' }),
      });

      await expect(service.login('a@b.c', 'secret123')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('remonte une panne du magasin de session en 503 (jamais en 500)', async () => {
      pms.post.mockResolvedValue({ success: true, data: authResponse() });
      redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(service.login('a@b.c', 'secret123')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('une panne Redis en lecture remonte en 503 (et non « anonyme » ni 500)', async () => {
      redis.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(service.read('sid-quelconque')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('dérive le TTL de session de l’expiration du refresh token', async () => {
      const expiration = new Date(Date.now() + 3_600_000).toISOString();
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({ refreshTokenExpiration: expiration }),
      });

      const { ttlSeconds } = await service.login('a@b.c', 'secret123');

      expect(ttlSeconds).toBeGreaterThan(3_500);
      expect(ttlSeconds).toBeLessThanOrEqual(3_600);
      expect(Number.isInteger(ttlSeconds)).toBe(true);
    });

    it('retombe sur le plafond quand l’expiration est absente ou illisible', async () => {
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({ refreshTokenExpiration: 'pas-une-date' }),
      });

      const { ttlSeconds } = await service.login('a@b.c', 'secret123');
      expect(ttlSeconds).toBe(OPTIONS.maxSessionTtlSeconds);
    });
  });

  describe('read / destroy', () => {
    it('renvoie null pour une session absente', async () => {
      await expect(service.read('inconnu')).resolves.toBeNull();
    });

    it('purge et renvoie null pour un enregistrement corrompu', async () => {
      redis.store.set(SESSION_KEY_PREFIX + 'abc', '{pas du json');

      await expect(service.read('abc')).resolves.toBeNull();
      expect(redis.store.has(SESSION_KEY_PREFIX + 'abc')).toBe(false);
    });

    it('destroy supprime la session', async () => {
      pms.post.mockResolvedValue({ success: true, data: authResponse() });
      const { sid } = await service.login('a@b.c', 'secret123');

      await service.destroy(sid);

      expect(await service.read(sid)).toBeNull();
    });
  });

  describe('logout', () => {
    it('révoque côté PMS puis détruit la session', async () => {
      pms.post.mockResolvedValue({ success: true, data: authResponse() });
      const { sid } = await service.login('a@b.c', 'secret123');
      pms.post.mockClear();
      pms.post.mockResolvedValue({ success: true, data: undefined });

      await service.logout(sid);

      expect(pms.post).toHaveBeenCalledWith(
        PMS_AUTH_ENDPOINTS.logout,
        undefined,
        expect.objectContaining({ bearerToken: 'access-1' }),
      );
      expect(await service.read(sid)).toBeNull();
    });

    it('détruit la session même si la révocation PMS échoue (best-effort)', async () => {
      pms.post.mockResolvedValue({ success: true, data: authResponse() });
      const { sid } = await service.login('a@b.c', 'secret123');
      pms.post.mockRejectedValue(new PmsUnavailableError('PMS down'));

      await expect(service.logout(sid)).resolves.toBeUndefined();
      expect(await service.read(sid)).toBeNull();
    });
  });

  describe('withCustomerAuth', () => {
    async function loggedInSid(): Promise<string> {
      pms.post.mockResolvedValue({ success: true, data: authResponse() });
      const { sid } = await service.login('a@b.c', 'secret123');
      pms.post.mockReset();
      return sid;
    }

    it('rejette une session inexistante en 401', async () => {
      await expect(
        service.withCustomerAuth('inconnu', () => Promise.resolve('ok')),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('passe le jeton courant et n’appelle PAS le refresh au cas nominal', async () => {
      const sid = await loggedInSid();

      const result = await service.withCustomerAuth(sid, (token) =>
        Promise.resolve(`vu:${token}`),
      );

      expect(result).toBe('vu:access-1');
      expect(pms.post).not.toHaveBeenCalled();
    });

    it('401 → refresh → rejeu UNE fois avec le nouveau jeton', async () => {
      const sid = await loggedInSid();
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
        }),
      });

      const seen: string[] = [];
      const result = await service.withCustomerAuth(sid, (token) => {
        seen.push(token);
        return seen.length === 1
          ? Promise.reject(new PmsRequestError('expiré', 401))
          : Promise.resolve(`vu:${token}`);
      });

      expect(result).toBe('vu:access-2');
      expect(seen).toEqual(['access-1', 'access-2']);
      // Le PMS exige les DEUX jetons (l'access expiré identifie l'utilisateur).
      expect(pms.post).toHaveBeenCalledWith(
        PMS_AUTH_ENDPOINTS.refreshToken,
        { accessToken: 'access-1', refreshToken: 'refresh-1' },
        { correlationId: 'cid-test' },
      );
      const stored = JSON.parse(
        redis.store.get(SESSION_KEY_PREFIX + sid) as string,
      ) as { accessToken: string; refreshToken: string };
      expect(stored).toMatchObject({
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
      });
    });

    it('un 401 persistant après refresh détruit la session', async () => {
      const sid = await loggedInSid();
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({ accessToken: 'access-2' }),
      });

      await expect(
        service.withCustomerAuth(sid, () =>
          Promise.reject(new PmsRequestError('expiré', 401)),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(await service.read(sid)).toBeNull();
    });

    it('refresh refusé par le PMS (4xx) → session détruite + 401', async () => {
      const sid = await loggedInSid();
      pms.post.mockRejectedValue(
        new PmsRequestError('Invalid or expired refresh token.', 400),
      );

      await expect(
        service.withCustomerAuth(sid, () =>
          Promise.reject(new PmsRequestError('expiré', 401)),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(await service.read(sid)).toBeNull();
    });

    it('panne PMS pendant le refresh → 503 propagé, session CONSERVÉE (NFR-10)', async () => {
      const sid = await loggedInSid();
      pms.post.mockRejectedValue(new PmsUnavailableError('PMS down'));

      await expect(
        service.withCustomerAuth(sid, () =>
          Promise.reject(new PmsRequestError('expiré', 401)),
        ),
      ).rejects.toBeInstanceOf(PmsUnavailableError);
      // Une indisponibilité transitoire ne doit jamais déconnecter l'utilisateur.
      expect(await service.read(sid)).not.toBeNull();
    });

    it('propage une erreur non-401 sans tenter de refresh', async () => {
      const sid = await loggedInSid();
      const boom = new PmsRequestError('conflit', 409);

      await expect(
        service.withCustomerAuth(sid, () => Promise.reject(boom)),
      ).rejects.toBe(boom);
      expect(pms.post).not.toHaveBeenCalled();
    });

    it('SINGLE-FLIGHT : deux appels concurrents ne déclenchent qu’UN refresh (AC-7)', async () => {
      const sid = await loggedInSid();
      // Le PMS révoque l'ancien refresh token : un second appel échouerait en 400.
      pms.post.mockImplementation(() => {
        if (pms.post.mock.calls.length > 1) {
          return Promise.reject(
            new PmsRequestError('Invalid or expired refresh token.', 400),
          );
        }
        return Promise.resolve({
          success: true,
          data: authResponse({
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
          }),
        });
      });

      const call = () => {
        let first = true;
        return service.withCustomerAuth(sid, (token) => {
          if (first && token === 'access-1') {
            first = false;
            return Promise.reject(new PmsRequestError('expiré', 401));
          }
          return Promise.resolve(token);
        });
      };

      const [a, b] = await Promise.all([call(), call()]);

      expect(a).toBe('access-2');
      expect(b).toBe('access-2');
      expect(pms.post).toHaveBeenCalledTimes(1);
    });

    it('écrit TOUJOURS la session avec un TTL (aucune vérité durable en Redis — AR-6)', async () => {
      const sid = await loggedInSid();

      const ttl = redis.ttls.get(SESSION_KEY_PREFIX + sid);
      expect(ttl).toBeDefined();
      expect(ttl).toBeGreaterThan(0);
    });

    it('pose le verrou de refresh avec une expiration (anti-deadlock distribué)', async () => {
      const sid = await loggedInSid();
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({ accessToken: 'access-2' }),
      });

      let first = true;
      await service.withCustomerAuth(sid, (token) => {
        if (first) {
          first = false;
          return Promise.reject(new PmsRequestError('expiré', 401));
        }
        return Promise.resolve(token);
      });

      // `redis.raw.set` a vérifié PX/NX ; on contrôle ici la valeur réellement transmise.
      expect(redis.raw.set).toHaveBeenCalled();
      const [, , px, ttlMs, nx] = redis.raw.set.mock.calls[0] as [
        string,
        string,
        string,
        number,
        string,
      ];
      expect(px).toBe('PX');
      expect(nx).toBe('NX');
      expect(ttlMs).toBe(OPTIONS.refreshLockTtlMs);
    });

    it('VERROU DÉTENU AILLEURS : attend le pair, sans émettre de second refresh', async () => {
      // Chemin multi-instances — celui que la dédup in-process (`Map<sid,Promise>`) court-circuite
      // dans tous les autres tests. On pré-pose le verrou pour forcer la branche « perdant ».
      const sid = await loggedInSid();
      redis.locks.set(REFRESH_LOCK_PREFIX + sid, 'verrou-d-une-autre-instance');

      // Le pair écrit sa session rafraîchie pendant que nous scrutons.
      setTimeout(() => {
        redis.store.set(
          SESSION_KEY_PREFIX + sid,
          JSON.stringify(
            authResponse({
              accessToken: 'access-du-pair',
              refreshToken: 'refresh-du-pair',
            }),
          ),
        );
      }, 30);

      let first = true;
      const result = await service.withCustomerAuth(sid, (token) => {
        if (first) {
          first = false;
          return Promise.reject(new PmsRequestError('expiré', 401));
        }
        return Promise.resolve(token);
      });

      expect(result).toBe('access-du-pair');
      // L'invariant du single-flight distribué : aucun appel PMS depuis cette instance.
      expect(pms.post).not.toHaveBeenCalled();
    });

    it('VERROU DÉTENU AILLEURS : 503 si le pair n’aboutit pas dans le budget d’attente', async () => {
      const sid = await loggedInSid();
      redis.locks.set(REFRESH_LOCK_PREFIX + sid, 'verrou-bloque');

      await expect(
        service.withCustomerAuth(sid, () =>
          Promise.reject(new PmsRequestError('expiré', 401)),
        ),
        // 503 et non 401 : la session est valide, c'est le rafraîchissement qui n'a pas abouti.
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(pms.post).not.toHaveBeenCalled();
    });

    it('VERROU DÉTENU AILLEURS : 401 si la session disparaît pendant l’attente', async () => {
      const sid = await loggedInSid();
      redis.locks.set(REFRESH_LOCK_PREFIX + sid, 'verrou-d-une-autre-instance');
      setTimeout(() => redis.store.delete(SESSION_KEY_PREFIX + sid), 30);

      await expect(
        service.withCustomerAuth(sid, () =>
          Promise.reject(new PmsRequestError('expiré', 401)),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('NE RESSUSCITE PAS une session détruite par un logout concurrent', async () => {
      const sid = await loggedInSid();
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({ accessToken: 'access-2' }),
      });

      let first = true;
      const failure = service.withCustomerAuth(sid, (token) => {
        if (first) {
          first = false;
          // Déconnexion concurrente : la session disparaît pendant notre appel.
          redis.store.delete(SESSION_KEY_PREFIX + sid);
          return Promise.reject(new PmsRequestError('expiré', 401));
        }
        return Promise.resolve(token);
      });

      await expect(failure).rejects.toBeInstanceOf(UnauthorizedException);
      // Sans la garde, le refresh réécrivait la clé pour 7 jours alors que l'utilisateur
      // s'est déconnecté et que son cookie est déjà expiré côté navigateur.
      expect(redis.store.has(SESSION_KEY_PREFIX + sid)).toBe(false);
      expect(pms.post).not.toHaveBeenCalled();
    });

    it.each([404, 429])(
      'un %i du PMS au refresh ne détruit PAS la session (ce n’est pas un refus de jeton)',
      async (status) => {
        const sid = await loggedInSid();
        pms.post.mockRejectedValue(new PmsRequestError('incident', status));

        await expect(
          service.withCustomerAuth(sid, () =>
            Promise.reject(new PmsRequestError('expiré', 401)),
          ),
        ).rejects.toMatchObject({ status });
        // Un rate-limiting (6.1) ou une route déplacée ne doit pas éjecter un voyageur valide.
        expect(await service.read(sid)).not.toBeNull();
      },
    );

    it('libère le verrou de refresh après usage (pas d’immobilisation)', async () => {
      const sid = await loggedInSid();
      pms.post.mockResolvedValue({
        success: true,
        data: authResponse({ accessToken: 'access-2' }),
      });

      let first = true;
      await service.withCustomerAuth(sid, (token) => {
        if (first) {
          first = false;
          return Promise.reject(new PmsRequestError('expiré', 401));
        }
        return Promise.resolve(token);
      });

      expect(redis.locks.size).toBe(0);
    });

    it('réutilise la session déjà rafraîchie par une autre instance (relecture sous verrou)', async () => {
      const sid = await loggedInSid();

      let first = true;
      const result = await service.withCustomerAuth(sid, (token) => {
        if (first) {
          first = false;
          // Pendant notre appel, une AUTRE instance BFF a rafraîchi la session en Redis.
          redis.store.set(
            SESSION_KEY_PREFIX + sid,
            JSON.stringify(
              authResponse({
                accessToken: 'access-peer',
                refreshToken: 'refresh-peer',
              }),
            ),
          );
          return Promise.reject(new PmsRequestError('expiré', 401));
        }
        return Promise.resolve(token);
      });

      // Aucun refresh émis : rejouer le refresh aurait été rejeté (jeton déjà tourné côté PMS).
      expect(result).toBe('access-peer');
      expect(pms.post).not.toHaveBeenCalled();
    });
  });
});
