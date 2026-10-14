import { ServiceKeyProvider } from './service-key.provider';

const ID = '3f2b8c1e-6d4a-4b7e-9a10-5c2d1e0f9a88';

describe('ServiceKeyProvider', () => {
  const provider = new ServiceKeyProvider('secret-service-key');

  it('fournit X-Service-Key pour la route de confirmation', () => {
    expect(provider.confirmationHeaders(`/reservations/${ID}/confirm`)).toEqual(
      {
        'X-Service-Key': 'secret-service-key',
      },
    );
  });

  it("tolère l'absence de slash initial", () => {
    expect(provider.confirmationHeaders(`reservations/${ID}/confirm`)).toEqual({
      'X-Service-Key': 'secret-service-key',
    });
  });

  it('fournit X-Service-Key pour les deux lectures de service (#153, #5 AC-7)', () => {
    expect(provider.serviceHeaders('GET', `/reservations/${ID}`)).toEqual({
      'X-Service-Key': 'secret-service-key',
    });
    expect(
      provider.serviceHeaders('GET', `/reservations/${ID}/payment`),
    ).toEqual({ 'X-Service-Key': 'secret-service-key' });
  });

  it('refuse toute route hors de la liste blanche, méthode comprise', () => {
    expect(() => provider.confirmationHeaders('/hotels')).toThrow(/interdit/);
    expect(() =>
      provider.confirmationHeaders(`/reservations/${ID}/cancel`),
    ).toThrow(/interdit/);
    // La lecture de service n'autorise pas un POST sur le même chemin.
    expect(() => provider.confirmationHeaders(`/reservations/${ID}`)).toThrow(
      /interdit/,
    );
    expect(() =>
      provider.serviceHeaders('GET', `/reservations/${ID}/confirm`),
    ).toThrow(/interdit/);
    expect(() =>
      provider.serviceHeaders('GET', `/roomreservations/${ID}`),
    ).toThrow(/interdit/);
    expect(() => provider.serviceHeaders('GET', `/payments/${ID}`)).toThrow(
      /interdit/,
    );
    expect(() =>
      provider.serviceHeaders('DELETE', `/reservations/${ID}`),
    ).toThrow(/interdit/);
  });

  it("n'expose jamais la clé dans le message d'erreur", () => {
    expect(() => provider.serviceHeaders('GET', '/hotels')).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('secret-service-key') as string,
      }) as Error,
    );
  });

  it('refuse une clé de service vide (fail-fast)', () => {
    const empty = new ServiceKeyProvider('');
    expect(() =>
      empty.confirmationHeaders(`/reservations/${ID}/confirm`),
    ).toThrow(/SERVICE_KEY manquant/);
    expect(() => empty.serviceHeaders('GET', `/reservations/${ID}`)).toThrow(
      /SERVICE_KEY manquant/,
    );
  });

  it('fusionne la clé de service dans un PmsRequestContext', () => {
    const ctx = provider.confirmationContext(`/reservations/${ID}/confirm`, {
      correlationId: 'corr-1',
      headers: { 'X-Extra': '1' },
    });

    expect(ctx.correlationId).toBe('corr-1');
    expect(ctx.headers).toEqual({
      'X-Extra': '1',
      'X-Service-Key': 'secret-service-key',
    });
  });

  it('fusionne la clé de service pour une lecture de service', () => {
    const ctx = provider.serviceContext('GET', `/reservations/${ID}/payment`, {
      correlationId: 'reconcile-1',
    });
    expect(ctx).toEqual({
      correlationId: 'reconcile-1',
      headers: { 'X-Service-Key': 'secret-service-key' },
    });
  });
});
