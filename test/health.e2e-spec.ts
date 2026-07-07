import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import nock from 'nock';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { correlationMiddleware } from '../src/common/correlation/correlation.middleware';

const PMS_HOST = 'http://pms.health.local';

/**
 * Intégration `/health` contre un **Redis réel** (conteneur local `redis://127.0.0.1:6379`)
 * et un **PMS mocké** (nock). Redis étant une connexion TCP brute, nock ne l'intercepte pas ;
 * on autorise 127.0.0.1 pour supertest et on mocke la sonde HTTP du PMS.
 */
describe('/health (e2e — Redis réel + PMS mocké)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    process.env.PMS_BASE_URL = `${PMS_HOST}/api/v1`;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(correlationMiddleware);
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
    await app.init();

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1'); // supertest (le serveur HTTP en mémoire)
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(async () => {
    nock.enableNetConnect();
    await app.close();
  });

  it('200 quand Redis et PMS sont up ; en-tête de corrélation présent', async () => {
    nock(PMS_HOST).get('/api/v1').reply(401, {});

    const res = await request(app.getHttpServer()).get('/health');

    const body = res.body as {
      status: string;
      details: Record<string, { status: string }>;
    };
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.details.redis.status).toBe('up');
    expect(body.details.pms.status).toBe('up');
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('/health/live reste 200 même si le PMS est down (liveness locale, anti-deadlock front)', async () => {
    // Aucune interception PMS : /health/live ne sonde ni PMS ni Redis.
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
  });

  it('503 quand le PMS est injoignable (Redis reste up)', async () => {
    nock(PMS_HOST).get('/api/v1').replyWithError('ECONNREFUSED');

    const res = await request(app.getHttpServer()).get('/health');

    const body = res.body as {
      status: string;
      details: Record<string, { status: string }>;
    };
    expect(res.status).toBe(503);
    expect(body.details.pms.status).toBe('down');
    expect(body.details.redis.status).toBe('up');
  });
});
