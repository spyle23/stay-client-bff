import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import nock from 'nock';
import { PmsHealthIndicator } from './pms.health';

const HOST = 'http://pms.health.test';

describe('PmsHealthIndicator', () => {
  let indicator: PmsHealthIndicator;

  beforeAll(() => {
    process.env.PMS_BASE_URL = `${HOST}/api/v1`;
    nock.disableNetConnect();
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      providers: [PmsHealthIndicator],
    }).compile();
    indicator = moduleRef.get(PmsHealthIndicator);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  it('up quand le PMS répond (même 401 — exerce validateStatus via axios réel)', async () => {
    nock(HOST).get('/api/v1').reply(401, {});
    const res = await indicator.isHealthy('pms');
    expect(res.pms.status).toBe('up');
    expect(nock.isDone()).toBe(true);
  });

  it('down sur erreur réseau / timeout', async () => {
    nock(HOST).get('/api/v1').replyWithError('ETIMEDOUT');
    const res = await indicator.isHealthy('pms');
    expect(res.pms.status).toBe('down');
  });
});
