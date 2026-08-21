import { randomUUID } from 'node:crypto';
import { ConsoleLogger, type LoggerService } from '@nestjs/common';
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
import {
  HOLD_INDEX_KEY,
  HOLD_KEY_PREFIX,
} from '../src/modules/booking/checkout-hold.service';
import { RedisService } from '../src/redis/redis.service';

const PMS_HOST = 'http://pms.booking.local';
const PMS_PREFIX = '/api/v1';

/**
 * Seuils **de la suite** (posés en `beforeAll`). `THROTTLE_IDENTITY_LIMIT` vaut 2, mais
 * `POST /booking/reservations` double ce seuil en le plafonnant à l'IP (`RESERVATION_THROTTLE`,
 * pour absorber les rejeux idempotents d'AC-5) : sur cette route, identité = IP = 4.
 */
const IP_LIMIT = 4;
const RESERVATION_IDENTITY_LIMIT = 4;
/** `POST /auth/guest` garde le seuil nu — aucun rejeu gratuit à absorber. */
const GUEST_IDENTITY_LIMIT = 2;

/** Date-only UTC décalée de `days` jours. */
function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Adresse cliente **forgée**, unique par frappe.
 *
 * Le Redis des compteurs est réel et **partagé** par les 12 suites e2e (`jest-e2e.json` ne fixe
 * pas `maxWorkers`) : sans adresse propre, toutes les frappes de toutes les suites tomberaient
 * dans le seau `127.0.0.1` et les seuils dépendraient de l'ordonnancement. Lisible parce que la
 * suite active `trust proxy` — voir `beforeAll`.
 */
