import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { PmsRequestError } from '../../integration/pms/pms-errors';
import type { AuthOptions } from './auth.constants';
import { AuthController } from './auth.controller';
import { buildSessionCookieValue, generateSessionId } from './session-cookie';
import type { SessionRecord, SessionService } from './session.service';

const OPTIONS: AuthOptions = {
  sessionSecret: 'secret-de-test-suffisamment-long-0123456789',
  cookieName: 'stay_sid',
  cookieSecure: true,
  maxSessionTtlSeconds: 604_800,
  refreshLockTtlMs: 10_000,
  refreshWaitTimeoutMs: 5_000,
  refreshPollIntervalMs: 100,
};

const RECORD: SessionRecord = {
  userId: 'u-1',
  email: 'voyageur@example.com',
  firstName: 'Rakoto',
  lastName: null,
  role: 4,
  accessToken: 'access-1',
  accessTokenExpiration: null,
  refreshToken: 'refresh-1',
  refreshTokenExpiration: null,
};

function makeResponse() {
  const headers = new Map<string, string>();
  return {
    headers,
    setHeader: jest.fn((name: string, value: string) => {
      headers.set(name, value);
    }),
  };
}

describe('AuthController', () => {
  let sessions: {
    login: jest.Mock;
    read: jest.Mock;
    logout: jest.Mock;
  };
  let controller: AuthController;

  beforeEach(() => {
    sessions = { login: jest.fn(), read: jest.fn(), logout: jest.fn() };
    controller = new AuthController(
      sessions as unknown as SessionService,
      OPTIONS,
    );
  });

  describe('login', () => {
    it('pose un cookie opaque et ne renvoie AUCUN jeton', async () => {
      sessions.login.mockResolvedValue({
        sid: 'sid-123',
        ttlSeconds: 3600,
        user: {
          userId: 'u-1',
          email: 'voyageur@example.com',
          firstName: 'Rakoto',
          lastName: null,
        },
      });
      const res = makeResponse();

      const body = await controller.login(
        { email: 'voyageur@example.com', password: 'secret123' },
        res as unknown as Response,
      );

      const cookie = res.headers.get('Set-Cookie') ?? '';
      expect(cookie).toContain('stay_sid=');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      // Le cookie ne transporte que <sid>.<signature> — jamais un JWT.
      expect(cookie).not.toContain('access-1');
      expect(body).toEqual({
        success: true,
        data: {
          authenticated: true,
          user: {
            userId: 'u-1',
            email: 'voyageur@example.com',
            firstName: 'Rakoto',
            lastName: null,
          },
        },
      });
      expect(JSON.stringify(body)).not.toMatch(/token/i);
    });

    it('ne pose aucun cookie quand le service refuse le rôle (AC-4)', async () => {
      sessions.login.mockRejectedValue(new ForbiddenException('rôle refusé'));
      const res = makeResponse();

      await expect(
        controller.login(
          { email: 'manager@example.com', password: 'secret123' },
          res as unknown as Response,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(res.headers.get('Set-Cookie')).toBeUndefined();
    });

    it.each([400, 401])(
      'normalise un refus d’identifiants PMS (%i) en 401 générique — anti-énumération serveur',
      async (status) => {
        sessions.login.mockRejectedValue(
          new PmsRequestError('Invalid email or password.', status),
        );
        const res = makeResponse();

        const failure = controller.login(
          { email: 'voyageur@example.com', password: 'mauvais' },
          res as unknown as Response,
        );

        await expect(failure).rejects.toBeInstanceOf(UnauthorizedException);
        // Le texte du PMS ne doit jamais atteindre la réponse HTTP : il distingue
        // « compte inconnu » de « mot de passe incorrect ».
        await expect(failure).rejects.not.toThrow(/Invalid email or password/);
        expect(res.headers.get('Set-Cookie')).toBeUndefined();
      },
    );

    it('laisse passer les autres erreurs PMS sans les masquer', async () => {
      sessions.login.mockRejectedValue(
        new PmsRequestError('Too many requests', 429),
      );
      const res = makeResponse();

      await expect(
        controller.login(
          { email: 'voyageur@example.com', password: 'secret123' },
          res as unknown as Response,
        ),
      ).rejects.toMatchObject({ status: 429 });
    });
  });

  describe('session', () => {
    /** Requête factice porteuse (ou non) d'un en-tête `Cookie`. */
    const requestWith = (cookie?: string) =>
      ({ headers: cookie ? { cookie } : {} }) as unknown as Parameters<
        typeof controller.session
      >[0];

    const signedCookie = (sid: string) =>
      `stay_sid=${buildSessionCookieValue(sid, OPTIONS.sessionSecret)}`;

    it('200 « anonyme » sans cookie (jamais 401 pour un visiteur)', async () => {
      const res = makeResponse();

      const body = await controller.session(
        requestWith(),
        res as unknown as Response,
      );

      expect(body).toEqual({
        success: true,
        data: { authenticated: false, user: null },
      });
      expect(sessions.read).not.toHaveBeenCalled();
    });

    it('200 « anonyme » pour un cookie falsifié, sans accès Redis', async () => {
      const res = makeResponse();

      const body = await controller.session(
        requestWith('stay_sid=forge.signature-bidon'),
        res as unknown as Response,
      );

      expect(body.data.authenticated).toBe(false);
      expect(sessions.read).not.toHaveBeenCalled();
    });

    it('efface le cookie orphelin quand la session a expiré côté Redis', async () => {
      const sid = generateSessionId();
      sessions.read.mockResolvedValue(null);
      const res = makeResponse();

      const body = await controller.session(
        requestWith(signedCookie(sid)),
        res as unknown as Response,
      );

      expect(body.data).toEqual({ authenticated: false, user: null });
      // Sans cet effacement, `proxy.ts` (test de présence) laisserait passer /account des jours.
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    });

    it('renvoie l’identité (sans jeton) pour une session valide', async () => {
      const sid = generateSessionId();
      sessions.read.mockResolvedValue(RECORD);
      const res = makeResponse();

      const body = await controller.session(
        requestWith(signedCookie(sid)),
        res as unknown as Response,
      );

      expect(body.data).toEqual({
        authenticated: true,
        user: {
          userId: 'u-1',
          email: 'voyageur@example.com',
          firstName: 'Rakoto',
          lastName: null,
        },
      });
      expect(JSON.stringify(body)).not.toContain('access-1');
      expect(JSON.stringify(body)).not.toContain('refresh-1');
      // Session valide : le cookie encore bon ne doit pas être effacé.
      expect(res.headers.get('Set-Cookie')).toBeUndefined();
    });

    it('interdit la mise en cache d’une réponse porteuse d’identité', async () => {
      const res = makeResponse();

      await controller.session(requestWith(), res as unknown as Response);

      expect(res.headers.get('Cache-Control')).toBe('no-store, private');
      expect(res.headers.get('Vary')).toBe('Cookie');
    });
  });

  describe('logout', () => {
    const requestWith = (cookie?: string) =>
      ({ headers: cookie ? { cookie } : {} }) as unknown as Parameters<
        typeof controller.logout
      >[0];

    it('détruit la session et expire le cookie', async () => {
      const sid = generateSessionId();
      sessions.logout.mockResolvedValue(undefined);
      const res = makeResponse();

      const body = await controller.logout(
        requestWith(
          `stay_sid=${buildSessionCookieValue(sid, OPTIONS.sessionSecret)}`,
        ),
        res as unknown as Response,
      );

      expect(sessions.logout).toHaveBeenCalledWith(sid);
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
      expect(body.data).toEqual({ authenticated: false, user: null });
    });

    it('reste idempotent sans cookie : 200 et cookie effacé, sans appel PMS', async () => {
      const res = makeResponse();

      const body = await controller.logout(
        requestWith(),
        res as unknown as Response,
      );

      expect(sessions.logout).not.toHaveBeenCalled();
      // Le point du correctif : on efface TOUJOURS, y compris sur un cookie déjà périmé —
      // sinon il survit à sa session et neutralise la garde front jusqu'à son Max-Age.
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
      expect(body.data).toEqual({ authenticated: false, user: null });
    });

    it('efface le cookie même quand il est falsifié', async () => {
      const res = makeResponse();

      await controller.logout(
        requestWith('stay_sid=forge.signature-bidon'),
        res as unknown as Response,
      );

      expect(sessions.logout).not.toHaveBeenCalled();
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    });
  });
});
