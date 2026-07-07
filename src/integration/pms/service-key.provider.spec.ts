import { ServiceKeyProvider } from './service-key.provider';

describe('ServiceKeyProvider', () => {
  const provider = new ServiceKeyProvider('secret-service-key');

  it('fournit X-Service-Key pour la route de confirmation', () => {
    expect(
      provider.confirmationHeaders('/reservations/abc-123/confirm'),
    ).toEqual({
      'X-Service-Key': 'secret-service-key',
    });
  });

  it("tolère l'absence de slash initial", () => {
    expect(
      provider.confirmationHeaders('reservations/abc-123/confirm'),
    ).toEqual({
      'X-Service-Key': 'secret-service-key',
    });
  });

  it("refuse toute route qui n'est pas la confirmation", () => {
    expect(() => provider.confirmationHeaders('/hotels')).toThrow(/interdit/);
    expect(() =>
      provider.confirmationHeaders('/reservations/abc-123/cancel'),
    ).toThrow(/interdit/);
    expect(() => provider.confirmationHeaders('/reservations/abc-123')).toThrow(
      /interdit/,
    );
  });

  it('refuse une clé de service vide (fail-fast)', () => {
    const empty = new ServiceKeyProvider('');
    expect(() =>
      empty.confirmationHeaders('/reservations/abc-123/confirm'),
    ).toThrow(/SERVICE_KEY manquant/);
  });

  it('fusionne la clé de service dans un PmsRequestContext', () => {
    const ctx = provider.confirmationContext('/reservations/abc-123/confirm', {
      correlationId: 'corr-1',
      headers: { 'X-Extra': '1' },
    });

    expect(ctx.correlationId).toBe('corr-1');
    expect(ctx.headers).toEqual({
      'X-Extra': '1',
      'X-Service-Key': 'secret-service-key',
    });
  });
});
