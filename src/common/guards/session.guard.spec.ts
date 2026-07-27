import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { AuthOptions } from '../../modules/auth/auth.constants';
import {
  buildSessionCookieValue,
  generateSessionId,
} from '../../modules/auth/session-cookie';
import type {
  SessionRecord,
  SessionService,
} from '../../modules/auth/session.service';
import type { RequestWithSession } from '../decorators/current-session.decorator';
import { SessionGuard } from './session.guard';

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
  lastName: 'Randria',
  role: 4,
  accessToken: 'access-1',
  accessTokenExpiration: null,
  refreshToken: 'refresh-1',
  refreshTokenExpiration: null,
};

function contextFor(request: Partial<RequestWithSession>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('SessionGuard', () => {
  let sessions: { read: jest.Mock };
  let guard: SessionGuard;

  beforeEach(() => {
    sessions = { read: jest.fn() };
    guard = new SessionGuard(sessions as unknown as SessionService, OPTIONS);
  });

  it('refuse une requête sans cookie, sans toucher à Redis', async () => {
    await expect(
      guard.canActivate(contextFor({ headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.read).not.toHaveBeenCalled();
  });

  it('refuse un cookie de signature invalide, sans toucher à Redis (anti-énumération)', async () => {
    const context = contextFor({
      headers: { cookie: 'stay_sid=nimporte.quoi' },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessions.read).not.toHaveBeenCalled();
  });

  it('refuse une signature valide dont la session n’existe plus (rejeu après logout)', async () => {
    const sid = generateSessionId();
    sessions.read.mockResolvedValue(null);
    const context = contextFor({
      headers: {
        cookie: `stay_sid=${buildSessionCookieValue(sid, OPTIONS.sessionSecret)}`,
      },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessions.read).toHaveBeenCalledWith(sid);
  });

  it('autorise et attache { sid, user } SANS jeton', async () => {
    const sid = generateSessionId();
    sessions.read.mockResolvedValue(RECORD);
    const request: Partial<RequestWithSession> = {
      headers: {
        cookie: `stay_sid=${buildSessionCookieValue(sid, OPTIONS.sessionSecret)}`,
      },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.clientSession).toEqual({
      sid,
      user: {
        userId: 'u-1',
        email: 'voyageur@example.com',
        firstName: 'Rakoto',
        lastName: 'Randria',
      },
    });
    expect(JSON.stringify(request.clientSession)).not.toContain('access-1');
  });
});
