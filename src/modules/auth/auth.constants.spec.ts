import {
  resolveAuthOptions,
  SESSION_SECRET_MIN_LENGTH,
} from './auth.constants';

const VALID_SECRET = 'x'.repeat(SESSION_SECRET_MIN_LENGTH);

describe('resolveAuthOptions', () => {
  it('échoue si SESSION_SECRET est absent (fail-fast au boot)', () => {
    expect(() => resolveAuthOptions({})).toThrow(/SESSION_SECRET/);
  });

  it('échoue si SESSION_SECRET est trop court', () => {
    expect(() => resolveAuthOptions({ SESSION_SECRET: 'trop-court' })).toThrow(
      /minimum 32/,
    );
  });

  it('échoue si SESSION_SECRET n’est que des espaces (trim)', () => {
    expect(() => resolveAuthOptions({ SESSION_SECRET: '   ' })).toThrow(
      /SESSION_SECRET/,
    );
  });

  it('accepte un secret valide et applique les défauts', () => {
    const options = resolveAuthOptions({ SESSION_SECRET: VALID_SECRET });

    expect(options.sessionSecret).toBe(VALID_SECRET);
    expect(options.cookieName).toBe('stay_sid');
    // Secure par défaut : localhost est un contexte sécurisé, pas de dégradation en dev.
    expect(options.cookieSecure).toBe(true);
    expect(options.maxSessionTtlSeconds).toBe(7 * 24 * 3600);
  });

  it('cookieSecure ne retombe à false que sur la valeur exacte "false"', () => {
    const off = resolveAuthOptions({
      SESSION_SECRET: VALID_SECRET,
      SESSION_COOKIE_SECURE: 'false',
    });
    const typo = resolveAuthOptions({
      SESSION_SECRET: VALID_SECRET,
      SESSION_COOKIE_SECURE: 'nope',
    });

    expect(off.cookieSecure).toBe(false);
    // Fail-safe : une valeur inattendue conserve le comportement le plus sûr.
    expect(typo.cookieSecure).toBe(true);
  });

  it('borne et normalise les durées en entiers (TTL Redis fractionnaire = écriture rejetée)', () => {
    const options = resolveAuthOptions({
      SESSION_SECRET: VALID_SECRET,
      SESSION_MAX_TTL_SECONDS: '10.5',
      SESSION_REFRESH_LOCK_MS: '999999',
      SESSION_REFRESH_POLL_MS: '1',
    });

    // 10.5 s < plancher 60 s → borné à 60, et entier.
    expect(options.maxSessionTtlSeconds).toBe(60);
    expect(Number.isInteger(options.maxSessionTtlSeconds)).toBe(true);
    expect(options.refreshLockTtlMs).toBe(120_000);
    expect(options.refreshPollIntervalMs).toBe(10);
  });

  it('retombe sur les défauts pour une valeur non numérique', () => {
    const options = resolveAuthOptions({
      SESSION_SECRET: VALID_SECRET,
      SESSION_REFRESH_WAIT_MS: 'abc',
    });
    expect(options.refreshWaitTimeoutMs).toBe(30_000);
  });

  it('le verrou de refresh couvre par défaut le budget d’un appel PMS complet', () => {
    const options = resolveAuthOptions({ SESSION_SECRET: VALID_SECRET });

    // PMS_TIMEOUT_MS (8 s) × (PMS_MAX_RETRIES + 1 = 3) + backoff ≈ 25 s. Un verrou plus court
    // expirerait PENDANT le refresh : une 2ᵉ instance en émettrait un second, que la rotation
    // du PMS rejetterait — déconnexion d'un voyageur en plein parcours.
    expect(options.refreshLockTtlMs).toBeGreaterThanOrEqual(25_000);
    // Le perdant du verrou doit pouvoir attendre le gagnant plutôt que d'abandonner en 503.
    expect(options.refreshWaitTimeoutMs).toBeGreaterThanOrEqual(25_000);
  });

  it('refuse un nom de cookie hors « token » RFC 7230 (sinon 500 à la 1ʳᵉ connexion)', () => {
    for (const name of ['stay sid', 'stay=sid', 'sid;', 'sid,x']) {
      expect(() =>
        resolveAuthOptions({
          SESSION_SECRET: VALID_SECRET,
          SESSION_COOKIE_NAME: name,
        }),
      ).toThrow(/SESSION_COOKIE_NAME invalide/);
    }
  });

  it('accepte les noms de cookie licites', () => {
    expect(
      resolveAuthOptions({
        SESSION_SECRET: VALID_SECRET,
        SESSION_COOKIE_NAME: '__Host-stay_sid',
      }).cookieName,
    ).toBe('__Host-stay_sid');
  });

  it('refuse un intervalle de scrutation supérieur au budget d’attente', () => {
    expect(() =>
      resolveAuthOptions({
        SESSION_SECRET: VALID_SECRET,
        SESSION_REFRESH_WAIT_MS: '100',
        SESSION_REFRESH_POLL_MS: '2000',
      }),
    ).toThrow(/SESSION_REFRESH_POLL_MS/);
  });

  it('accepte un nom de cookie personnalisé, ignore une valeur vide', () => {
    expect(
      resolveAuthOptions({
        SESSION_SECRET: VALID_SECRET,
        SESSION_COOKIE_NAME: 'custom_sid',
      }).cookieName,
    ).toBe('custom_sid');
    expect(
      resolveAuthOptions({
        SESSION_SECRET: VALID_SECRET,
        SESSION_COOKIE_NAME: '  ',
      }).cookieName,
    ).toBe('stay_sid');
  });
});
