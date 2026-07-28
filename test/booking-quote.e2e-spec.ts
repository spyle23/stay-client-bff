import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import nock from 'nock';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { correlationMiddleware } from '../src/common/correlation/correlation.middleware';

const PMS_HOST = 'http://pms.booking.local';
const AVAILABLE = 1; // RoomStatus.Available

/** Date-only UTC `AAAA-MM-JJ` décalée de `days` jours. */
function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function hotelBody(hotel: Record<string, unknown>) {
  return { success: true, data: hotel, message: null, errors: null };
}
function roomListBody(rooms: Record<string, unknown>[]) {
  return {
    success: true,
    data: rooms,
    pagination: {
      page: 1,
      pageSize: 100,
      totalCount: rooms.length,
      totalPages: 1,
      hasPreviousPage: false,
      hasNextPage: false,
    },
    message: null,
    errors: null,
  };
}
function imagesBody(images: Record<string, unknown>[]) {
  return { success: true, data: images, message: null, errors: null };
}

interface QuoteBody {
  success: boolean;
  data: {
    hotelId: string;
    hotelName: string | null;
    hotelLogoUrl: string | null;
    roomId: string;
    roomCategory: string | null;
    roomImageUrl: string | null;
    checkInDate: string;
    checkOutDate: string;
    nights: number;
    guests: number;
    currency: string;
    pricePerNight: number;
    roomTotal: number;
    taxAmount: number | null;
    taxState: string;
    total: number;
    available: boolean;
    availabilityDegraded: boolean;
    cancellationPolicy: {
      source: string;
      refundable: boolean | null;
      freeUntil: string | null;
      terms: string | null;
    };
    quotedAt: string;
  };
}

/**
 * Intégration `GET /api/v1/booking/quote` contre un **Redis réel** (127.0.0.1:6379) et un
 * **PMS mocké** (nock). Prouve : devis nominal (total dérivé, politique en repli, taxe non
 * chiffrée), validation stricte de la query (dates requises/ordonnées/non passées, voyageurs
 * bornés, GUID, garde whitelist), 404 chambre introuvable, dégradation gracieuse de la
 * disponibilité datée, et **route publique** (aucun cookie requis).
 *
 * Chaque test utilise des **GUID uniques** : le Redis étant réel, un id partagé ferait fuiter le
 * cache `catalog` d'un test à l'autre.
 */