function forgedIp(): string {
  const octet = () => Math.floor(Math.random() * 256);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** Corps de réponse du BFF, typé pour éviter les accès membres sur `any` (règle ESLint). */
interface ReservationEnvelope {
  success: boolean;
  message?: string;
  data: {
    reservationId: string;
    reservationCode: string;
    status: string;
    currency: string;
    total: number;
    nights: number;
    created: boolean;
    holdExpiresAt: string | null;
    /** Story 2.5 — relues du PMS / mémorisées par le BFF. */
    specialRequests: string | null;
    communicationLocale: string | null;
    communicationLocaleState: string;
  };
}

interface ErrorEnvelope {
  success: boolean;
  message: string;
  errors?: Record<string, string[]>;
}

const CHECK_IN = isoDatePlus(30);
const CHECK_OUT = isoDatePlus(32);

/**
 * Création de la Réservation `Pending` (story 2.4 — FR-9 / FR-14 / NFR-7) contre un **Redis réel**
 * (`redis://127.0.0.1:6379`) et un **PMS mocké** (nock).
 *
 * Ce qui n'est prouvable qu'ici, et pas en test unitaire :
 * - le **corps réellement envoyé** au PMS (dates ancrées UTC, `paymentMethod: 4`) ;
 * - l'**idempotence** réelle via Redis : une double soumission ne produit qu'un seul `POST` PMS ;
 * - le **verrou de séjour** partagé, qui sérialise deux créations concurrentes ;
 * - la **limitation de débit** telle que la voit le navigateur (429 dans l'enveloppe standard),
 *   compteurs Redis et **script Lua d'incrément** exercés par un vrai Redis ;
 * - l'absence totale de texte PMS dans les réponses d'erreur **et dans les logs** ;
 * - le refus des routes sans cookie de session.
 *
 * ⚠️ **Isolation : namespace par test, jamais de purge par motif.** Cette suite purgeait
 * `throttle:*`, `booking:*` et `catalog:*` après chaque test sur un Redis **partagé**, ce qui
 * effaçait au passage les clés des suites sœurs exécutées en parallèle (`room-detail.e2e-spec.ts`
 * perdait son cache en plein test « un 2ᵉ appel identique ne resollicite pas le PMS » ≈ une
 * exécution sur deux). Chaque test tire donc désormais ses propres identifiants — hôtel, chambre,
 * réservation, compte, adresse IP, email invité — si bien qu'aucun état ne peut transiter d'un
 * test (ou d'une exécution) à l'autre. Seules les clés que la suite a elle-même créées et qui
 * survivraient longtemps (session, enregistrement de hold) sont retirées explicitement.
 */
describe('booking/reservations (e2e — Redis réel + PMS mocké)', () => {
  let app: NestExpressApplication;
  let redis: RedisService;
  let options: AuthOptions;

  // Identifiants propres à CHAQUE test (voir l'encadré d'isolation ci-dessus).
  let hotelId: string;
  let roomId: string;
  let reservationId: string;
  let userId: string;
  let clientIp: string;
  let guestEmail: string;
  let cookie: string;
  let sid: string;
  /** Sessions ouvertes par le test courant, retirées de Redis en `afterEach`. */
  let openedSids: string[] = [];

  const createPath = () =>
    `${PMS_PREFIX}/roomreservations/hotels/${hotelId}/reservations`;
  const reservationPath = () =>
    `${PMS_PREFIX}/roomreservations/${reservationId}`;

  const reservationBody = (overrides: Record<string, unknown> = {}) => ({
    success: true,
    data: {
      id: reservationId,
      reservationCode: 'RES-20260901-A1B2C',
      hotelId,
      hotelName: 'Hôtel Colline',
      roomId,
      roomNumber: '204',
      roomCategory: 'Double Confort',
      customerId: userId,
      customerName: 'Léa Voyageuse',
      customerEmail: 'lea@example.com',
      checkInDate: `${CHECK_IN}T00:00:00Z`,
      checkOutDate: `${CHECK_OUT}T00:00:00Z`,
      numberOfGuests: 2,
      numberOfNights: 2,
      pricePerNight: 84,
      totalPrice: 168,
      status: 1,
      ...overrides,
    },
  });

  /**
   * Réponses PMS du pré-contrôle `catalog` (hôtel + chambres + dispo + images).
   *
   * ⚠️ Lectures armées **plusieurs fois** : le nombre exact d'appels dépend de ce que le cache
   * `catalog` sert déjà (détail chambre, devise de l'hôtel…) — un détail d'implémentation que ces
   * tests n'ont pas à figer. Une interception non consommée reste simplement en attente ; c'est
   * l'**écriture** (`POST`) que les tests comptent explicitement.
   */
  function mockPrecheck(overrides: { price?: number; capacity?: number } = {}) {
    const price = overrides.price ?? 84;
    const capacity = overrides.capacity ?? 2;
    const room = {
      id: roomId,
      hotelId,
      number: '204',
      category: 'Double Confort',
      capacity,
      price,
      status: 1,
    };
    nock(PMS_HOST)
      .get(`${PMS_PREFIX}/Hotels/${hotelId}`)
      .times(3)
      .reply(200, { success: true, data: { id: hotelId, currency: 'EUR' } })
      .get(`${PMS_PREFIX}/Rooms/hotel/${hotelId}`)
      .query(true)
      .times(3)
      .reply(200, { success: true, data: [room], pagination: {} })
      .get(`${PMS_PREFIX}/Rooms/hotel/${hotelId}/available`)
      .query(true)
      .times(3)
      .reply(200, { success: true, data: [room], pagination: {} })
      .get(`${PMS_PREFIX}/Files/rooms/${roomId}/images`)
      .times(3)
      .reply(200, { success: true, data: [] });
  }

  /** Corps de création valide, aligné sur le pré-contrôle ci-dessus (2 nuits × 84 € = 168 €). */
  const createBody = (overrides: Record<string, unknown> = {}) => ({
    hotelId,
    roomId,
    checkInDate: CHECK_IN,
    checkOutDate: CHECK_OUT,
    guests: 2,
    expectedTotal: 16_800,
    expectedCurrency: 'EUR',
    ...overrides,
  });

  /** Session réelle en Redis : `withCustomerAuth` proxifiera ce jeton vers le PMS mocké. */
  async function openSession(accountId: string): Promise<string> {
    const newSid = `e2e-booking-${randomUUID()}`;
    await redis.set(
      SESSION_KEY_PREFIX + newSid,
      JSON.stringify({
        userId: accountId,
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
    openedSids.push(newSid);
    return buildSessionCookie(newSid, 3600, {
      cookieName: options.cookieName,
      sessionSecret: options.sessionSecret,
      cookieSecure: options.cookieSecure,
    }).split(';')[0];
  }

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    process.env.PMS_BASE_URL = `${PMS_HOST}${PMS_PREFIX}`;
    // Limites basses : le 429 doit être atteignable en quelques requêtes.
    process.env.THROTTLE_IP_LIMIT = String(IP_LIMIT);
    process.env.THROTTLE_IDENTITY_LIMIT = String(GUEST_IDENTITY_LIMIT);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    // `trust proxy` (comme `main.ts` derrière un reverse-proxy) : les frappes peuvent alors
    // déclarer leur adresse, ce qui rend le compteur par IP réellement testable — et donne à
    // chaque test son propre seau dans le Redis partagé.
    app.set('trust proxy', true);
    app.use(correlationMiddleware);
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
    await app.init();

    redis = app.get(RedisService);
    options = app.get<AuthOptions>(AUTH_OPTIONS);

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  beforeEach(async () => {
    hotelId = randomUUID();
    roomId = randomUUID();
    reservationId = randomUUID();
    userId = randomUUID();
    clientIp = forgedIp();
    guestEmail = `quota-${randomUUID()}@example.com`;
    openedSids = [];
    cookie = await openSession(userId);
    sid = openedSids[0];
  });

  afterEach(async () => {
    nock.cleanAll();
    // Purge **ciblée** : uniquement les clés que ce test a créées et dont la durée de vie dépasse
    // largement la suite (session : 1 h ; enregistrement de hold : hold + sursis ≈ 75 min). Tout
    // le reste (compteurs, idempotence, cache catalog) est déjà cloisonné par des identifiants
    // uniques et expire seul — un `KEYS throttle:*`/`catalog:*` casserait les suites voisines.
    for (const openedSid of openedSids) {
      await redis.del(SESSION_KEY_PREFIX + openedSid);
    }
    await redis.del(HOLD_KEY_PREFIX + reservationId);
    await redis.raw.zrem(HOLD_INDEX_KEY, reservationId);
  });

  afterAll(async () => {
    nock.enableNetConnect();
    await app.close();
  });

  const postAs = (
    sessionCookie: string,
    ip: string,
    body: Record<string, unknown>,
  ) =>
    request(app.getHttpServer())
      .post('/api/v1/booking/reservations')
      .set('Cookie', sessionCookie)
      .set('X-Forwarded-For', ip)
      .send(body);

  const post = (body: Record<string, unknown>) =>
    postAs(cookie, clientIp, body);

  describe('création (AC-1, AC-14)', () => {
    it('201 : réservation Pending créée, code et hold renvoyés', async () => {
      mockPrecheck();
      nock(PMS_HOST).post(createPath()).reply(201, reservationBody());

      const res = await post(createBody()).expect(201);
      const body = res.body as ReservationEnvelope;

      expect(body).toMatchObject({
        success: true,
        data: {
          reservationId,
          reservationCode: 'RES-20260901-A1B2C',
          status: 'Pending',
          currency: 'EUR',
          total: 16_800,
          nights: 2,
          created: true,
        },
      });
      expect(Date.parse(body.data.holdExpiresAt ?? '')).not.toBeNaN();
    });

    it('envoie au PMS des dates ancrées UTC et le mode de paiement Stripe', async () => {
      mockPrecheck();
      let sent: Record<string, unknown> = {};
      nock(PMS_HOST)
        .post(createPath(), (body: Record<string, unknown>) => {
          sent = body;
          return true;
        })
        .reply(201, reservationBody());

      await post(createBody()).expect(201);

      // Une date-only produirait `Kind=Unspecified` côté Npgsql (colonne timestamptz) → 500.
      expect(sent.checkInDate).toBe(`${CHECK_IN}T00:00:00Z`);
      expect(sent.checkOutDate).toBe(`${CHECK_OUT}T00:00:00Z`);
      expect(sent.paymentMethod).toBe(4);
      expect(sent).not.toHaveProperty('specialRequests');
    });

    it('propage X-Correlation-ID et pose une Idempotency-Key sur l’écriture', async () => {
      mockPrecheck();
      let headers: Record<string, string> = {};
      nock(PMS_HOST)
        .post(createPath())
        .reply(function () {
          headers = this.req.headers;
          return [201, reservationBody()];
        });

      await post(createBody()).expect(201);

      expect(headers['x-correlation-id']).toBeDefined();
      expect(headers['idempotency-key']).toBeDefined();
      // AR-8 : la clé de service ne doit jamais quitter la route /confirm.
      expect(headers['x-service-key']).toBeUndefined();
    });

    it('n’expose aucune PII du client dans la réponse', async () => {
      mockPrecheck();
      nock(PMS_HOST).post(createPath()).reply(201, reservationBody());

      const res = await post(createBody()).expect(201);

      expect(JSON.stringify(res.body)).not.toContain('lea@example.com');
      expect(JSON.stringify(res.body)).not.toContain('Léa Voyageuse');
    });

    it('interdit la mise en cache de la réponse', async () => {
      mockPrecheck();
      nock(PMS_HOST).post(createPath()).reply(201, reservationBody());

      const res = await post(createBody()).expect(201);

      expect(res.headers['cache-control']).toBe('no-store, private');
      expect(res.headers.vary).toContain('Cookie');
    });
  });

  describe('idempotence (AC-5)', () => {
    it('un rejeu du même séjour renvoie 200 et n’émet AUCUN second POST PMS', async () => {
      mockPrecheck();
      const creation = nock(PMS_HOST)
        .post(createPath())
        .reply(201, reservationBody());

      await post(createBody()).expect(201);

      // Relecture de la réservation mémorisée (GET) + résolution de la devise de l'hôtel
      // (`RoomReservationDto` n'en porte aucune), mais AUCUNE création supplémentaire.
      nock(PMS_HOST)
        .get(reservationPath())
        .reply(200, reservationBody())
        .get(`${PMS_PREFIX}/Hotels/${hotelId}`)
        .reply(200, { success: true, data: { id: hotelId, currency: 'EUR' } });
      const replay = await post(createBody()).expect(200);
      const body = replay.body as ReservationEnvelope;

      expect(body.data.reservationId).toBe(reservationId);
      expect(body.data.created).toBe(false);
      expect(creation.isDone()).toBe(true);
      // Un second POST aurait échoué faute d'interception : nock n'en a plus en attente.
      expect(
        nock.pendingMocks().filter((m) => m.includes('POST')),
      ).toHaveLength(0);
    });

    it('deux soumissions concurrentes ne créent qu’une seule réservation', async () => {
      mockPrecheck();
      mockPrecheck(); // le second appel peut refaire le pré-contrôle
      let creations = 0;
      nock(PMS_HOST)
        .post(createPath())
        .times(2)
        .reply(() => {
          creations++;
          return [201, reservationBody()];
        });
      nock(PMS_HOST)
        .get(reservationPath())
        .times(2)
        .reply(200, reservationBody())
        .get(`${PMS_PREFIX}/Hotels/${hotelId}`)
        .times(2)
        .reply(200, { success: true, data: { id: hotelId, currency: 'EUR' } });

      const [a, b] = await Promise.all([
        post(createBody()),
        post(createBody()),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(creations).toBe(1);
    });
  });

  describe('échecs métier typés (AC-3)', () => {
    it('409 `room-unavailable` sans laisser fuiter le texte du PMS', async () => {
      mockPrecheck();
      nock(PMS_HOST)
        .post(createPath())
        .reply(400, {
          success: false,
          data: null,
          message: null,
          errors: ['Room is not available for the selected dates'],
        });

      const res = await post(createBody()).expect(409);

      expect((res.body as ErrorEnvelope).errors?.reason).toEqual([
        'room-unavailable',
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/Room is not available/i);
    });

    it('409 `over-capacity` détecté au pré-contrôle, sans écrire', async () => {
      mockPrecheck({ capacity: 1 });

      const res = await post(createBody({ guests: 2 })).expect(409);

      expect((res.body as ErrorEnvelope).errors?.reason).toEqual([
        'over-capacity',
      ]);
      expect(
        nock.pendingMocks().filter((m) => m.includes('POST')),
      ).toHaveLength(0);
    });

    it('409 `price-changed` : la réservation créée est annulée en compensation', async () => {
      mockPrecheck();
      nock(PMS_HOST)
        .post(createPath())
        .reply(201, reservationBody({ totalPrice: 170 }));
      const cancel = nock(PMS_HOST)
        .post(`${reservationPath()}/cancel`)
        .reply(200, { success: true });

      const res = await post(createBody()).expect(409);
      const errors = (res.body as ErrorEnvelope).errors;

      expect(errors?.reason).toEqual(['price-changed']);
      expect(errors?.total).toEqual(['17000']);
      expect(cancel.isDone()).toBe(true);
    });

    it('503 sur panne PMS (jamais un faux « chambre indisponible »)', async () => {
      mockPrecheck();
      nock(PMS_HOST).post(createPath()).times(3).reply(500, {});

      const res = await post(createBody()).expect(503);
      expect((res.body as ErrorEnvelope).errors?.reason).toBeUndefined();
    });

    it('400 sur un champ non déclaré au DTO (forbidNonWhitelisted)', async () => {
      // ⚠️ `specialRequests` était l'exemple ici jusqu'à la story 2.5 : il est désormais DÉCLARÉ.
      // L'exemple doit rester un champ que le DTO ne connaît pas, sinon ce test ne prouve plus rien.
      await post(createBody({ notes: 'note interne' })).expect(400);
    });
  });

  /**
   * Story 2.5 (FR-10) — demandes spéciales & langue de communication.
   *
   * C'est ici, et seulement ici, que le `ValidationPipe` global s'exécute réellement (les specs
   * unitaires appellent le service directement). Les bornes du DTO ne sont donc prouvées qu'à ce
   * niveau — et elles comptent : `Stay-api` n'a aucun validateur pour ce corps, et sa colonne
   * `varchar(2000)` transformerait un dépassement en 500.
   */
  describe('demandes spéciales & langue (story 2.5)', () => {
    it('transmet les demandes spéciales normalisées au PMS et les relit dans la réponse', async () => {
      mockPrecheck();
      const creation = nock(PMS_HOST)
        .post(createPath(), (body: Record<string, unknown>) => {
          expect(body.specialRequests).toBe('Arrivée tardive\nChambre calme');
          return true;
        })
        .reply(
          201,
          reservationBody({
            specialRequests: 'Arrivée tardive\nChambre calme',
          }),
        );

      const res = await post(
        createBody({
          // CRLF + espaces de bord + caractère de contrôle : tout doit être normalisé AVANT l'envoi.
          specialRequests: '  Arrivée tardive\r\nChambre calme  ',
        }),
      ).expect(201);

      expect((res.body as ReservationEnvelope).data.specialRequests).toBe(
        'Arrivée tardive\nChambre calme',
      );
      creation.done();
    });

    it('omet la clé quand la saisie est vide (aucune demande « vide » persistée)', async () => {
      mockPrecheck();
      const creation = nock(PMS_HOST)
        .post(createPath(), (body: Record<string, unknown>) => {
          expect(body).not.toHaveProperty('specialRequests');
          return true;
        })
        .reply(201, reservationBody());

      await post(createBody({ specialRequests: '   ' })).expect(201);
      creation.done();
    });

    it('400 au-delà de la borne — refus propre, jamais un 500 Npgsql', async () => {
      const res = await post(
        createBody({ specialRequests: 'a'.repeat(1001) }),
      ).expect(400);
      expect((res.body as ErrorEnvelope).errors?.specialRequests).toBeDefined();
    });

    it('accepte exactement la borne', async () => {
      mockPrecheck();
      nock(PMS_HOST).post(createPath()).reply(201, reservationBody());
      await post(createBody({ specialRequests: 'a'.repeat(1000) })).expect(201);
    });

    it('mesure la borne APRÈS normalisation (les blancs de bord ne font pas refuser)', async () => {
      mockPrecheck();
      nock(PMS_HOST).post(createPath()).reply(201, reservationBody());
      await post(
        createBody({ specialRequests: `   ${'a'.repeat(1000)}   ` }),
      ).expect(201);
    });

    it('400 sur une langue hors liste, sans aucun appel PMS', async () => {
      // Aucun mock n'est posé et `nock.disableNetConnect()` est actif : le moindre appel PMS
      // ferait échouer la requête au lieu de renvoyer 400. C'est CELA qui prouve l'absence d'appel.
      const res = await post(createBody({ communicationLocale: 'de' })).expect(
        400,
      );
      expect(
        (res.body as ErrorEnvelope).errors?.communicationLocale,
      ).toBeDefined();
    });

    it('400 sur une locale complète ou une casse différente (comparaison ordinale du PMS)', async () => {
      await post(createBody({ communicationLocale: 'fr-FR' })).expect(400);
      await post(createBody({ communicationLocale: 'FR' })).expect(400);
    });

    it("n'envoie JAMAIS la langue au PMS et annonce le repli (dépendance D10)", async () => {
      mockPrecheck();
      const creation = nock(PMS_HOST)
        .post(createPath(), (body: Record<string, unknown>) => {
          expect(body).not.toHaveProperty('communicationLocale');
          expect(body).not.toHaveProperty('language');
          return true;
        })
        .reply(201, reservationBody());

      const res = await post(createBody({ communicationLocale: 'en' })).expect(
        201,
      );
      const data = (res.body as ReservationEnvelope).data;

      expect(data.communicationLocale).toBe('en');
      expect(data.communicationLocaleState).toBe('hotel_default_fallback');
      creation.done();
    });

    it('la langue survit à la relecture du tunnel (mémorisée sur le hold)', async () => {
      mockPrecheck();
      nock(PMS_HOST).post(createPath()).reply(201, reservationBody());
      await post(createBody({ communicationLocale: 'en' })).expect(201);

      nock(PMS_HOST)
        .get(`/api/v1/roomreservations/${reservationId}`)
        .reply(200, reservationBody());
      nock(PMS_HOST)
        .get(`/api/v1/hotels/${hotelId}`)
        .reply(200, { success: true, data: { id: hotelId, currency: 'EUR' } });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/booking/reservations/${reservationId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect((res.body as ReservationEnvelope).data.communicationLocale).toBe(
        'en',
      );
    });

    it('un rejeu divergent renvoie le texte d’origine sans second POST PMS', async () => {
      mockPrecheck();
      const creation = nock(PMS_HOST)
        .post(createPath())
        .reply(201, reservationBody({ specialRequests: 'Texte d’origine' }));
      await post(createBody({ specialRequests: 'Texte d’origine' })).expect(
        201,
      );
      creation.done();

      nock(PMS_HOST)
        .get(`/api/v1/roomreservations/${reservationId}`)
        .reply(200, reservationBody({ specialRequests: 'Texte d’origine' }));
      nock(PMS_HOST)
        .get(`/api/v1/hotels/${hotelId}`)
        .reply(200, { success: true, data: { id: hotelId, currency: 'EUR' } });

      // Aucun second POST n'est mocké : s'il partait, `nock` ferait échouer la requête.
      const res = await post(
        createBody({ specialRequests: 'Texte corrigé' }),
      ).expect(200);

      const data = (res.body as ReservationEnvelope).data;
      expect(data.created).toBe(false);
      expect(data.specialRequests).toBe('Texte d’origine');
    });
  });

  describe('relecture (AC-9)', () => {
    it('200 : la réservation est relue avec son échéance de hold', async () => {
      mockPrecheck();
      nock(PMS_HOST).post(createPath()).reply(201, reservationBody());
      await post(createBody()).expect(201);

      nock(PMS_HOST)
        .get(`${PMS_PREFIX}/Hotels/${hotelId}`)
        .reply(200, { success: true, data: { id: hotelId, currency: 'EUR' } })
        .get(reservationPath())
        .reply(200, reservationBody());

      const res = await request(app.getHttpServer())
        .get(`/api/v1/booking/reservations/${reservationId}`)
        .set('Cookie', cookie)
        .expect(200);

      const body = res.body as ReservationEnvelope;
      expect(body.data).toMatchObject({
        reservationId,
        status: 'Pending',
        created: false,
      });
      expect(body.data.holdExpiresAt).not.toBeNull();
    });

    it('404 sans relayer le texte du PMS quand elle appartient à un autre compte', async () => {
      nock(PMS_HOST)
        .get(reservationPath())
        .reply(403, {
          success: false,
          message: null,
          errors: ['Access denied'],
        });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/booking/reservations/${reservationId}`)
        .set('Cookie', cookie)
        .expect(404);

      expect(JSON.stringify(res.body)).not.toMatch(/Access denied/i);
    });

    it('400 sur un identifiant qui n’est pas un GUID (aucun appel PMS)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/booking/reservations/pas-un-guid')
        .set('Cookie', cookie)
        .expect(400);
      expect(nock.pendingMocks()).toHaveLength(0);
    });
  });

  describe('garde de session (Décision 1)', () => {
    it('401 sans cookie sur la création', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/booking/reservations')
        .send(createBody())
        .expect(401);
    });

    it('401 sans cookie sur la relecture', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/booking/reservations/${reservationId}`)
        .expect(401);
    });

    it('le devis reste public (aucune régression de la story 2.2)', async () => {
      mockPrecheck();
      await request(app.getHttpServer())
        .get('/api/v1/booking/quote')
        .query({
          hotelId,
          roomId,
          checkInDate: CHECK_IN,
          checkOutDate: CHECK_OUT,
          guests: 2,
        })
        .expect(200);
    });
  });

  describe('limitation de débit (AC-8, NFR-7)', () => {
    /** Arme une tentative que le PMS refuse : ni écriture durable, ni mémoire d'idempotence. */
    function armRejectedCreation(onCall?: () => void) {
      mockPrecheck();
      nock(PMS_HOST)
        .post(createPath())
        .reply(() => {
          onCall?.();
          return [
            400,
            { success: false, message: null, errors: ['Room not found'] },
          ];
        });
    }

    it('429 dans l’enveloppe standard, motif machine `rate-limited`, sans créer de réservation', async () => {
      let creations = 0;
      for (let i = 0; i < IP_LIMIT; i++) {
        armRejectedCreation(() => creations++);
        await post(createBody());
      }

      const res = await post(createBody()).expect(429);

      const body = res.body as ErrorEnvelope;
      expect(body.success).toBe(false);
      expect(typeof body.message).toBe('string');
      // Message français du BFF, jamais le libellé technique anglais du paquet.
      expect(body.message).not.toMatch(/ThrottlerException/);
      // AC-8 : motif MACHINE, pour que le front n'ait pas à analyser du texte affichable.
      expect(body.errors?.reason).toEqual(['rate-limited']);
      // La frappe refusée n'a jamais atteint le PMS.
      expect(creations).toBe(IP_LIMIT);
    });

    /**
     * Le compteur d'**identité** existe pour un motif précis : un botnet qui ferait tourner un
     * même compte derrière des dizaines d'adresses. On le prouve en changeant d'adresse à chaque
     * frappe — le compteur par IP reste alors à 1, et seul celui du compte peut déclencher.
     */
    it('429 par COMPTE malgré la rotation d’adresses', async () => {
      for (let i = 0; i < RESERVATION_IDENTITY_LIMIT; i++) {
        armRejectedCreation();
        await postAs(cookie, forgedIp(), createBody());
      }

      const res = await postAs(cookie, forgedIp(), createBody()).expect(429);

      expect(res.headers['retry-after-identity']).toBeDefined();
      expect(res.headers['retry-after-ip']).toBeUndefined();
      expect((res.body as ErrorEnvelope).errors?.reason).toEqual([
        'rate-limited',
      ]);
    });

    /**
     * ⚠️ Symétrique du test précédent, et seul à exercer le **traceur d'adresse** : avec deux
     * comptes distincts derrière la même IP, le compteur d'identité de chacun reste sous son
     * seuil — seule l'adresse est saturée. Sans ce cas, `THROTTLE_IDENTITY_LIMIT` étant le plus
     * bas, le compteur par IP n'était jamais atteint par aucun test.
     */
    it('429 par IP : deux comptes distincts derrière la même adresse', async () => {
      const otherCookie = await openSession(randomUUID());
      const sharedIp = forgedIp();

      for (const account of [cookie, cookie, otherCookie, otherCookie]) {
        armRejectedCreation();
        await postAs(account, sharedIp, createBody());
      }

      // 5ᵉ frappe : ce compte n'en a fait que 2 (seuil d'identité = 4), mais l'adresse est pleine.
      const res = await postAs(otherCookie, sharedIp, createBody()).expect(429);

      expect(res.headers['retry-after-ip']).toBeDefined();
      expect((res.body as ErrorEnvelope).errors?.reason).toEqual([
        'rate-limited',
      ]);
    });

    it('POST /auth/guest rejoint la même politique (seuil nu, sans facteur de rejeu)', async () => {
      const guest = {
        email: guestEmail,
        firstName: 'Quota',
        lastName: 'Test',
        phone: '+261 34 00 000 00',
      };
      nock(PMS_HOST)
        .post(`${PMS_PREFIX}/auth/register/customer`)
        .times(GUEST_IDENTITY_LIMIT)
        .reply(400, {
          success: false,
          message: null,
          errors: ['Email is already registered.'],
        });

      const submit = () =>
        request(app.getHttpServer())
          .post('/api/v1/auth/guest')
          .set('X-Forwarded-For', clientIp)
          .send(guest);

      for (let i = 0; i < GUEST_IDENTITY_LIMIT; i++) {
        await submit();
      }

      const res = await submit().expect(429);
      expect((res.body as ErrorEnvelope).errors?.reason).toEqual([
        'rate-limited',
      ]);
    });

    it('le sous-adressage ne rouvre pas un quota (alice+1@… = alice@…)', async () => {
      const [local, domain] = guestEmail.split('@');
      const guest = {
        firstName: 'Quota',
        lastName: 'Test',
        phone: '+261 34 00 000 00',
      };
      nock(PMS_HOST)
        .post(`${PMS_PREFIX}/auth/register/customer`)
        .times(GUEST_IDENTITY_LIMIT)
        .reply(400, {
          success: false,
          message: null,
          errors: ['Email is already registered.'],
        });

      const submit = (email: string) =>
        request(app.getHttpServer())
          .post('/api/v1/auth/guest')
          .set('X-Forwarded-For', clientIp)
          .send({ ...guest, email });

      // Le quota est consommé par l'adresse nue…
      for (let i = 0; i < GUEST_IDENTITY_LIMIT; i++) {
        await submit(guestEmail);
      }
      // …et une variante sous-adressée, qui atteint la MÊME boîte, n'en rouvre pas un second.
      await submit(`${local}+relance@${domain}`).expect(429);
    });
  });

  /**
   * Cas critique n° 9 de la story : « aucun jeton ni texte PMS dans les corps de réponse **ni les
   * logs** ». Les corps sont couverts plus haut ; les logs ne l'étaient par aucun test — or c'est
   * là qu'un message d'erreur interpolé fait fuiter, en clair et durablement, ce que la réponse
   * HTTP protège.
   */
  describe('journalisation (cas critique n° 9)', () => {
    it('ne journalise ni jeton de session, ni email, ni texte du PMS', async () => {
      const captured: string[] = [];
      const record = (args: unknown[]) => {
        captured.push(args.map(readable).join(' '));
      };
      const capturing: LoggerService = {
        log: (...args: unknown[]) => record(args),
        error: (...args: unknown[]) => record(args),
        warn: (...args: unknown[]) => record(args),
        debug: (...args: unknown[]) => record(args),
        verbose: (...args: unknown[]) => record(args),
      };

      app.useLogger(capturing);
      try {
        // 1) Refus métier du PMS (4xx) : son texte ne doit ni sortir, ni être journalisé.
        mockPrecheck();
        nock(PMS_HOST)
          .post(createPath())
          .reply(400, {
            success: false,
            message: null,
            errors: ['Room is not available for the selected dates'],
          });
        await post(createBody()).expect(409);

        // 2) Panne PMS (5xx) : SEUL chemin où le filtre global journalise le détail. Le corps du
        //    PMS y porte volontairement un email et un texte technique.
        mockPrecheck();
        nock(PMS_HOST).post(createPath()).times(3).reply(500, {
          success: false,
          message: 'Room 204 is locked by customer lea@example.com',
        });
        await post(createBody()).expect(503);
      } finally {
        app.useLogger(new ConsoleLogger());
      }

      // Sans cette garde, un journal vide ferait passer le test sans rien prouver.
      expect(captured.length).toBeGreaterThan(0);
      const journal = captured.join('\n');
      expect(journal).not.toContain('access-1');
      expect(journal).not.toContain('refresh-1');
      expect(journal).not.toContain(sid);
      expect(journal).not.toContain('lea@example.com');
      expect(journal).not.toMatch(/Room is not available/i);
      expect(journal).not.toMatch(/locked by customer/i);
    });
  });
});

/** Représentation textuelle d'un argument de log, sans jamais lever sur un objet exotique. */
function readable(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return `${value.message} ${value.stack ?? ''}`;
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[argument non sérialisable]';
  }
}
