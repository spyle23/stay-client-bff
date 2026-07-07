import { Test } from '@nestjs/testing';
import nock from 'nock';
import { PmsClientService } from '../src/integration/pms/pms-client.service';
import { PmsUnavailableError } from '../src/integration/pms/pms-errors';
import { PmsModule } from '../src/integration/pms/pms.module';
import { ServiceKeyProvider } from '../src/integration/pms/service-key.provider';

const HOST = 'http://pms.local';
const BASE = `${HOST}/api/v1`;

/**
 * Intégration de la frontière PMS : le vrai `PmsModule` (DI Nest) est monté et pilote un
 * PMS **mocké via nock** sur HTTP réel — retries, dégradation gracieuse et flux de clé de service.
 */
describe('PmsModule (intégration — PMS mocké nock)', () => {
  let client: PmsClientService;
  let serviceKey: ServiceKeyProvider;

  beforeAll(async () => {
    process.env.PMS_BASE_URL = BASE;
    process.env.PMS_MAX_RETRIES = '1';
    process.env.PMS_RETRY_BASE_DELAY_MS = '1';
    process.env.PMS_BREAKER_VOLUME = '50';
    process.env.SERVICE_KEY = 'itest-key';

    const moduleRef = await Test.createTestingModule({
      imports: [PmsModule],
    }).compile();
    client = moduleRef.get(PmsClientService);
    serviceKey = moduleRef.get(ServiceKeyProvider);
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    // Libère les timers internes du circuit breaker (évite un handle ouvert au teardown Jest).
    client.shutdown();
    nock.enableNetConnect();
  });

  it('résout le client et le provider de clé via le module', () => {
    expect(client).toBeInstanceOf(PmsClientService);
    expect(serviceKey).toBeInstanceOf(ServiceKeyProvider);
  });

  it('récupère une liste paginée depuis le PMS mocké', async () => {
    nock(HOST)
      .get('/api/v1/hotels')
      .reply(200, {
        success: true,
        data: [{ id: 'h1' }],
        pagination: {
          page: 1,
          pageSize: 20,
          totalCount: 1,
          totalPages: 1,
          hasPreviousPage: false,
          hasNextPage: false,
        },
      });

    const res = await client.getList<{ id: string }>('/hotels');

    expect(res.data[0]?.id).toBe('h1');
    expect(res.pagination.totalCount).toBe(1);
  });

  it('récupère après un 503 transitoire (retry)', async () => {
    nock(HOST)
      .get('/api/v1/hotels/h1')
      .reply(503, {})
      .get('/api/v1/hotels/h1')
      .reply(200, { success: true, data: { id: 'h1' } });

    const res = await client.get<{ id: string }>('/hotels/h1');
    expect(res.data.id).toBe('h1');
  });

  it('remonte PmsUnavailableError sur panne durable', async () => {
    nock(HOST).get('/api/v1/hotels').times(2).replyWithError('ECONNREFUSED');
    await expect(client.getList('/hotels')).rejects.toBeInstanceOf(
      PmsUnavailableError,
    );
  });

  it('confirme une réservation avec X-Service-Key sur la route /confirm', async () => {
    nock(HOST, { reqheaders: { 'x-service-key': 'itest-key' } })
      .post('/api/v1/reservations/r1/confirm')
      .reply(200, { success: true, data: { status: 'Confirmed' } });

    const ctx = serviceKey.confirmationContext('/reservations/r1/confirm');
    const res = await client.post<{ status: string }>(
      '/reservations/r1/confirm',
      {},
      ctx,
    );

    expect(res.data.status).toBe('Confirmed');
    expect(nock.isDone()).toBe(true);
  });
});
