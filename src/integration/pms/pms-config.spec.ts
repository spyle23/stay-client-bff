import { resolvePmsClientOptions } from './pms.module';

describe('resolvePmsClientOptions (bornes de config)', () => {
  it('applique les défauts sur un environnement vide', () => {
    const o = resolvePmsClientOptions({});
    expect(o.timeoutMs).toBe(8000);
    expect(o.maxRetries).toBe(2);
    expect(o.retryBaseDelayMs).toBe(150);
    expect(o.breaker.errorThresholdPercentage).toBe(50);
    expect(o.breaker.volumeThreshold).toBe(5);
  });

  it('timeout ≤ 0 retombe sur le défaut (jamais « aucun timeout »)', () => {
    expect(resolvePmsClientOptions({ PMS_TIMEOUT_MS: '0' }).timeoutMs).toBe(
      8000,
    );
    expect(resolvePmsClientOptions({ PMS_TIMEOUT_MS: '-5' }).timeoutMs).toBe(
      8000,
    );
  });

  it('maxRetries négatif est borné à 0 (au moins 1 essai)', () => {
    expect(resolvePmsClientOptions({ PMS_MAX_RETRIES: '-1' }).maxRetries).toBe(
      0,
    );
  });

  it('maxRetries est plafonné (anti-emballement)', () => {
    expect(resolvePmsClientOptions({ PMS_MAX_RETRIES: '999' }).maxRetries).toBe(
      10,
    );
  });

  it('le seuil du breaker est borné dans [1, 100]', () => {
    expect(
      resolvePmsClientOptions({ PMS_BREAKER_ERROR_THRESHOLD: '150' }).breaker
        .errorThresholdPercentage,
    ).toBe(100);
    expect(
      resolvePmsClientOptions({ PMS_BREAKER_ERROR_THRESHOLD: '0' }).breaker
        .errorThresholdPercentage,
    ).toBe(1);
  });

  it('une valeur non numérique retombe sur le défaut', () => {
    expect(resolvePmsClientOptions({ PMS_MAX_RETRIES: 'abc' }).maxRetries).toBe(
      2,
    );
  });
});
