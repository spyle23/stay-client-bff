import { Logger } from '@nestjs/common';
import {
  GUEST_CHECKOUT_THROTTLE,
  reservationIdentityLimit,
  RESERVATION_THROTTLE,
  resolveThrottlerOptions,
  resolveTrustProxy,
  THROTTLER_NAMES,
} from './throttler.constants';

describe('resolveThrottlerOptions', () => {
  it('applique des défauts exploitables sans configuration', () => {
    const options = resolveThrottlerOptions({});
    expect(options).toEqual({
      windowMs: 60_000,
      ipLimit: 10,
      identityLimit: 5,
      blockMs: 60_000,
    });
  });

  it('est plus strict par identité que par IP (un compte n’enchaîne pas les créations)', () => {
    const options = resolveThrottlerOptions({});
    expect(options.identityLimit).toBeLessThan(options.ipLimit);
  });

  it('borne les valeurs hors plage plutôt que de les accepter', () => {
    expect(
      resolveThrottlerOptions({
        THROTTLE_IP_LIMIT: '0',
        THROTTLE_IDENTITY_LIMIT: '1',
      }).ipLimit,
    ).toBe(1);
    expect(
      resolveThrottlerOptions({ THROTTLE_IP_LIMIT: '99999' }).ipLimit,
    ).toBe(1_000);
  });

  it('normalise en entier : une valeur fractionnaire casserait les expirations Redis', () => {
    expect(
      resolveThrottlerOptions({
        THROTTLE_WINDOW_MS: '1500.7',
        THROTTLE_BLOCK_MS: '1000',
      }).windowMs,
    ).toBe(1500);
  });

  it.each(['', '   ', 'abc'])('retombe sur le défaut pour « %s »', (raw) => {
    expect(resolveThrottlerOptions({ THROTTLE_IP_LIMIT: raw }).ipLimit).toBe(
      10,
    );
  });

  /**
   * Contrôles de cohérence — refusés **au boot**, comme `resolveBookingOptions` refuse les siens.
   * Bornées indépendamment, ces valeurs passaient silencieusement en produisant une politique qui
   * ne veut rien dire.
   */
  it('refuse un seuil d’identité supérieur au seuil IP (compteur d’identité inatteignable)', () => {
    expect(() =>
      resolveThrottlerOptions({
        THROTTLE_IP_LIMIT: '5',
        THROTTLE_IDENTITY_LIMIT: '20',
      }),
    ).toThrow(/THROTTLE_IDENTITY_LIMIT/);
  });

  it('refuse un blocage plus long que la fenêtre (sanction sans compteur pour la justifier)', () => {
    expect(() =>
      resolveThrottlerOptions({
        THROTTLE_WINDOW_MS: '10000',
        THROTTLE_BLOCK_MS: '60000',
      }),
    ).toThrow(/THROTTLE_BLOCK_MS/);
  });
});

describe('reservationIdentityLimit', () => {
  /**
   * AC-5 déclare inoffensifs le double-clic, le F5 et le retour arrière : le service reconnaît le
   * rejeu et n'écrit rien. Mais le `ThrottlerGuard` compte **avant** lui — le seuil doit donc
   * absorber un tunnel normal, sinon le voyageur est éjecté au pire moment.
   */
  it('absorbe un tunnel normal (≥ 6 soumissions/minute) avec la configuration par défaut', () => {
    expect(
      reservationIdentityLimit(resolveThrottlerOptions({})),
    ).toBeGreaterThanOrEqual(6);
  });

  it('ne dépasse jamais le seuil IP (au-delà, il serait vain pour un client donné)', () => {
    const options = resolveThrottlerOptions({
      THROTTLE_IP_LIMIT: '6',
      THROTTLE_IDENTITY_LIMIT: '5',
    });
    expect(reservationIdentityLimit(options)).toBe(6);
  });
});

