import { resolvePaymentOptions } from './payment.constants';

/**
 * Story 3.2 — réglages du verrou single-flight de la confirmation.
 *
 * Le verrou ne protège QUE s'il survit à l'appel PMS qu'il encadre (leçon 2.1) : un TTL plus court
 * que le budget d'un appel complet laisserait partir une seconde confirmation pendant la première.
 */
describe('resolvePaymentOptions', () => {
  it('défauts : TTL au-delà du budget PMS complet, attente et scrutation bornées', () => {
    const options = resolvePaymentOptions({});

    // Budget par défaut : 8 s × 3 tentatives + backoff ≈ 24,75 s.
    expect(options.confirmLockTtlMs).toBeGreaterThan(24_750);
    expect(options.confirmWaitTimeoutMs).toBe(30_000);
    expect(options.confirmPollIntervalMs).toBe(250);
  });

  it('refuse au boot un TTL de verrou inférieur au budget PMS', () => {
    expect(() =>
      resolvePaymentOptions({
        PMS_TIMEOUT_MS: '20000',
        PAYMENT_CONFIRM_LOCK_MS: '30000',
      }),
    ).toThrow(/PAYMENT_CONFIRM_LOCK_MS/);
  });

  it('refuse une scrutation plus lente que l’attente', () => {
    expect(() =>
      resolvePaymentOptions({
        PAYMENT_CONFIRM_WAIT_MS: '1000',
        PAYMENT_CONFIRM_POLL_MS: '1000',
      }),
    ).toThrow(/PAYMENT_CONFIRM_POLL_MS/);
  });

  it('borne les valeurs aberrantes au lieu de désactiver le verrou', () => {
    const options = resolvePaymentOptions({
      PAYMENT_CONFIRM_WAIT_MS: '-5',
      PAYMENT_CONFIRM_POLL_MS: 'abc',
    });

    expect(options.confirmWaitTimeoutMs).toBeGreaterThanOrEqual(1_000);
    expect(options.confirmPollIntervalMs).toBe(250);
  });
});
