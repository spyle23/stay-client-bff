import { resolveReconcileOptions } from './reconcile.constants';

describe('resolveReconcileOptions (#5 AC-8)', () => {
  const base = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

  it('applique les défauts documentés', () => {
    expect(resolveReconcileOptions(base)).toMatchObject({
      enabled: true,
      intervalMs: 60_000,
      batchSize: 50,
      alertAfterSeconds: 900,
      alertRepeatSeconds: 3_600,
      maxAgeSeconds: 691_200,
    });
  });

  it('coupe le job sous NODE_ENV=test, comme le balayeur', () => {
    expect(resolveReconcileOptions({ NODE_ENV: 'test' }).enabled).toBe(false);
  });

  it('un interrupteur explicite prime, même sous NODE_ENV=test', () => {
    expect(
      resolveReconcileOptions({
        NODE_ENV: 'test',
        PAYMENT_RECONCILE_ENABLED: 'true',
      }).enabled,
    ).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', 'n', ' FALSE '])(
    'toute forme de « non » coupe (%p)',
    (raw) => {
      expect(
        resolveReconcileOptions({ ...base, PAYMENT_RECONCILE_ENABLED: raw })
          .enabled,
      ).toBe(false);
    },
  );

  it('refuse de démarrer sur un interrupteur illisible', () => {
    expect(() =>
      resolveReconcileOptions({
        ...base,
        PAYMENT_RECONCILE_ENABLED: 'peut-être',
      }),
    ).toThrow(/PAYMENT_RECONCILE_ENABLED/);
  });

  it('lit des valeurs valides', () => {
    expect(
      resolveReconcileOptions({
        ...base,
        PAYMENT_RECONCILE_INTERVAL_MS: '10000',
        PAYMENT_RECONCILE_BATCH: '5',
        PAYMENT_RECONCILE_ALERT_AFTER_SECONDS: '120',
        PAYMENT_RECONCILE_ALERT_REPEAT_SECONDS: '600',
        PAYMENT_RECONCILE_MAX_AGE_SECONDS: '86400',
      }),
    ).toMatchObject({
      enabled: true,
      intervalMs: 10_000,
      batchSize: 5,
      alertAfterSeconds: 120,
      alertRepeatSeconds: 600,
      maxAgeSeconds: 86_400,
    });
  });

  it.each([
    ['PAYMENT_RECONCILE_INTERVAL_MS', '9999'],
    ['PAYMENT_RECONCILE_INTERVAL_MS', '600001'],
    ['PAYMENT_RECONCILE_INTERVAL_MS', 'abc'],
    ['PAYMENT_RECONCILE_INTERVAL_MS', '15000.5'],
    ['PAYMENT_RECONCILE_BATCH', '0'],
    ['PAYMENT_RECONCILE_BATCH', '501'],
    ['PAYMENT_RECONCILE_ALERT_AFTER_SECONDS', '59'],
    ['PAYMENT_RECONCILE_ALERT_REPEAT_SECONDS', '59'],
    ['PAYMENT_RECONCILE_MAX_AGE_SECONDS', '3599'],
    ['PAYMENT_RECONCILE_MAX_AGE_SECONDS', '-1'],
  ])('refuse de démarrer hors bornes : %s=%s', (name, value) => {
    expect(() => resolveReconcileOptions({ ...base, [name]: value })).toThrow(
      new RegExp(name),
    );
  });

  it('refuse une alerte qui ne pourrait jamais partir avant la sortie de l’index', () => {
    expect(() =>
      resolveReconcileOptions({
        ...base,
        PAYMENT_RECONCILE_ALERT_AFTER_SECONDS: '7200',
        PAYMENT_RECONCILE_MAX_AGE_SECONDS: '3600',
      }),
    ).toThrow(/PAYMENT_RECONCILE_ALERT_AFTER_SECONDS/);
  });

  it('dérive le budget d’un appel PMS de la configuration du client', () => {
    expect(
      resolveReconcileOptions({
        ...base,
        PMS_TIMEOUT_MS: '1000',
        PMS_MAX_RETRIES: '0',
      }).pmsCallBudgetMs,
    ).toBe(1_000);
  });

  it('une variable vide retombe sur le défaut', () => {
    expect(
      resolveReconcileOptions({ ...base, PAYMENT_RECONCILE_INTERVAL_MS: ' ' })
        .intervalMs,
    ).toBe(60_000);
  });
});