describe('configuration @Throttle des routes', () => {
  const KEYS = [
    'THROTTLE_WINDOW_MS',
    'THROTTLE_IP_LIMIT',
    'THROTTLE_IDENTITY_LIMIT',
    'THROTTLE_BLOCK_MS',
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('déclare les DEUX compteurs nommés sur chaque route gardée', () => {
    for (const config of [RESERVATION_THROTTLE, GUEST_CHECKOUT_THROTTLE]) {
      expect(Object.keys(config).sort()).toEqual(
        [THROTTLER_NAMES.identity, THROTTLER_NAMES.ip].sort(),
      );
    }
  });

  /**
   * ⚠️ Un décorateur est évalué à l'**import** du contrôleur, avant que le boot (ou une suite
   * e2e) n'ait posé ses variables. Des valeurs figées serviraient des seuils fantômes.
   */
  it('résout les seuils à chaud, jamais à l’import du contrôleur', () => {
    expect(RESERVATION_THROTTLE[THROTTLER_NAMES.ip].limit()).toBe(10);

    process.env.THROTTLE_IP_LIMIT = '42';
    process.env.THROTTLE_IDENTITY_LIMIT = '7';

    expect(RESERVATION_THROTTLE[THROTTLER_NAMES.ip].limit()).toBe(42);
    expect(RESERVATION_THROTTLE[THROTTLER_NAMES.identity].limit()).toBe(14);
    // `/auth/guest` garde le seuil nu : aucun rejeu gratuit à absorber.
    expect(GUEST_CHECKOUT_THROTTLE[THROTTLER_NAMES.identity].limit()).toBe(7);
  });

  it('relève le seuil d’identité de la création, sans toucher au seuil IP', () => {
    const identity = RESERVATION_THROTTLE[THROTTLER_NAMES.identity].limit();
    expect(identity).toBeGreaterThan(
      GUEST_CHECKOUT_THROTTLE[THROTTLER_NAMES.identity].limit(),
    );
    expect(RESERVATION_THROTTLE[THROTTLER_NAMES.ip].limit()).toBe(
      GUEST_CHECKOUT_THROTTLE[THROTTLER_NAMES.ip].limit(),
    );
  });
});

describe('resolveTrustProxy', () => {
  it('vaut `false` par défaut : activé sans proxy, n’importe qui forgerait son IP', () => {
    expect(resolveTrustProxy({})).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: '' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: 'false' })).toBe(false);
  });

  it('accepte l’activation explicite', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: 'true' })).toBe(true);
  });

  it('accepte un nombre de sauts de proxy de confiance', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '2' })).toBe(2);
    expect(resolveTrustProxy({ TRUST_PROXY: '0' })).toBe(0);
  });

  it('transmet une liste d’adresses telle quelle à Express', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '10.0.0.0/8' })).toBe('10.0.0.0/8');
    expect(resolveTrustProxy({ TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' })).toBe(
      '10.0.0.0/8, 127.0.0.1',
    );
    expect(resolveTrustProxy({ TRUST_PROXY: 'loopback' })).toBe('loopback');
    expect(resolveTrustProxy({ TRUST_PROXY: '::1/128' })).toBe('::1/128');
  });

  /**
   * ⚠️ Sans cette validation, la valeur atteignait `proxy-addr`, qui lève un
   * `TypeError: invalid IP address` **ne nommant aucune variable** : le BFF refusait de démarrer
   * sur un message opaque.
   */
  it.each(['1.5', '-1', 'oui', '10.0.0.0/64', '10.0.0.0/8,', '999.1.1.1'])(
    'refuse « %s » au boot en nommant TRUST_PROXY',
    (raw) => {
      expect(() => resolveTrustProxy({ TRUST_PROXY: raw })).toThrow(
        /TRUST_PROXY/,
      );
    },
  );

  it('journalise une erreur explicite si la variable manque en production', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      expect(resolveTrustProxy({ NODE_ENV: 'production' })).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain('TRUST_PROXY');
    } finally {
      error.mockRestore();
    }
  });

  it('reste silencieux quand le choix est explicite (false assumé en direct)', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      resolveTrustProxy({ NODE_ENV: 'production', TRUST_PROXY: 'false' });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