describe('/api/v1/booking/quote (e2e — Redis réel + PMS mocké)', () => {
  let app: INestApplication<App>;
  const checkIn = isoDatePlus(30);
  const checkOut = isoDatePlus(32); // 2 nuits

  /** Mocke la composition PMS complète d'une fiche chambre disponible. */
  function mockRoom(
    hotelId: string,
    roomId: string,
    options: {
      price?: number;
      currency?: string;
      availableFails?: boolean;
      inAvailableSet?: boolean;
    } = {},
  ): void {
    const {
      price = 84,
      currency = 'EUR',
      availableFails = false,
      inAvailableSet = true,
    } = options;

    nock(PMS_HOST)
      .get(`/api/v1/Hotels/${hotelId}`)
      .reply(
        200,
        hotelBody({
          id: hotelId,
          name: 'Hôtel Colline',
          city: 'Antananarivo',
          logoUrl: 'https://pms/img/logo.png',
          currency,
        }),
      );
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${hotelId}`)
      .query(true)
      .reply(
        200,
        roomListBody([
          {
            id: roomId,
            number: '204',
            category: 'Double Confort',
            price,
            capacity: 2,
            status: AVAILABLE,
          },
        ]),
      );
    const availableScope = nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${hotelId}/available`)
      .query(true);
    if (availableFails) {
      availableScope.reply(500, { success: false, message: 'boom' });
    } else {
      availableScope.reply(
        200,
        roomListBody(
          inAvailableSet
            ? [{ id: roomId, price, capacity: 2, status: AVAILABLE }]
            : [],
        ),
      );
    }
    nock(PMS_HOST)
      .get(`/api/v1/Files/rooms/${roomId}/images`)
      .reply(
        200,
        imagesBody([
          { url: 'https://img/room-b.png', displayOrder: 2 },
          { url: 'https://img/room-a.png', isPrimary: true },
        ]),
      );
  }

  function quoteQuery(hotelId: string, roomId: string) {
    return {
      hotelId,
      roomId,
      checkInDate: checkIn,
      checkOutDate: checkOut,
      guests: 2,
    };
  }

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    process.env.PMS_BASE_URL = `${PMS_HOST}/api/v1`;
    process.env.PMS_MAX_RETRIES = '1';
    process.env.PMS_RETRY_BASE_DELAY_MS = '1';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(correlationMiddleware);
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
    await app.init();

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(async () => {
    nock.enableNetConnect();
    await app.close();
  });

  it('200 : devis complet — total dérivé, taxe non chiffrée, politique en repli, sans session', async () => {
    const hotelId = randomUUID();
    const roomId = randomUUID();
    mockRoom(hotelId, roomId);

    const res = await request(app.getHttpServer())
      .get('/api/v1/booking/quote')
      .query(quoteQuery(hotelId, roomId));

    const body = res.body as QuoteBody;
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.hotelId).toBe(hotelId);
    expect(body.data.hotelName).toBe('Hôtel Colline');
    // AC-1 : le logo de l'Hôtel traverse le contrat jusqu'au front (revue 2.2).
    expect(body.data.hotelLogoUrl).toBe('https://pms/img/logo.png');
    expect(body.data.roomId).toBe(roomId);
    expect(body.data.roomCategory).toBe('Double Confort');
    // Image principale d'abord (tri déjà appliqué par `catalog`).
    expect(body.data.roomImageUrl).toBe('https://img/room-a.png');
    expect(body.data.nights).toBe(2);
    expect(body.data.guests).toBe(2);
    expect(body.data.currency).toBe('EUR');
    expect(body.data.pricePerNight).toBe(8400);
    expect(body.data.roomTotal).toBe(16800);
    expect(body.data.total).toBe(16800);
    expect(body.data.taxAmount).toBeNull();
    expect(body.data.taxState).toBe('included_undetailed');
    expect(body.data.available).toBe(true);
    expect(body.data.availabilityDegraded).toBe(false);
    expect(body.data.cancellationPolicy).toEqual({
      source: 'fallback',
      refundable: null,
      freeUntil: null,
      terms: null,
    });
    expect(Date.parse(body.data.quotedAt)).not.toBeNaN();
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('200 : chambre absente du set disponible → available=false (parcours non bloqué)', async () => {
    const hotelId = randomUUID();
    const roomId = randomUUID();
    mockRoom(hotelId, roomId, { inAvailableSet: false });

    const res = await request(app.getHttpServer())
      .get('/api/v1/booking/quote')
      .query(quoteQuery(hotelId, roomId));

    expect(res.status).toBe(200);
    expect((res.body as QuoteBody).data.available).toBe(false);
    expect((res.body as QuoteBody).data.availabilityDegraded).toBe(false);
  });

  it('200 : panne du cross-check daté → availabilityDegraded, jamais « indisponible »', async () => {
    const hotelId = randomUUID();
    const roomId = randomUUID();
    mockRoom(hotelId, roomId, { availableFails: true });

    const res = await request(app.getHttpServer())
      .get('/api/v1/booking/quote')
      .query(quoteQuery(hotelId, roomId));

    const body = res.body as QuoteBody;
    expect(res.status).toBe(200);
    expect(body.data.availabilityDegraded).toBe(true);
    expect(body.data.available).toBe(true);
  });

  it('404 : chambre absente de l’hôtel', async () => {
    const hotelId = randomUUID();
    const roomId = randomUUID();
    nock(PMS_HOST)
      .get(`/api/v1/Hotels/${hotelId}`)
      .reply(200, hotelBody({ id: hotelId, currency: 'EUR' }));
    nock(PMS_HOST)
      .get(`/api/v1/Rooms/hotel/${hotelId}`)
      .query(true)
      .reply(200, roomListBody([]));

    const res = await request(app.getHttpServer())
      .get('/api/v1/booking/quote')
      .query(quoteQuery(hotelId, roomId));

    expect(res.status).toBe(404);
    expect((res.body as { success: boolean }).success).toBe(false);
  });

  it('503 : PMS injoignable sur le détail hôtel (dégradation gracieuse, jamais un devis inventé)', async () => {
    const hotelId = randomUUID();
    const roomId = randomUUID();
    nock(PMS_HOST)
      .get(`/api/v1/Hotels/${hotelId}`)
      .times(3)
      .reply(500, { success: false, message: 'boom' });

    const res = await request(app.getHttpServer())
      .get('/api/v1/booking/quote')
      .query(quoteQuery(hotelId, roomId));

    expect(res.status).toBe(503);
  });

  describe('validation de la query (aucun appel PMS ne doit partir)', () => {
    /** Interception « attrape-tout » : elle ne doit JAMAIS être consommée sur une query invalide. */
    function catchAllPms() {
      return nock(PMS_HOST)
        .get(/.*/)
        .reply(200, hotelBody({ id: 'x', currency: 'EUR' }));
    }

    it('400 : dates absentes (un devis sans dates n’a pas de sens)', async () => {
      const scope = catchAllPms();
      const res = await request(app.getHttpServer())
        .get('/api/v1/booking/quote')
        .query({ hotelId: randomUUID(), roomId: randomUUID(), guests: 2 });

      expect(res.status).toBe(400);
      expect(scope.isDone()).toBe(false);
    });

    it('400 : date d’arrivée dans le passé', async () => {
      const scope = catchAllPms();
      const res = await request(app.getHttpServer())
        .get('/api/v1/booking/quote')
        .query({
          hotelId: randomUUID(),
          roomId: randomUUID(),
          checkInDate: isoDatePlus(-3),
          checkOutDate: isoDatePlus(2),
          guests: 2,
        });

      expect(res.status).toBe(400);
      expect(scope.isDone()).toBe(false);
    });

    it('400 : départ antérieur ou égal à l’arrivée', async () => {
      const scope = catchAllPms();
      const res = await request(app.getHttpServer())
        .get('/api/v1/booking/quote')
        .query({
          hotelId: randomUUID(),
          roomId: randomUUID(),
          checkInDate: checkIn,
          checkOutDate: checkIn,
          guests: 2,
        });

      expect(res.status).toBe(400);
      expect(scope.isDone()).toBe(false);
    });

    it('400 : voyageurs hors bornes', async () => {
      const scope = catchAllPms();
      const res = await request(app.getHttpServer())
        .get('/api/v1/booking/quote')
        .query({
          ...quoteQuery(randomUUID(), randomUUID()),
          guests: 99,
        });

      expect(res.status).toBe(400);
      expect(scope.isDone()).toBe(false);
    });

    /**
     * Sécurité : les ids sont interpolés dans les chemins PMS — un id non-GUID doit être rejeté
     * AVANT tout appel (même raisonnement que le `ParseUUIDPipe` de `catalog`).
     */
    it('400 : hotelId non-GUID rejeté sans appel PMS', async () => {
      const scope = catchAllPms();
      const res = await request(app.getHttpServer())
        .get('/api/v1/booking/quote')
        .query({
          ...quoteQuery(randomUUID(), randomUUID()),
          hotelId: '../Reservations',
        });

      expect(res.status).toBe(400);
      expect(scope.isDone()).toBe(false);
    });

    it('400 : paramètre non déclaré au DTO (garde whitelist — bug Phase 3 de 1.7)', async () => {
      const scope = catchAllPms();
      const res = await request(app.getHttpServer())
        .get('/api/v1/booking/quote')
        .query({
          ...quoteQuery(randomUUID(), randomUUID()),
          currency: 'EUR',
        });

      expect(res.status).toBe(400);
      expect(scope.isDone()).toBe(false);
    });

    /**
     * Revue 2.2 : la durée de séjour est une règle de query, connue avant toute I/O. Elle était
     * vérifiée APRÈS la composition — trois appels PMS partaient (et le résultat était mis en
     * cache) pour un contexte que l'on savait refusé.
     */
    it('400 : séjour au-delà de la borne du module, rejeté sans appel PMS', async () => {
      const scope = catchAllPms();
      const res = await request(app.getHttpServer())
        .get('/api/v1/booking/quote')
        .query({
          ...quoteQuery(randomUUID(), randomUUID()),
          checkInDate: isoDatePlus(30),
          checkOutDate: isoDatePlus(200), // 170 nuits > 90
        });

      expect(res.status).toBe(400);
      expect(scope.isDone()).toBe(false);
    });
  });

  /**
   * Revue 2.2 : les autres scénarios tournent tous en EUR, alors que le PMS peut porter la devise
   * propre de l'Hôtel. Ce test exerce réellement `toMinorUnits`/`minorUnitExponent` de bout en
   * bout sur une devise à **0 décimale** — le cas où un ×100 fautif serait invisible en EUR.
   */
  it('200 : devise de l’Hôtel à 0 décimale (MGA) — jamais de ×100 fantôme', async () => {
    const hotelId = randomUUID();
    const roomId = randomUUID();
    mockRoom(hotelId, roomId, { price: 250_000, currency: 'MGA' });

    const res = await request(app.getHttpServer())
      .get('/api/v1/booking/quote')
      .query(quoteQuery(hotelId, roomId));

    const body = res.body as QuoteBody;
    expect(res.status).toBe(200);
    expect(body.data.currency).toBe('MGA');
    // 250 000 MGA = 250 000 unités mineures (et non 25 000 000).
    expect(body.data.pricePerNight).toBe(250_000);
    expect(body.data.roomTotal).toBe(500_000);
    expect(body.data.total).toBe(500_000);
  });
});
