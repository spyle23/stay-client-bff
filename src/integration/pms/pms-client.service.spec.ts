import nock from 'nock';
import { PmsClientService, type PmsClientOptions } from './pms-client.service';
import { PmsRequestError, PmsUnavailableError } from './pms-errors';

const HOST = 'http://pms.test';
const BASE = `${HOST}/api/v1`;

function makeOptions(
  overrides: Partial<PmsClientOptions> = {},
): PmsClientOptions {
  return {
    baseUrl: BASE,
    timeoutMs: 500,
    maxRetries: 2,
    retryBaseDelayMs: 1, // délais négligeables en test
    breaker: {
      errorThresholdPercentage: 50,
      resetTimeoutMs: 100,
      volumeThreshold: 20, // par défaut : ne pas ouvrir le circuit dans les tests fonctionnels
    },
    ...overrides,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe('PmsClientService', () => {
  // Les breakers opossum portent des timers internes : on les arrête après chaque test
  // (évite les handles ouverts Jest et la fuite d'état entre tests).
  const services: PmsClientService[] = [];
  const createService = (
    overrides: Partial<PmsClientOptions> = {},
  ): PmsClientService => {
    const svc = new PmsClientService(makeOptions(overrides));
    services.push(svc);
    return svc;
  };

  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    services.forEach((s) => s.shutdown());
    services.length = 0;
    nock.cleanAll();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  describe('enveloppe préservée', () => {
    it("get() renvoie l'enveloppe ApiResponse intacte", async () => {
      const svc = createService();
      const payload = {
        id: 'h1',
        name: 'Hôtel Test',
        priceFrom: 12000,
        currency: 'EUR',
      };
      nock(HOST)
        .get('/api/v1/hotels/h1')
        .reply(200, { success: true, data: payload });

      const res = await svc.get<typeof payload>('/hotels/h1');

      expect(res.success).toBe(true);
      expect(res.data).toEqual(payload);
      expect(nock.isDone()).toBe(true);
    });

    it("getList() préserve la pagination à l'identique", async () => {
      const svc = createService();
      const pagination = {
        page: 2,
        pageSize: 10,
        totalCount: 42,
        totalPages: 5,
        hasPreviousPage: true,
        hasNextPage: true,
      };
      nock(HOST)
        .get('/api/v1/hotels')
        .reply(200, { success: true, data: [{ id: 'h1' }], pagination });

      const res = await svc.getList<{ id: string }>('/hotels');

      expect(res.pagination).toEqual(pagination);
      expect(res.data).toHaveLength(1);
    });

    it('204/corps vide → enveloppe neutre (success, data undefined)', async () => {
      const svc = createService();
      nock(HOST).delete('/api/v1/reservations/r1').reply(204);

      const res = await svc.delete('/reservations/r1');

      expect(res.success).toBe(true);
      expect(res.data).toBeUndefined();
    });
  });

  describe('résilience', () => {
    it('retry backoff : 503 puis succès', async () => {
      const svc = createService();
      nock(HOST)
        .get('/api/v1/hotels')
        .reply(503, {})
        .get('/api/v1/hotels')
        .reply(200, { success: true, data: [] });

      const res = await svc.getList('/hotels');

      expect(res.data).toEqual([]);
      expect(nock.isDone()).toBe(true); // les deux interceptions consommées
    });

    it('4xx métier : PmsRequestError, sans retry', async () => {
      const svc = createService();
      // Une seule interception : si le client retryait, nock lèverait une erreur de connexion.
      nock(HOST)
        .post('/api/v1/reservations')
        .reply(400, {
          success: false,
          message: 'Dates invalides',
          errors: { checkOutDate: ["doit être postérieure à l'arrivée"] },
        });

      await expect(
        svc.post('/reservations', { hotelId: 'h1' }),
      ).rejects.toBeInstanceOf(PmsRequestError);
      expect(nock.isDone()).toBe(true);
    });

    it('dégradation gracieuse : erreur réseau épuisée → PmsUnavailableError', async () => {
      const svc = createService();
      nock(HOST).get('/api/v1/hotels').times(3).replyWithError('ECONNRESET');

      await expect(svc.getList('/hotels')).rejects.toBeInstanceOf(
        PmsUnavailableError,
      );
      expect(nock.isDone()).toBe(true); // 1 essai + 2 retries
    });

    // Écritures non idempotentes (story 2.3) : rejouer `register/customer` après une réponse
    // perdue transforme un succès en « email déjà pris » — un compte créé que personne ne peut
    // plus ouvrir. L'appelant doit pouvoir désactiver le retry pour ces routes-là.
    it('maxRetries: 0 → un seul appel HTTP sur 5xx, puis PmsUnavailableError', async () => {
      const svc = createService();
      // Deux interceptions armées : si le client retryait, la seconde serait consommée.
      const scope = nock(HOST)
        .post('/api/v1/auth/register/customer')
        .reply(503, {})
        .post('/api/v1/auth/register/customer')
        .reply(201, { success: true, data: { userId: 'u1' } });

      await expect(
        svc.post(
          '/auth/register/customer',
          { email: 'a@b.c' },
          {
            maxRetries: 0,
          },
        ),
      ).rejects.toBeInstanceOf(PmsUnavailableError);
      expect(scope.pendingMocks()).toHaveLength(1); // la 2ᵉ n'a jamais été appelée
    });

    it('maxRetries: 0 → un seul appel HTTP sur erreur réseau', async () => {
      const svc = createService();
      // `pendingMocks()` dédoublonne les interceptions identiques : il ne peut pas prouver un
      // nombre d'appels. On compte les requêtes réellement émises.
      let calls = 0;
      const scope = nock(HOST)
        .post('/api/v1/auth/register/customer')
        .times(3)
        .replyWithError('ECONNRESET');
      scope.on('request', () => {
        calls += 1;
      });

      await expect(
        svc.post('/auth/register/customer', {}, { maxRetries: 0 }),
      ).rejects.toBeInstanceOf(PmsUnavailableError);
      expect(calls).toBe(1); // aucun retry malgré 3 interceptions armées
    });

    it('sans override, le comportement de retry par défaut est inchangé', async () => {
      const svc = createService();
      nock(HOST)
        .post('/api/v1/reservations')
        .reply(503, {})
        .post('/api/v1/reservations')
        .reply(200, { success: true, data: { id: 'r1' } });

      const res = await svc.post<{ id: string }>('/reservations', {});

      expect(res.data).toEqual({ id: 'r1' });
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('idempotence des écritures', () => {
    it('pose une Idempotency-Key stable, réutilisée à chaque retry', async () => {
      const svc = createService();
      const keys: string[] = [];
      const capture = (v: string): boolean => {
        keys.push(v);
        return true;
      };
      nock(HOST)
        .post('/api/v1/reservations')
        .matchHeader('idempotency-key', capture)
        .reply(503, {})
        .post('/api/v1/reservations')
        .matchHeader('idempotency-key', capture)
        .reply(201, { success: true, data: { id: 'r1' } });

      await svc.post('/reservations', { hotelId: 'h1' });

      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[0]).toMatch(/.+/);
    });

    it("respecte une Idempotency-Key explicite fournie par l'appelant", async () => {
      const svc = createService();
      nock(HOST)
        .post('/api/v1/reservations')
        .matchHeader('idempotency-key', 'clef-fixe-123')
        .reply(201, { success: true, data: { id: 'r1' } });

      await svc.post(
        '/reservations',
        { hotelId: 'h1' },
        { idempotencyKey: 'clef-fixe-123' },
      );

      expect(nock.isDone()).toBe(true);
    });

    it("n'ajoute pas d'Idempotency-Key sur les lectures (GET)", async () => {
      const svc = createService();
      nock(HOST, { badheaders: ['idempotency-key'] })
        .get('/api/v1/hotels')
        .reply(200, { success: true, data: [] });

      await svc.getList('/hotels');

      expect(nock.isDone()).toBe(true);
    });
  });

  describe("frontière d'en-têtes", () => {
    it('proxifie le Bearer Customer et propage X-Correlation-ID', async () => {
      const svc = createService();
      nock(HOST, {
        reqheaders: {
          authorization: 'Bearer customer-jwt',
          'x-correlation-id': 'corr-42',
        },
      })
        .get('/api/v1/account/reservations')
        .reply(200, { success: true, data: [] });

      await svc.getList('/account/reservations', {
        bearerToken: 'customer-jwt',
        correlationId: 'corr-42',
      });

      expect(nock.isDone()).toBe(true);
    });

    it('refuse un X-Service-Key hors de la route /confirm (aucun HTTP émis)', async () => {
      const svc = createService();
      await expect(
        svc.post('/hotels', {}, { headers: { 'X-Service-Key': 'k' } }),
      ).rejects.toThrow(/X-Service-Key/);
    });

    it('autorise X-Service-Key sur /reservations/{id}/confirm', async () => {
      const svc = createService();
      nock(HOST, { reqheaders: { 'x-service-key': 'k' } })
        .post('/api/v1/reservations/r1/confirm')
        .reply(200, { success: true, data: { status: 'Confirmed' } });

      const res = await svc.post<{ status: string }>(
        '/reservations/r1/confirm',
        {},
        { headers: { 'X-Service-Key': 'k' } },
      );

      expect(res.data.status).toBe('Confirmed');
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('circuit breaker', () => {
    it("s'ouvre après des échecs répétés puis échoue vite (fail-fast)", async () => {
      const svc = createService({
        maxRetries: 0,
        breaker: {
          errorThresholdPercentage: 1,
          resetTimeoutMs: 1000,
          volumeThreshold: 1,
        },
      });
      nock(HOST).get('/api/v1/ping').replyWithError('down');

      await expect(svc.get('/ping')).rejects.toBeInstanceOf(
        PmsUnavailableError,
      );
      expect(svc.circuitOpen).toBe(true);

      // Circuit ouvert → rejet immédiat sans HTTP (aucune interception nock définie ici).
      await expect(svc.get('/ping')).rejects.toBeInstanceOf(
        PmsUnavailableError,
      );
    });

    it('passe en half-open puis se referme après un succès', async () => {
      const svc = createService({
        maxRetries: 0,
        breaker: {
          errorThresholdPercentage: 1,
          resetTimeoutMs: 80,
          volumeThreshold: 1,
        },
      });
      nock(HOST).get('/api/v1/ping').replyWithError('down');
      await expect(svc.get('/ping')).rejects.toBeInstanceOf(
        PmsUnavailableError,
      );
      expect(svc.circuitOpen).toBe(true);

      await sleep(160); // marge large au-delà du resetTimeout → half-open autorisé
      nock(HOST)
        .get('/api/v1/ping')
        .reply(200, { success: true, data: 'pong' });

      const res = await svc.get<string>('/ping');
      expect(res.data).toBe('pong');
      expect(svc.circuitOpen).toBe(false);
    });
  });
});
