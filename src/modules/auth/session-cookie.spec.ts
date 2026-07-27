import {
  buildClearedSessionCookie,
  buildSessionCookie,
  buildSessionCookieValue,
  generateSessionId,
  readSessionId,
  type SessionCookieOptions,
  verifySessionCookieValue,
} from './session-cookie';

const OPTIONS: SessionCookieOptions = {
  cookieName: 'stay_sid',
  sessionSecret: 'secret-de-test-suffisamment-long-0123456789',
  cookieSecure: true,
};

describe('session-cookie', () => {
  describe('generateSessionId', () => {
    it('produit un identifiant opaque, base64url, non devinable', () => {
      const a = generateSessionId();
      const b = generateSessionId();

      expect(a).not.toBe(b);
      // 32 octets en base64url = 43 caractères, sans « = », « + » ni « / ».
      expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe('verifySessionCookieValue', () => {
    it('accepte une valeur signée et renvoie le sid', () => {
      const sid = generateSessionId();
      const value = buildSessionCookieValue(sid, OPTIONS.sessionSecret);

      expect(verifySessionCookieValue(value, OPTIONS.sessionSecret)).toBe(sid);
    });

    it('rejette une signature falsifiée', () => {
      const sid = generateSessionId();
      const value = buildSessionCookieValue(sid, OPTIONS.sessionSecret);
      const tampered = `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;

      expect(
        verifySessionCookieValue(tampered, OPTIONS.sessionSecret),
      ).toBeNull();
    });

    it('rejette un sid modifié (la signature ne correspond plus)', () => {
      const sid = generateSessionId();
      const value = buildSessionCookieValue(sid, OPTIONS.sessionSecret);
      const [, signature] = value.split('.');

      expect(
        verifySessionCookieValue(
          `autre-sid.${signature}`,
          OPTIONS.sessionSecret,
        ),
      ).toBeNull();
    });

    it('rejette une valeur signée avec un AUTRE secret', () => {
      const sid = generateSessionId();
      const forged = buildSessionCookieValue(
        sid,
        'un-autre-secret-tout-aussi-long-0123456789',
      );

      expect(
        verifySessionCookieValue(forged, OPTIONS.sessionSecret),
      ).toBeNull();
    });

    it('rejette les formes malformées', () => {
      for (const value of [undefined, '', 'sans-point', '.signature', 'sid.']) {
        expect(
          verifySessionCookieValue(value, OPTIONS.sessionSecret),
        ).toBeNull();
      }
    });
  });

  describe('readSessionId', () => {
    it('extrait le sid depuis un en-tête Cookie complet', () => {
      const sid = generateSessionId();
      const value = buildSessionCookieValue(sid, OPTIONS.sessionSecret);
      const header = `NEXT_LOCALE=fr; stay_sid=${value}; WORKING_CURRENCY=EUR`;

      expect(readSessionId(header, OPTIONS)).toBe(sid);
    });

    it('renvoie null sans en-tête, ou si le cookie de session est absent', () => {
      expect(readSessionId(undefined, OPTIONS)).toBeNull();
      expect(readSessionId('NEXT_LOCALE=fr', OPTIONS)).toBeNull();
    });
  });

  describe('buildSessionCookie', () => {
    it('pose HttpOnly, Secure, SameSite=Lax, Path=/ et Max-Age', () => {
      const cookie = buildSessionCookie(generateSessionId(), 3600, OPTIONS);

      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('Max-Age=3600');
    });

    it('omet Secure quand il est désactivé (proxy non-TLS)', () => {
      const cookie = buildSessionCookie(generateSessionId(), 60, {
        ...OPTIONS,
        cookieSecure: false,
      });

      expect(cookie).not.toContain('Secure');
      expect(cookie).toContain('HttpOnly');
    });
  });

  describe('buildClearedSessionCookie', () => {
    it('expire immédiatement le cookie (Max-Age=0) en conservant les attributs', () => {
      const cookie = buildClearedSessionCookie(OPTIONS);

      expect(cookie).toContain('stay_sid=;');
      expect(cookie).toContain('Max-Age=0');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
    });
  });
});
