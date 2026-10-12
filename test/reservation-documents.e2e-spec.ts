import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import nock from 'nock';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { correlationMiddleware } from '../src/common/correlation/correlation.middleware';
import {
  AUTH_OPTIONS,
  type AuthOptions,
  SESSION_KEY_PREFIX,
} from '../src/modules/auth/auth.constants';
import { buildSessionCookie } from '../src/modules/auth/session-cookie';
import { RedisService } from '../src/redis/redis.service';

const PMS_HOST = 'http://pms.documents.local';
const PMS_PREFIX = '/api/v1';

/** PDF minimal et PNG minimal : des octets non-UTF-8 qu'un relais textuel corromprait. */
const PDF = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'latin1'),
  Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x00, 0xff, 0x80]),
]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff,
]);

/** Corps binaire de supertest : sans parseur explicite, il ne rend pas un Buffer. */
const binaryParser = ((
  res: NodeJS.ReadableStream,
  callback: (err: Error | null, body: Buffer) => void,
): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}) as unknown as Parameters<request.Test['parse']>[0];

/**
 * Documents de confirmation (story 3.2, B6 / AC-8) contre un Redis réel et un PMS mocké :
 * octets intacts, en-têtes de cache, `Content-Disposition` reconstruit, 404 relayée en 404.
 */
describe('booking/reservations/:id/confirmation-pdf|qr (e2e)', () => {
  let app: NestExpressApplication;
  let redis: RedisService;
  let options: AuthOptions;
  let reservationId: string;
  let sid: string;
  let cookie: string;
  let serviceKeys: (string | undefined)[];

  const pmsPath = (doc: 'pdf' | 'qr') =>
    `${PMS_PREFIX}/roomreservations/${reservationId}/confirmation-${doc}`;

  function mockReservationCode(code = 'RES-20260901-A1B2C'): void {
    nock(PMS_HOST)
      .get(`${PMS_PREFIX}/roomreservations/${reservationId}`)
      .reply(200, {
        success: true,
        data: { id: reservationId, reservationCode: code },
      });
  }

  function observe(this: nock.ReplyFnContext): void {
    const key: unknown = this.req.headers['x-service-key'];
    serviceKeys.push(
      typeof key === 'string'
        ? key
        : Array.isArray(key)
          ? String(key[0])
          : undefined,
    );
  }

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    process.env.PMS_BASE_URL = `${PMS_HOST}${PMS_PREFIX}`;
    process.env.SERVICE_KEY = 'e2e-service-key-documents';
    process.env.PMS_RETRY_BASE_DELAY_MS = '5';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.use(correlationMiddleware);
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
    await app.init();

    redis = app.get(RedisService);
    options = app.get<AuthOptions>(AUTH_OPTIONS);

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  beforeEach(async () => {
    reservationId = randomUUID();
    serviceKeys = [];
    sid = `e2e-documents-${randomUUID()}`;
    await redis.set(
      SESSION_KEY_PREFIX + sid,
      JSON.stringify({
        userId: randomUUID(),
        email: 'lea@example.com',
        firstName: 'Léa',
        lastName: 'Voyageuse',
        role: 4,
        accessToken: 'access-1',
        accessTokenExpiration: new Date(Date.now() + 3_600_000).toISOString(),
        refreshToken: 'refresh-1',
        refreshTokenExpiration: new Date(
          Date.now() + 7 * 86_400_000,
        ).toISOString(),
      }),
      3600,
    );
    cookie = buildSessionCookie(sid, 3600, {
      cookieName: options.cookieName,
      sessionSecret: options.sessionSecret,
      cookieSecure: options.cookieSecure,
    }).split(';')[0];
  });

  afterEach(async () => {
    nock.cleanAll();
    await redis.del(SESSION_KEY_PREFIX + sid);
  });

  afterAll(async () => {
    nock.enableNetConnect();
    await app.close();
  });

  const getDocument = (doc: 'pdf' | 'qr', id = reservationId) =>
    request(app.getHttpServer())
      .get(`/api/v1/booking/reservations/${id}/confirmation-${doc}`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse(binaryParser);

  it('PDF : octets intacts, nom reconstruit depuis le code, no-store', async () => {
    mockReservationCode();
    nock(PMS_HOST)
      .get(pmsPath('pdf'))
      .reply(function () {
        observe.call(this);
        return [
          200,
          PDF,
          {
            'Content-Type': 'application/pdf',
            // En-tête amont piégé : il ne doit JAMAIS être relayé.
            'Content-Disposition': 'attachment; filename="../../evil.exe"',
          },
        ];
      });

    const response = await getDocument('pdf').expect(200);

    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect((response.body as Buffer).equals(PDF)).toBe(true);
    expect((response.body as Buffer).subarray(0, 4).toString('latin1')).toBe(
      '%PDF',
    );
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="RES-20260901-A1B2C.pdf"',
    );
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.headers.vary).toContain('Cookie');
    // Lecture sous le JWT du voyageur : jamais la clé de service (AC-12).
    expect(serviceKeys).toEqual([undefined]);
  });

  it('QR : PNG intact, sans Content-Disposition', async () => {
    nock(PMS_HOST)
      .get(pmsPath('qr'))
      .reply(function () {
        observe.call(this);
        return [200, PNG, { 'Content-Type': 'image/png' }];
      });

    const response = await getDocument('qr').expect(200);

    expect((response.body as Buffer).equals(PNG)).toBe(true);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(serviceKeys).toEqual([undefined]);
  });

  it('404 du PMS relayée en 404 JSON, jamais en « PDF corrompu »', async () => {
    mockReservationCode();
    nock(PMS_HOST)
      .get(pmsPath('pdf'))
      .reply(
        404,
        { success: false, errors: ['Reservation not found'] },
        { 'Content-Type': 'application/json' },
      );

    const response = await request(app.getHttpServer())
      .get(`/api/v1/booking/reservations/${reservationId}/confirmation-pdf`)
      .set('Cookie', cookie)
      .expect(404);

    expect(response.headers['content-type']).toContain('application/json');
    expect(JSON.stringify(response.body)).not.toContain(
      'Reservation not found',
    );
  });

  it('401 sans cookie, 400 sur un identifiant libre', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/booking/reservations/${reservationId}/confirmation-qr`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/booking/reservations/pas-un-guid/confirmation-qr')
      .set('Cookie', cookie)
      .expect(400);
  });

  it('PMS en panne : 503, jamais des octets vides', async () => {
    nock(PMS_HOST).get(pmsPath('qr')).times(3).reply(500);

    await request(app.getHttpServer())
      .get(`/api/v1/booking/reservations/${reservationId}/confirmation-qr`)
      .set('Cookie', cookie)
      .expect(503);
  });
});
