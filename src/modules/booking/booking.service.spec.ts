import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestSession } from '../../common/decorators/current-session.decorator';
import type { PmsClientService } from '../../integration/pms/pms-client.service';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import type { SessionService } from '../auth/session.service';
import type { CatalogService } from '../catalog/catalog.service';
import type { RoomDetailDto } from '../catalog/dto/room-detail.dto';
import { BOOKING_REASON_KEY } from './booking-errors';
import type { BookingOptions } from './booking.constants';
import { BookingService } from './booking.service';
import type { CheckoutHoldService } from './checkout-hold.service';
import type { BookingQuoteQueryDto } from './dto/booking-quote.query.dto';
import type { CreateReservationRequestDto } from './dto/create-reservation.request.dto';

const HOTEL_ID = '11111111-1111-1111-1111-111111111111';
const ROOM_ID = '22222222-2222-2222-2222-222222222222';

/** Date-only UTC décalée de `days` jours. */
function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const query: BookingQuoteQueryDto = {
  hotelId: HOTEL_ID,
  roomId: ROOM_ID,
  checkInDate: isoDatePlus(30),
  checkOutDate: isoDatePlus(32), // 2 nuits
  guests: 2,
};

function roomDetail(overrides: Partial<RoomDetailDto> = {}): RoomDetailDto {
  return {
    id: ROOM_ID,
    hotelId: HOTEL_ID,
    hotelName: 'Hôtel Colline',
    hotelCity: 'Antananarivo',
    hotelLogoUrl: 'https://pms/img/logo.png',
    number: '204',
    category: 'Double Confort',
    capacity: 2,
    amenities: 'wifi,clim',
    floor: 2,
    description: 'Chambre lumineuse',
    includedServices: [],
    images: [
      { url: 'https://pms/img/a.jpg' },
      { url: 'https://pms/img/b.jpg' },
    ],
    pricePerNight: 8400,
    totalPrice: 16800,
    currency: 'EUR',
    nights: 2,
    available: true,
    availabilityDegraded: false,
    ...overrides,
  };
}

const RESERVATION_ID = '44444444-4444-4444-4444-444444444444';
const SESSION: RequestSession = {
  sid: 'sid-1',
  user: {
    userId: '55555555-5555-5555-5555-555555555555',
    email: 'lea@example.com',
    firstName: 'Léa',
    lastName: 'Rakoto',
  },
};

const createBody: CreateReservationRequestDto = {
  hotelId: HOTEL_ID,
  roomId: ROOM_ID,
  checkInDate: query.checkInDate,
  checkOutDate: query.checkOutDate,
  guests: 2,
  expectedTotal: 16_800,
  expectedCurrency: 'EUR',
};

/** Réponse `RoomReservationDto` du PMS (montants **décimaux**, aucune devise — vérifié). */
function pmsReservation(overrides: Record<string, unknown> = {}) {
  return {
    id: RESERVATION_ID,
    reservationCode: 'RES-20260901-A1B2C',
    hotelId: HOTEL_ID,
    hotelName: 'Hôtel Colline',
    roomId: ROOM_ID,
    roomNumber: '204',
    roomCategory: 'Double Confort',
    customerId: SESSION.user.userId,
    customerName: 'Léa Rakoto',
    customerEmail: 'lea@example.com',
    checkInDate: `${query.checkInDate}T00:00:00Z`,
    checkOutDate: `${query.checkOutDate}T00:00:00Z`,
    numberOfGuests: 2,
    numberOfNights: 2,
    pricePerNight: 84,
    totalPrice: 168,
    status: 1,
    ...overrides,
  };
}

const baseOptions: BookingOptions = {
  maxStayNights: 90,
  holdTtlSeconds: 900,
  holdRecordGraceSeconds: 3600,
  stayLockTtlMs: 90_000,
  lockWaitTimeoutMs: 200,
  lockPollIntervalMs: 20,
  sweeperIntervalMs: 60_000,
  sweeperBatchSize: 50,
  sweeperMaxAttempts: 5,
  sweeperRetryDelayMs: 60_000,
  sweeperEnabled: false,
  pmsCallBudgetMs: 24_750,
  intentReconcileDelayMs: 90_000,
  communicationLocaleTtlSeconds: 172_800,
};

/** Doubles injectés — un par dépendance réelle, sans conteneur Nest. */
function makeDeps() {
  return {
    getRoomDetail: jest.fn().mockResolvedValue(roomDetail()),
    getHotelCurrency: jest.fn().mockResolvedValue('EUR'),
    post: jest
      .fn()
      .mockResolvedValue({ success: true, data: pmsReservation() }),
    get: jest.fn().mockResolvedValue({ success: true, data: pmsReservation() }),
    readIdempotent: jest.fn().mockResolvedValue(null),
    writeIdempotent: jest.fn().mockResolvedValue(undefined),
    clearIdempotent: jest.fn().mockResolvedValue(undefined),
    acquireStayLock: jest.fn().mockResolvedValue('lock-token'),
    releaseStayLock: jest.fn().mockResolvedValue(undefined),
    register: jest.fn().mockResolvedValue(undefined),
    registerIntent: jest.fn().mockResolvedValue(undefined),
    promoteIntent: jest.fn().mockResolvedValue(undefined),
    dropIntent: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    read: jest.fn().mockResolvedValue(null),
    writeCommunicationLocale: jest.fn().mockResolvedValue(undefined),
    readCommunicationLocale: jest.fn().mockResolvedValue(null),
  };
}

function buildService(
  deps: ReturnType<typeof makeDeps>,
  options: BookingOptions = baseOptions,
): BookingService {
  return new BookingService(
    {
      getRoomDetail: deps.getRoomDetail,
      getHotelCurrency: deps.getHotelCurrency,
    } as unknown as CatalogService,
    { post: deps.post, get: deps.get } as unknown as PmsClientService,
    {
      // `withCustomerAuth` est la SEULE porte d'appel PMS authentifié : le double le reproduit
      // fidèlement (il fournit un jeton et exécute l'opération), sans jamais l'exposer ailleurs.
      withCustomerAuth: (
        _sid: string,
        fn: (token: string) => Promise<unknown>,
      ) => fn('jeton-customer'),
    } as unknown as SessionService,
    {
      readIdempotent: deps.readIdempotent,
      writeIdempotent: deps.writeIdempotent,
      clearIdempotent: deps.clearIdempotent,
      acquireStayLock: deps.acquireStayLock,
      releaseStayLock: deps.releaseStayLock,
      register: deps.register,
      registerIntent: deps.registerIntent,
      promoteIntent: deps.promoteIntent,
      dropIntent: deps.dropIntent,
      release: deps.release,
      read: deps.read,
      writeCommunicationLocale: deps.writeCommunicationLocale,
      readCommunicationLocale: deps.readCommunicationLocale,
    } as unknown as CheckoutHoldService,
    { getCorrelationId: () => 'corr-1' },
    options,
  );
}

/** Lecture **typée** d'un appel `pms.post` — évite un accès membre sur `any`. */
function postCall(
  deps: ReturnType<typeof makeDeps>,
  index: number,
): { path: string; body: Record<string, unknown>; context: unknown } {
  const call = deps.post.mock.calls[index] as unknown as [
    string,
    Record<string, unknown>,
    unknown,
  ];
  return { path: call[0], body: call[1], context: call[2] };
}

/** Identifiant d'intention réellement enregistré avant l'appel de création. */
function registeredIntentId(deps: ReturnType<typeof makeDeps>): string {
  const call = deps.registerIntent.mock.calls[0] as unknown as [
    { intentId: string },
  ];
  return call[0].intentId;
}

/** Corps d'erreur (`message` + `errors`) porté par une exception de `booking-errors`. */
function bodyOf(error: unknown): {
  message: string;
  errors?: Record<string, string[]>;
} {
  return (
    error as {
      getResponse: () => { message: string; errors?: Record<string, string[]> };
    }
  ).getResponse();
}

/** Lit le motif machine (`errors.reason`) porté par une exception de `booking-errors`. */
function reasonOf(error: unknown): string | undefined {
  const body = (error as { getResponse?: () => unknown }).getResponse?.() as
    { errors?: Record<string, string[]> } | undefined;
  return body?.errors?.[BOOKING_REASON_KEY]?.[0];
}

describe('BookingService', () => {
  let getRoomDetail: jest.Mock;
  let service: BookingService;
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
    getRoomDetail = deps.getRoomDetail;
    service = buildService(deps);
  });

  it('délègue à CatalogService avec le contexte de séjour (aucune composition PMS parallèle)', async () => {
    await service.getQuote(query);
    expect(getRoomDetail).toHaveBeenCalledTimes(1);
    expect(getRoomDetail).toHaveBeenCalledWith(HOTEL_ID, ROOM_ID, {
      checkInDate: query.checkInDate,
      checkOutDate: query.checkOutDate,
      guests: 2,
    });
  });

  it('compose un devis complet : hôtel, chambre, séjour, ventilation et total', async () => {
    const quote = await service.getQuote(query);

    expect(quote.hotelId).toBe(HOTEL_ID);
    expect(quote.hotelName).toBe('Hôtel Colline');
    // AC-1 : le logo de l'Hôtel est transporté, plus figé à `null` (revue 2.2).
    expect(quote.hotelLogoUrl).toBe('https://pms/img/logo.png');
    expect(quote.hotelCity).toBe('Antananarivo');
    expect(quote.roomId).toBe(ROOM_ID);
    expect(quote.roomCategory).toBe('Double Confort');
    expect(quote.roomNumber).toBe('204');
    expect(quote.roomCapacity).toBe(2);
    // Photo principale = la première (catalog trie déjà primaire d'abord).
    expect(quote.roomImageUrl).toBe('https://pms/img/a.jpg');
    expect(quote.checkInDate).toBe(query.checkInDate);
    expect(quote.checkOutDate).toBe(query.checkOutDate);
    expect(quote.nights).toBe(2);
    expect(quote.guests).toBe(2);
    expect(quote.currency).toBe('EUR');
    expect(quote.pricePerNight).toBe(8400);
    expect(quote.roomTotal).toBe(16800);
    expect(quote.total).toBe(16800);
    expect(Number.isInteger(quote.total)).toBe(true);
    expect(quote.available).toBe(true);
    expect(quote.availabilityDegraded).toBe(false);
    expect(Date.parse(quote.quotedAt)).not.toBeNaN();
  });

  /**
   * ⚠️ Portée réelle de ce test : `CatalogService` étant mocké, `toMinorUnits`/`minorUnitExponent`
   * ne s'exécutent PAS ici — il prouve que le devis **transporte** la devise de l'Hôtel et ses
   * unités mineures sans les réinterpréter (pas de ×100 rajouté, pas de repli sur EUR), et que la
   * multiplication par les nuits reste entière quel que soit l'exposant. L'application effective
   * de l'exposant est couverte par `minor-units.spec.ts` et par l'e2e `booking-quote` en devise à
   * 0 décimale (revue 2.2).
   */
  it('transporte la devise de l’Hôtel et ses unités mineures sans les réinterpréter (MGA, 0 décimale)', async () => {
    getRoomDetail.mockResolvedValue(
      roomDetail({
        currency: 'MGA',
        pricePerNight: 250_000,
        totalPrice: 500_000,
      }),
    );
    const quote = await service.getQuote(query);
    expect(quote.currency).toBe('MGA');
    expect(quote.pricePerNight).toBe(250_000);
    expect(quote.total).toBe(500_000);
    expect(Number.isInteger(quote.total)).toBe(true);
  });

  it('recalcule le total depuis prix/nuit × nuits (formule unique, cohérence au centime)', async () => {
    getRoomDetail.mockResolvedValue(
      roomDetail({ pricePerNight: 9999, totalPrice: 19_998, nights: 2 }),
    );
    const quote = await service.getQuote(query);
    expect(quote.roomTotal).toBe(9999 * 2);
  });

  it('n’invente jamais de taxe tant que D7 n’est pas livré', async () => {
    const quote = await service.getQuote(query);
    expect(quote.taxAmount).toBeNull();
    expect(quote.taxState).toBe('included_undetailed');
    // Le total ne contient aucun poste fantôme : total = sous-total chambre.
    expect(quote.total).toBe(quote.roomTotal);
  });

  it('rend un repli de politique d’annulation sans aucune valeur fabriquée (D2 non livré)', async () => {
    const quote = await service.getQuote(query);
    expect(quote.cancellationPolicy).toEqual({
      source: 'fallback',
      refundable: null,
      freeUntil: null,
      terms: null,
    });
  });

  it('propage la disponibilité dégradée (jamais présentée comme « indisponible »)', async () => {
    getRoomDetail.mockResolvedValue(
      roomDetail({ available: true, availabilityDegraded: true }),
    );
    const quote = await service.getQuote(query);
    expect(quote.availabilityDegraded).toBe(true);
    expect(quote.available).toBe(true);
  });

  it('propage une chambre devenue indisponible pour ces dates', async () => {
    getRoomDetail.mockResolvedValue(roomDetail({ available: false }));
    const quote = await service.getQuote(query);
    expect(quote.available).toBe(false);
  });

  it('refuse un devis quand catalog a écarté le contexte de dates (400, jamais un total null)', async () => {
    getRoomDetail.mockResolvedValue(
      roomDetail({ nights: null, totalPrice: null }),
    );
    await expect(service.getQuote(query)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * Revue 2.2 : la borne est une **règle de query**, connue avant toute I/O. La vérifier après la
   * composition ferait partir trois appels PMS — et mettre le résultat en cache — pour un contexte
   * que l'on savait refusé dès sa lecture. Le rejet doit donc précéder `getRoomDetail`.
   */
  it('refuse un séjour au-delà de la borne du module SANS appeler le PMS', async () => {
    service = buildService(deps, { ...baseOptions, maxStayNights: 1 });
    await expect(service.getQuote(query)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(getRoomDetail).not.toHaveBeenCalled();
  });

  it('accepte un séjour exactement sur la borne (pas d’off-by-one)', async () => {
    service = buildService(deps, { ...baseOptions, maxStayNights: 2 });
    getRoomDetail.mockResolvedValue(roomDetail({ nights: 2 }));
    await expect(service.getQuote(query)).resolves.toMatchObject({ nights: 2 });
    expect(getRoomDetail).toHaveBeenCalledTimes(1);
  });

  /**
   * Filet conservé : si `catalog` écartait silencieusement un contexte que la borne du module
   * accepte (règle plus stricte de son côté), le devis doit encore refuser plutôt que rendre un
   * total `null`.
   */
  it('refuse encore si catalog écarte un séjour que la borne du module acceptait', async () => {
    getRoomDetail.mockResolvedValue(
      roomDetail({ nights: null, totalPrice: null }),
    );
    await expect(service.getQuote(query)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(getRoomDetail).toHaveBeenCalledTimes(1);
  });

  it('propage un 404 PMS (chambre/hôtel introuvable)', async () => {
    getRoomDetail.mockRejectedValue(
      new PmsRequestError('Chambre introuvable.', 404),
    );
    await expect(service.getQuote(query)).rejects.toBeInstanceOf(
      PmsRequestError,
    );
  });

  it('propage une panne PMS (503 — dégradation gracieuse, jamais un devis inventé)', async () => {
    getRoomDetail.mockRejectedValue(new PmsUnavailableError('PMS injoignable'));
    await expect(service.getQuote(query)).rejects.toBeInstanceOf(
      PmsUnavailableError,
    );
  });

  /**
   * ⚠️ Filet de **non-régression de contrat**, pas scénario de production : aujourd'hui
   * `catalog.toRoomDetailDto` calcule `totalPrice` par exactement `pricePerNight × nights`, donc
   * cette branche est inatteignable tant que cette formule ne change pas. Le mock forge donc
   * délibérément un état que `catalog` ne produit pas — c'est le seul moyen de vérifier que le
   * garde-fou parlerait si la formule divergeait un jour.
   */
  it('loggue un avertissement si le contrat catalog cessait de vérifier total = prix/nuit × nuits', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    getRoomDetail.mockResolvedValue(
      roomDetail({ pricePerNight: 8400, totalPrice: 16_799, nights: 2 }),
    );

    const quote = await service.getQuote(query);

    // Le devis reste cohérent avec le prix/nuit AFFICHÉ (la formule fait foi).
    expect(quote.roomTotal).toBe(16_800);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ROOM_ID));
    warn.mockRestore();
  });
});

describe('BookingService.createReservation', () => {
  let deps: ReturnType<typeof makeDeps>;
  let service: BookingService;

  beforeEach(() => {
    deps = makeDeps();
    service = buildService(deps);
  });

  describe('création nominale (AC-1)', () => {
    it('crée la réservation et renvoie code, statut, montants et échéance de hold', async () => {
      const reservation = await service.createReservation(SESSION, createBody);

      expect(reservation).toMatchObject({
        reservationId: RESERVATION_ID,
        reservationCode: 'RES-20260901-A1B2C',
        status: 'Pending',
        hotelId: HOTEL_ID,
        roomId: ROOM_ID,
        nights: 2,
        guests: 2,
        currency: 'EUR',
        created: true,
      });
      // Montants convertis en unités mineures depuis les `decimal` nus du PMS.
      expect(reservation.pricePerNight).toBe(8400);
      expect(reservation.total).toBe(16_800);
      expect(Date.parse(reservation.holdExpiresAt as string)).not.toBeNaN();
    });

    it('poste des dates ancrées UTC et le mode de paiement Stripe', async () => {
      await service.createReservation(SESSION, createBody);

      const { path, body } = postCall(deps, 0);
      expect(path).toBe(`/roomreservations/hotels/${HOTEL_ID}/reservations`);
      // Sans l'ancrage UTC, Npgsql rejette la date (Kind=Unspecified sur timestamptz) → 500.
      expect(body.checkInDate).toBe(`${createBody.checkInDate}T00:00:00Z`);
      expect(body.checkOutDate).toBe(`${createBody.checkOutDate}T00:00:00Z`);
      // 4 = Stripe. Le défaut du DTO PMS est Cash(1), qui fausserait le back-office Manager.
      expect(body.paymentMethod).toBe(4);
      expect(body.numberOfGuests).toBe(2);
    });

    it('désactive le retry sur la création (écriture non idempotente côté PMS)', async () => {
      await service.createReservation(SESSION, createBody);
      const context = postCall(deps, 0).context as { maxRetries?: number };
      // Un rejeu après réponse perdue créerait une SECONDE `Pending` et gèlerait une 2ᵉ chambre.
      expect(context.maxRetries).toBe(0);
    });

    // --- Story 2.5 (FR-10) : demandes spéciales & langue de communication -------------------

    it('transmet les demandes spéciales au PMS quand il y en a', async () => {
      // Symétrique de l'assertion qui gardait la frontière 2.4/2.5 : le champ existe désormais.
      await service.createReservation(SESSION, {
        ...createBody,
        specialRequests: 'Arrivée tardive vers 23 h',
      });
      expect(postCall(deps, 0).body.specialRequests).toBe(
        'Arrivée tardive vers 23 h',
      );
    });

    it("omet la clé du corps PMS quand il n'y a pas de demande spéciale", async () => {
      // `""` ou `null` explicite serait persisté tel quel : une demande « vide » au lieu d'absente.
      for (const specialRequests of [undefined, null, '']) {
        deps.post.mockClear();
        await service.createReservation(SESSION, {
          ...createBody,
          specialRequests,
        });
        expect(postCall(deps, 0).body).not.toHaveProperty('specialRequests');
      }
    });

    it("n'envoie JAMAIS la langue de communication au PMS (dépendance D10)", async () => {
      // Le PMS ne porte aucun champ de langue : l'envoyer serait ignoré en silence et donnerait
      // l'illusion d'une fonctionnalité livrée.
      await service.createReservation(SESSION, {
        ...createBody,
        communicationLocale: 'en',
      });
      const body = postCall(deps, 0).body;
      expect(body).not.toHaveProperty('communicationLocale');
      expect(body).not.toHaveProperty('language');
      expect(body).not.toHaveProperty('locale');
    });

    it('mémorise la langue choisie sur le hold — seul endroit où elle survit', async () => {
      await service.createReservation(SESSION, {
        ...createBody,
        communicationLocale: 'en',
      });
      // Ecrite HORS du hold (revue 2e passe, F7) : elle suit la Reservation, pas la tenue de chambre.
      expect(deps.writeCommunicationLocale).toHaveBeenCalledWith(
        RESERVATION_ID,
        'en',
      );
      // …et PAS sur l'enregistrement de hold : deux durées de vie distinctes (F7).
      const holdInput = (
        deps.promoteIntent.mock.calls[0] as unknown as [
          string,
          Record<string, unknown>,
        ]
      )[1];
      expect(holdInput).not.toHaveProperty('communicationLocale');
    });

    it('mémorise `null` quand aucune langue n’est exprimée', async () => {
      await service.createReservation(SESSION, createBody);
      // Aucun choix exprime : rien n'est ecrit, et l'etat « pas de choix » reste representable.
      expect(deps.writeCommunicationLocale).toHaveBeenCalledWith(
        RESERVATION_ID,
        null,
      );
    });

    it('renvoie les demandes spéciales RELUES du PMS, pas celles envoyées', async () => {
      // Le PMS est la seule autorité sur ce qui est réellement attaché à la réservation.
      deps.post.mockResolvedValue({
        data: pmsReservation({ specialRequests: 'Ce que le PMS a retenu' }),
      });
      const reservation = await service.createReservation(SESSION, {
        ...createBody,
        specialRequests: 'Ce que le navigateur a envoyé',
      });
      expect(reservation.specialRequests).toBe('Ce que le PMS a retenu');
    });

    it('expose `null` quand le PMS ne renvoie aucune demande spéciale', async () => {
      const reservation = await service.createReservation(SESSION, createBody);
      expect(reservation.specialRequests).toBeNull();
    });

    /**
     * Story 2.5, AC-9 (RGPD) — les demandes spéciales peuvent relever de l'article 9 (santé,
     * régime, accessibilité). Elles transitent vers le PMS et **disparaissent** : rien en Redis,
     * rien en journal. Un log « pour déboguer » les ferait atterrir dans l'agrégateur, hors de
     * toute base de traitement déclarée.
     */
    it('ne journalise JAMAIS le contenu des demandes spéciales, même en cas d’échec', async () => {
      const secret = 'Régime sans gluten et allergie sévère aux arachides';
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (level) =>
          jest
            .spyOn(Logger.prototype, level)
            .mockImplementation(() => undefined),
      );

      try {
        // Chemin nominal…
        await service.createReservation(SESSION, {
          ...createBody,
          specialRequests: secret,
        });

        // …puis le chemin d'échec qui journalise **réellement** : divergence de total. Il produit
        // un `logger.warn` décrivant la réservation, puis déclenche la compensation. C'est le pire
        // cas — celui où l'on serait tenté de « tout tracer pour comprendre ».
        deps.post.mockResolvedValueOnce({
          data: pmsReservation({ totalPrice: 200 }),
        });
        await service
          .createReservation(SESSION, {
            ...createBody,
            specialRequests: secret,
          })
          .catch(() => undefined);

        const emitted = spies.flatMap((spy) =>
          spy.mock.calls.map((args) => JSON.stringify(args)),
        );
        // Auto-validation : sans cette ligne, le test passerait aussi si AUCUN journal n'était
        // émis — une assurance de façade (défaut relevé en revue de la story 2.4).
        expect(emitted.length).toBeGreaterThan(0);
        expect(emitted.some((line) => line.includes('gluten'))).toBe(false);
        expect(emitted.some((line) => line.includes('arachides'))).toBe(false);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    it("annonce le repli tant que D10 n'est pas livré", async () => {
      // Le front ne code pas en dur l'état de la dépendance : c'est le BFF qui le porte.
      const reservation = await service.createReservation(SESSION, {
        ...createBody,
        communicationLocale: 'en',
      });
      expect(reservation.communicationLocale).toBe('en');
      expect(reservation.communicationLocaleState).toBe(
        'hotel_default_fallback',
      );
    });

    it('promeut l’intention en hold, écrit l’idempotence, puis libère le verrou', async () => {
      await service.createReservation(SESSION, createBody);

      expect(deps.promoteIntent).toHaveBeenCalledWith(
        registeredIntentId(deps),
        expect.objectContaining({
          reservationId: RESERVATION_ID,
          sid: SESSION.sid,
          userId: SESSION.user.userId,
        }),
      );
      // `register` seul laisserait l'intention dans l'index : le balayeur irait chercher — et
      // annuler — la réservation qu'elle vient d'engendrer.
      expect(deps.register).not.toHaveBeenCalled();
      expect(deps.writeIdempotent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: SESSION.user.userId,
          roomId: ROOM_ID,
        }),
        RESERVATION_ID,
      );
      expect(deps.releaseStayLock).toHaveBeenCalledWith(
        expect.anything(),
        'lock-token',
      );
    });

    it('n’expose ni le nom ni l’email du client (aucune PII rediffusée)', async () => {
      const reservation = await service.createReservation(SESSION, createBody);
      expect(reservation).not.toHaveProperty('customerEmail');
      expect(reservation).not.toHaveProperty('customerName');
    });
  });

  describe('idempotence (AC-5)', () => {
    it('renvoie la réservation mémorisée sans créer, sur rejeu du même séjour', async () => {
      deps.readIdempotent.mockResolvedValue(RESERVATION_ID);

      const reservation = await service.createReservation(SESSION, createBody);

      expect(reservation.created).toBe(false);
      expect(reservation.reservationId).toBe(RESERVATION_ID);
      expect(deps.post).not.toHaveBeenCalled();
    });

    it('ne pose même pas le verrou sur un rejeu (aucune contention inutile)', async () => {
      deps.readIdempotent.mockResolvedValue(RESERVATION_ID);
      await service.createReservation(SESSION, createBody);
      expect(deps.acquireStayLock).not.toHaveBeenCalled();
    });

    /**
     * Story 2.5, AC-6 — le rejeu affiche ce qui est **réellement attaché**.
     *
     * L'empreinte d'idempotence ignore volontairement le texte libre : l'y inclure ferait naître
     * une seconde `Pending` — donc geler une seconde chambre — à chaque correction de frappe. La
     * contrepartie assumée est que la réservation garde le texte de la PREMIÈRE soumission ; il
     * doit donc être relu du PMS, jamais réfléchi depuis le corps rejoué.
     */
    it('renvoie les demandes spéciales du PMS, pas celles du corps rejoué', async () => {
      deps.readIdempotent.mockResolvedValue(RESERVATION_ID);
      deps.get.mockResolvedValue({
        success: true,
        data: pmsReservation({ specialRequests: 'Texte de la 1ʳᵉ soumission' }),
      });

      const reservation = await service.createReservation(SESSION, {
        ...createBody,
        specialRequests: 'Texte corrigé, jamais transmis',
      });

      expect(reservation.created).toBe(false);
      expect(reservation.specialRequests).toBe('Texte de la 1ʳᵉ soumission');
      expect(deps.post).not.toHaveBeenCalled();
    });

    it('reprend la langue mémorisée pour la réservation, pas celle du corps rejoué', async () => {
      deps.readIdempotent.mockResolvedValue(RESERVATION_ID);
      deps.read.mockResolvedValue({
        reservationId: RESERVATION_ID,
        expiresAt: Date.now() + 600_000,
      });
      deps.readCommunicationLocale.mockResolvedValue('fr');

      const reservation = await service.createReservation(SESSION, {
        ...createBody,
        communicationLocale: 'en',
      });

      expect(reservation.communicationLocale).toBe('fr');
      // Un rejeu n'écrase JAMAIS le choix d'origine : la réservation existe déjà.
      expect(deps.writeCommunicationLocale).not.toHaveBeenCalled();
    });

    it('ne tente aucune mise à jour côté PMS sur un rejeu divergent', async () => {
      // `RoomReservationsController` n'expose AUCUNE route de mise à jour au rôle `Customer` :
      // une tentative serait un 404/405 en plein tunnel.
      deps.readIdempotent.mockResolvedValue(RESERVATION_ID);

      await service.createReservation(SESSION, {
        ...createBody,
        specialRequests: 'Nouveau texte',
        communicationLocale: 'en',
      });

      expect(deps.post).not.toHaveBeenCalled();
    });

    it('purge la mémoire et recrée si la réservation mémorisée n’est plus `Pending`', async () => {
      // Cas réel : le balayeur l'a annulée entre-temps. La resservir enverrait le voyageur payer
      // une réservation morte.
      deps.readIdempotent.mockResolvedValueOnce(RESERVATION_ID);
      deps.readIdempotent.mockResolvedValue(null);
      deps.get.mockResolvedValue({
        success: true,
        data: pmsReservation({ status: 5 }),
      });

      const reservation = await service.createReservation(SESSION, createBody);

      // Purge en compare-and-delete : une R2 vivante recréée entre-temps ne doit pas sauter.
      expect(deps.clearIdempotent).toHaveBeenCalledWith(
        expect.anything(),
        RESERVATION_ID,
      );
      expect(deps.post).toHaveBeenCalledTimes(1);
      expect(reservation.created).toBe(true);
    });

    it('purge la mémoire et recrée si la réservation mémorisée est introuvable', async () => {
      deps.readIdempotent.mockResolvedValueOnce(RESERVATION_ID);
      deps.readIdempotent.mockResolvedValue(null);
      deps.get.mockRejectedValue(new PmsRequestError('introuvable', 404));

      await expect(
        service.createReservation(SESSION, createBody),
      ).resolves.toMatchObject({ created: true });
      expect(deps.clearIdempotent).toHaveBeenCalled();
    });

    /**
     * ⚠️ La version précédente de ce test ne vérifiait **aucun ordre** : elle passait aussi bien
     * si la seconde lecture avait lieu *avant* le verrou, c'est-à-dire sans rien sérialiser du
     * tout. C'est l'ordre qui porte la garantie — d'où la comparaison des ordres d'invocation.
     */
    it('relit la mémoire APRÈS acquisition du verrou (double soumission concurrente)', async () => {
      deps.readIdempotent
        .mockResolvedValueOnce(null) // avant le verrou : rien
        .mockResolvedValue(RESERVATION_ID); // sous le verrou : le gagnant a écrit

      const reservation = await service.createReservation(SESSION, createBody);

      expect(reservation.created).toBe(false);
      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.readIdempotent).toHaveBeenCalledTimes(2);

      const [firstRead, secondRead] =
        deps.readIdempotent.mock.invocationCallOrder;
      const [lockAcquired] = deps.acquireStayLock.mock.invocationCallOrder;
      expect(firstRead).toBeLessThan(lockAcquired);
      expect(lockAcquired).toBeLessThan(secondRead);
    });

    /**
     * Un identifiant venu de Redis est interpolé dans `/roomreservations/{id}` : corrompu ou
     * forgé, il changerait l'endpoint réellement atteint (jusqu'à viser `/confirm`, AR-8).
     */
    it('purge une mémoire d’idempotence inexploitable sans jamais l’interpoler dans un chemin PMS', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.readIdempotent
        .mockResolvedValueOnce(`${RESERVATION_ID}/confirm`)
        .mockResolvedValue(null);

      const reservation = await service.createReservation(SESSION, createBody);

      expect(deps.get).not.toHaveBeenCalled();
      expect(deps.clearIdempotent).toHaveBeenCalledWith(
        expect.anything(),
        `${RESERVATION_ID}/confirm`,
      );
      expect(reservation.created).toBe(true);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('inexploitable'),
      );
      error.mockRestore();
    });

    /**
     * Le rejeu court-circuitait `expectedTotal` / `expectedCurrency` : un écran resté ouvert sur
     * un ancien prix repartait payer un montant différent de celui affiché — exactement ce que
     * AC-2 interdit sur le chemin nominal.
     */
    it('refuse un rejeu dont le total annoncé a divergé (409, sans rien annuler)', async () => {
      deps.readIdempotent.mockResolvedValue(RESERVATION_ID);

      const error = await service
        .createReservation(SESSION, { ...createBody, expectedTotal: 15_000 })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(reasonOf(error)).toBe('price-changed');
      // La réservation est légitime : c'est l'attente du client qui est périmée.
      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.release).not.toHaveBeenCalled();
      expect(deps.clearIdempotent).not.toHaveBeenCalled();
      expect(bodyOf(error).errors?.total).toEqual(['16800']);
    });

    it('refuse un rejeu dont la devise annoncée a divergé', async () => {
      deps.readIdempotent.mockResolvedValue(RESERVATION_ID);
      deps.getHotelCurrency.mockResolvedValue('MGA');

      const error = await service
        .createReservation(SESSION, createBody)
        .catch((e: unknown) => e);

      expect(reasonOf(error)).toBe('price-changed');
      expect(bodyOf(error).errors?.currency).toEqual(['MGA']);
    });
  });

  describe('verrou de chambre (AC-4)', () => {
    it('attend puis abandonne en 503 si le verrou reste pris (jamais « indisponible »)', async () => {
      deps.acquireStayLock.mockResolvedValue(null);

      // Un 409 « chambre indisponible » enverrait le voyageur chercher une alternative sans
      // raison : c'est notre sérialisation qui n'a pas abouti, pas l'inventaire.
      await expect(
        service.createReservation(SESSION, createBody),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(deps.post).not.toHaveBeenCalled();
      // Il ATTEND réellement : sans nouvelle tentative d'acquisition, le perdant abandonnerait
      // au premier échec alors que le gagnant tient le verrou pour quelques centaines de ms.
      expect(deps.acquireStayLock.mock.calls.length).toBeGreaterThan(1);
    });

    it('libère le verrou même quand la création échoue', async () => {
      deps.post.mockRejectedValue(
        new PmsRequestError('Le PMS a renvoyé le statut 400.', 400, {
          errors: ['Room is not available for the selected dates'],
        }),
      );

      await expect(
        service.createReservation(SESSION, createBody),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(deps.releaseStayLock).toHaveBeenCalledWith(
        expect.anything(),
        'lock-token',
      );
    });
  });

  describe('pré-contrôle sans écriture (AC-3)', () => {
    it('refuse un dépassement de capacité AVANT d’écrire', async () => {
      deps.getRoomDetail.mockResolvedValue(roomDetail({ capacity: 1 }));

      const error = await service
        .createReservation(SESSION, createBody)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(reasonOf(error)).toBe('over-capacity');
      expect(deps.post).not.toHaveBeenCalled();
    });

    it('refuse une chambre réellement indisponible AVANT d’écrire', async () => {
      deps.getRoomDetail.mockResolvedValue(roomDetail({ available: false }));

      const error = await service
        .createReservation(SESSION, createBody)
        .catch((e: unknown) => e);

      expect(reasonOf(error)).toBe('room-unavailable');
      expect(deps.post).not.toHaveBeenCalled();
    });

    it('ne bloque PAS sur une disponibilité dégradée (la création tranchera)', async () => {
      deps.getRoomDetail.mockResolvedValue(
        roomDetail({ available: false, availabilityDegraded: true }),
      );
      await expect(
        service.createReservation(SESSION, createBody),
      ).resolves.toMatchObject({ created: true });
    });

    it('refuse une devise différente de celle affichée', async () => {
      deps.getRoomDetail.mockResolvedValue(roomDetail({ currency: 'USD' }));
      deps.getHotelCurrency.mockResolvedValue('USD');

      const error = await service
        .createReservation(SESSION, createBody)
        .catch((e: unknown) => e);

      expect(reasonOf(error)).toBe('price-changed');
      expect(bodyOf(error).errors?.currency).toEqual(['USD']);
      expect(deps.post).not.toHaveBeenCalled();
    });

    /**
     * `pricePerNight × nights` était déjà calculé ici pour le contrôle de devise, mais le total
     * n'était confronté à `expectedTotal` qu'**après** la création : un écran périmé provoquait
     * une création PUIS une annulation — deux écritures réelles dans la base partagée avec le
     * back-office, pour un refus connaissable avant la première.
     */
    it('refuse un total annoncé périmé AVANT toute écriture (aucune création à compenser)', async () => {
      const error = await service
        .createReservation(SESSION, { ...createBody, expectedTotal: 15_000 })
        .catch((e: unknown) => e);

      expect(reasonOf(error)).toBe('price-changed');
      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.registerIntent).not.toHaveBeenCalled();
      // Le nouveau total est transmis pour re-confirmation explicite (AC-2).
      expect(bodyOf(error).errors?.total).toEqual(['16800']);
    });

    it('refuse un tarif non vendable avant d’écrire (jamais une réservation à prix nul)', async () => {
      deps.getRoomDetail.mockResolvedValue(roomDetail({ pricePerNight: 0 }));

      await expect(
        service.createReservation(SESSION, { ...createBody, expectedTotal: 0 }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(deps.post).not.toHaveBeenCalled();
    });

    it('traduit un 404 du pré-contrôle en `room-not-found`', async () => {
      deps.getRoomDetail.mockRejectedValue(
        new PmsRequestError('Chambre introuvable.', 404),
      );

      const error = await service
        .createReservation(SESSION, createBody)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(reasonOf(error)).toBe('room-not-found');
    });

    /**
     * ⚠️ Le commentaire d'origine promettait « panne → 503 » pour tout échec non-404 : c'était
     * faux pour un 4xx, que le filtre global relaie avec son statut, son `message` **et** ses
     * `errors` — le texte du PMS atterrissait dans le navigateur.
     */
    it('convertit un 4xx non-404 du pré-contrôle en 503, sans relayer le texte du PMS', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.getRoomDetail.mockRejectedValue(
        new PmsRequestError('Internal room table locked', 400, {
          errors: ['detail interne'],
        }),
      );

      const thrown = await service
        .createReservation(SESSION, createBody)
        .catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(ServiceUnavailableException);
      expect(bodyOf(thrown).message).not.toMatch(/room table/i);
      error.mockRestore();
    });

    it('laisse remonter une panne PMS du pré-contrôle (503, jamais « indisponible »)', async () => {
      deps.getRoomDetail.mockRejectedValue(new PmsUnavailableError('panne'));
      await expect(
        service.createReservation(SESSION, createBody),
      ).rejects.toBeInstanceOf(PmsUnavailableError);
    });
  });

  describe('devise — source unique du module (revue 2.4)', () => {
    it('résout la devise depuis l’Hôtel à la création, comme à la relecture', async () => {
      deps.getHotelCurrency.mockResolvedValue('MGA');
      deps.getRoomDetail.mockResolvedValue(
        roomDetail({
          currency: 'MGA',
          pricePerNight: 250_000,
          totalPrice: 500_000,
        }),
      );
      deps.post.mockResolvedValue({
        success: true,
        data: pmsReservation({ pricePerNight: 250_000, totalPrice: 500_000 }),
      });

      const reservation = await service.createReservation(SESSION, {
        ...createBody,
        expectedCurrency: 'MGA',
        expectedTotal: 500_000,
      });

      // La création interroge désormais la MÊME source que la relecture. Auparavant elle lisait
      // `room.currency` (cache fiche chambre) et la relecture `getHotelCurrency` (cache hôtel) :
      // après un changement de devise, la même réservation sortait avec deux exposants.
      expect(deps.getHotelCurrency).toHaveBeenCalledWith(HOTEL_ID);
      expect(reservation.currency).toBe('MGA');
      // MGA = 0 décimale : un repli sur EUR aurait produit 50 000 000.
      expect(reservation.total).toBe(500_000);
    });

    it('refuse d’écrire quand les deux caches de catalog annoncent deux devises', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.getHotelCurrency.mockResolvedValue('MGA'); // la fiche chambre dit EUR

      const thrown = await service
        .createReservation(SESSION, createBody)
        .catch((e: unknown) => e);

      expect(reasonOf(thrown)).toBe('price-changed');
      expect(deps.post).not.toHaveBeenCalled();
      // Aucun montant n'est proposé : il serait libellé dans une monnaie indéterminée (AR-12).
      expect(bodyOf(thrown).errors?.total).toBeUndefined();
      error.mockRestore();
    });
  });

  describe('échecs de la création PMS (AC-3)', () => {
    function pmsRefuses(text: string) {
      deps.post.mockRejectedValue(
        new PmsRequestError('Le PMS a renvoyé le statut 400.', 400, {
          errors: [text],
        }),
      );
    }

    it.each([
      ['Room is not available for the selected dates', 'room-unavailable'],
      ['Number of guests exceeds room capacity of 2', 'over-capacity'],
      ['Check-in date cannot be in the past', 'invalid-dates'],
      ['Room not found', 'room-not-found'],
      ['Customer not found', 'session-invalid'],
      ['Some unmapped failure', 'rejected'],
    ])('%s → motif `%s`', async (text, expected) => {
      pmsRefuses(text);
      const error = await service
        .createReservation(SESSION, createBody)
        .catch((e: unknown) => e);
      expect(reasonOf(error)).toBe(expected);
    });

    it('ne laisse jamais fuiter le texte du PMS dans la réponse', async () => {
      pmsRefuses('Room is not available for the selected dates');
      const error = await service
        .createReservation(SESSION, createBody)
        .catch((e: unknown) => e);
      expect(bodyOf(error).message).not.toMatch(/Room is not available/i);
    });

    it('n’enregistre ni hold ni idempotence quand la création échoue', async () => {
      pmsRefuses('Room is not available for the selected dates');
      await service.createReservation(SESSION, createBody).catch(() => null);
      expect(deps.promoteIntent).not.toHaveBeenCalled();
      expect(deps.writeIdempotent).not.toHaveBeenCalled();
    });

    it('laisse remonter une panne (503) plutôt que d’inventer un refus métier', async () => {
      deps.post.mockRejectedValue(new PmsUnavailableError('PMS injoignable'));
      await expect(
        service.createReservation(SESSION, createBody),
      ).rejects.toBeInstanceOf(PmsUnavailableError);
    });

    it('refuse un 2xx sans identifiant de réservation (contrat rompu → 503)', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.post.mockResolvedValue({ success: true, data: { id: undefined } });

      await expect(
        service.createReservation(SESSION, createBody),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(deps.promoteIntent).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it('refuse un 2xx dont l’identifiant n’est pas un GUID (jamais interpolé dans un chemin)', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.post.mockResolvedValue({
        success: true,
        data: pmsReservation({ id: `${RESERVATION_ID}/confirm` }),
      });

      await expect(
        service.createReservation(SESSION, createBody),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(deps.promoteIntent).not.toHaveBeenCalled();
      error.mockRestore();
    });
  });

  /**
   * **Correctif D1** — la réservation peut exister côté PMS alors que le BFF n'en saura jamais
   * rien (timeout, coupure, 5xx après insertion). L'intention est la seule trace qui permette au
   * balayeur d'aller la chercher : sans elle, une `Pending` gèle une vraie chambre pour toujours
   * et le rejeu en crée une seconde.
   */
  describe('intention de création (correctif D1)', () => {
    it('enregistre l’intention AVANT de poster la création', async () => {
      await service.createReservation(SESSION, createBody);

      const [intent] = deps.registerIntent.mock.invocationCallOrder;
      const [post] = deps.post.mock.invocationCallOrder;
      expect(intent).toBeLessThan(post);
      expect(deps.registerIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          sid: SESSION.sid,
          userId: SESSION.user.userId,
          hotelId: HOTEL_ID,
          roomId: ROOM_ID,
        }),
      );
    });

    it('retire l’intention quand le PMS refuse explicitement (rien n’a été écrit)', async () => {
      deps.post.mockRejectedValue(
        new PmsRequestError('Le PMS a renvoyé le statut 400.', 400, {
          errors: ['Room is not available for the selected dates'],
        }),
      );

      await service.createReservation(SESSION, createBody).catch(() => null);

      expect(deps.dropIntent).toHaveBeenCalledWith(registeredIntentId(deps));
    });

    it.each([
      ['un timeout / une coupure réseau', new PmsUnavailableError('timeout')],
      ['un 5xx', new PmsRequestError('Le PMS a renvoyé 502.', 502)],
      ['un 429 posé par un limiteur', new PmsRequestError('Too many', 429)],
    ])(
      'laisse l’intention en place sur %s (la `Pending` a pu être écrite)',
      async (_label, failure) => {
        deps.post.mockRejectedValue(failure);

        await service.createReservation(SESSION, createBody).catch(() => null);

        expect(deps.registerIntent).toHaveBeenCalled();
        expect(deps.dropIntent).not.toHaveBeenCalled();
      },
    );

    it('laisse l’intention en place sur un 2xx sans identifiant (le PMS a probablement écrit)', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.post.mockResolvedValue({ success: true, data: { id: undefined } });

      await service.createReservation(SESSION, createBody).catch(() => null);

      expect(deps.dropIntent).not.toHaveBeenCalled();
      error.mockRestore();
    });
  });

  /**
   * **Frontière de compensation** : entre la création réussie côté PMS et l'état écrit côté BFF,
   * chaque écriture Redis peut échouer. Aucun de ces chemins n'était exercé (les doubles
   * résolvaient toujours), alors que ce sont eux qui décident si une vraie chambre reste gelée.
   */
  describe('échecs partiels des écritures d’état après création PMS', () => {
    it('laisse l’intention au balayeur quand la promotion du hold échoue', async () => {
      deps.promoteIntent.mockRejectedValue(
        new ServiceUnavailableException('Magasin d’état indisponible.'),
      );

      await expect(
        service.createReservation(SESSION, createBody),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // Le hold n'existe pas : seule l'intention peut encore mener à cette réservation.
      expect(deps.dropIntent).not.toHaveBeenCalled();
      expect(deps.writeIdempotent).not.toHaveBeenCalled();
    });

    it('conserve le hold posé quand la mémoire d’idempotence échoue ensuite', async () => {
      deps.writeIdempotent.mockRejectedValue(
        new ServiceUnavailableException('Magasin d’état indisponible.'),
      );

      await expect(
        service.createReservation(SESSION, createBody),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // Le hold est enregistré : le balayeur libérera à l'échéance. Rien n'est annulé ici — la
      // réservation est parfaitement valide, c'est notre mémoire qui manque.
      expect(deps.promoteIntent).toHaveBeenCalled();
      expect(deps.release).not.toHaveBeenCalled();
      expect(deps.post).toHaveBeenCalledTimes(1); // aucune annulation compensatoire
    });

    it('n’annule rien quand la libération du verrou échoue après une création réussie', async () => {
      deps.releaseStayLock.mockRejectedValue(new Error('Redis KO'));

      await expect(
        service.createReservation(SESSION, createBody),
      ).rejects.toBeInstanceOf(Error);

      expect(deps.promoteIntent).toHaveBeenCalled();
      expect(deps.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('post-contrôle du total (AC-2)', () => {
    beforeEach(() => {
      // Le PMS a persisté 170 € là où l'écran annonçait 168 €.
      deps.post.mockResolvedValue({
        success: true,
        data: pmsReservation({ totalPrice: 170 }),
      });
    });

    it('annule la réservation créée et refuse en `price-changed`', async () => {
      const error = await service
        .createReservation(SESSION, createBody)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(reasonOf(error)).toBe('price-changed');
      expect(deps.post).toHaveBeenCalledWith(
        `/roomreservations/${RESERVATION_ID}/cancel`,
        undefined,
        expect.anything(),
      );
      expect(deps.release).toHaveBeenCalledWith(RESERVATION_ID);
    });

    it('transmet le nouveau total et sa devise pour re-confirmation explicite', async () => {
      const error = await service
        .createReservation(SESSION, createBody)
        .catch((e: unknown) => e);
      expect(bodyOf(error).errors?.total).toEqual(['17000']);
      expect(bodyOf(error).errors?.currency).toEqual(['EUR']);
    });

    it('enregistre le hold AVANT le contrôle : une compensation ratée reste rattrapable', async () => {
      // La 2ᵉ écriture (l'annulation) échoue : sans hold enregistré, la `Pending` serait orpheline
      // et invisible du balayeur — donc éternelle.
      deps.post
        .mockResolvedValueOnce({
          success: true,
          data: pmsReservation({ totalPrice: 170 }),
        })
        .mockRejectedValueOnce(
          new PmsUnavailableError('annulation impossible'),
        );

      await service.createReservation(SESSION, createBody).catch(() => null);

      expect(deps.promoteIntent).toHaveBeenCalled();
      expect(deps.release).not.toHaveBeenCalled(); // le hold reste pour le balayeur
      // Mais plus aucun rejeu ne la resservira — en compare-and-delete sur CETTE réservation.
      expect(deps.clearIdempotent).toHaveBeenCalledWith(
        expect.anything(),
        RESERVATION_ID,
      );
    });

    it('accepte un total identique au centime près', async () => {
      deps.post.mockResolvedValue({
        success: true,
        data: pmsReservation({ totalPrice: 168 }),
      });
      await expect(
        service.createReservation(SESSION, createBody),
      ).resolves.toMatchObject({ total: 16_800, created: true });
    });

    /**
     * `totalPrice ?? 0` fabriquait un montant : la réservation ressortait à `total: 0`, que le
     * parcours de re-confirmation faisait ensuite accepter en 201 — une réservation **gratuite**
     * dans la base partagée avec le back-office.
     */
    it('refuse une réservation persistée sans total (contrat rompu → 503)', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.post.mockResolvedValueOnce({
        success: true,
        data: pmsReservation({ totalPrice: undefined }),
      });

      await expect(
        service.createReservation(SESSION, createBody),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      error.mockRestore();
    });

    it('annule et refuse une réservation persistée à prix nul', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.post.mockResolvedValueOnce({
        success: true,
        data: pmsReservation({ totalPrice: 0 }),
      });

      await expect(
        service.createReservation(SESSION, createBody),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(deps.post).toHaveBeenCalledWith(
        `/roomreservations/${RESERVATION_ID}/cancel`,
        undefined,
        expect.anything(),
      );
      error.mockRestore();
    });
  });
});

describe('BookingService.getReservation', () => {
  let deps: ReturnType<typeof makeDeps>;
  let service: BookingService;

  beforeEach(() => {
    deps = makeDeps();
    service = buildService(deps);
  });

  it('relit la réservation et son échéance de hold (AC-9)', async () => {
    deps.read.mockResolvedValue({
      reservationId: RESERVATION_ID,
      expiresAt: Date.now() + 600_000,
    });

    const reservation = await service.getReservation(SESSION, RESERVATION_ID);

    expect(reservation).toMatchObject({
      reservationId: RESERVATION_ID,
      status: 'Pending',
      created: false,
    });
    expect(reservation.holdExpiresAt).not.toBeNull();
  });

  it('rend `holdExpiresAt: null` quand le hold est échu (plus de promesse de tenue)', async () => {
    deps.read.mockResolvedValue({
      reservationId: RESERVATION_ID,
      expiresAt: Date.now() - 1,
    });
    const reservation = await service.getReservation(SESSION, RESERVATION_ID);
    expect(reservation.holdExpiresAt).toBeNull();
  });

  // --- Story 2.5 (FR-10) ------------------------------------------------------------------

  it('relit la langue de communication mémorisée pour la réservation', async () => {
    deps.read.mockResolvedValue({
      reservationId: RESERVATION_ID,
      expiresAt: Date.now() + 600_000,
    });
    deps.readCommunicationLocale.mockResolvedValue('en');

    const reservation = await service.getReservation(SESSION, RESERVATION_ID);

    expect(reservation.communicationLocale).toBe('en');
    expect(reservation.communicationLocaleState).toBe('hotel_default_fallback');
  });

  /**
   * Revue 2ᵉ passe, F7 — la langue **survit à la disparition du hold**.
   *
   * Elle vivait sur `CheckoutHoldRecord` : le balayeur `release()` supprimait la clé, et le TTL
   * (15 min + 1 h) l'évinçait de toute façon. L'écran affirme pourtant « enregistré avec votre
   * réservation », et AC-3 promet à la story 3.2 de pouvoir la lire à la confirmation.
   */
  it('conserve la langue alors que le hold a disparu (clé propre, TTL propre)', async () => {
    // Hold libéré par le balayeur : plus AUCUN enregistrement. La préférence, elle, demeure.
    deps.read.mockResolvedValue(null);
    deps.readCommunicationLocale.mockResolvedValue('en');

    const reservation = await service.getReservation(SESSION, RESERVATION_ID);

    expect(reservation.holdExpiresAt).toBeNull();
    expect(reservation.communicationLocale).toBe('en');
  });

  it('conserve la langue quand le hold est simplement échu', async () => {
    deps.read.mockResolvedValue({
      reservationId: RESERVATION_ID,
      expiresAt: Date.now() - 1,
    });
    deps.readCommunicationLocale.mockResolvedValue('en');

    const reservation = await service.getReservation(SESSION, RESERVATION_ID);

    expect(reservation.holdExpiresAt).toBeNull();
    expect(reservation.communicationLocale).toBe('en');
  });

  it('rend `communicationLocale: null` quand rien n’a été choisi — jamais un défaut inventé', async () => {
    // Le front doit pouvoir distinguer « aucun choix connu » de « choix = fr ».
    deps.read.mockResolvedValue(null);
    deps.readCommunicationLocale.mockResolvedValue(null);
    const reservation = await service.getReservation(SESSION, RESERVATION_ID);
    expect(reservation.communicationLocale).toBeNull();
  });

  it('lit la langue indépendamment du hold (deux clés, deux durées de vie)', async () => {
    deps.read.mockResolvedValue(null);
    deps.readCommunicationLocale.mockResolvedValue('fr');
    await service.getReservation(SESSION, RESERVATION_ID);
    expect(deps.readCommunicationLocale).toHaveBeenCalledWith(RESERVATION_ID);
  });

  it('expose les demandes spéciales relues du PMS', async () => {
    deps.get.mockResolvedValue({
      success: true,
      data: pmsReservation({ specialRequests: 'Lit bébé si possible' }),
    });
    const reservation = await service.getReservation(SESSION, RESERVATION_ID);
    expect(reservation.specialRequests).toBe('Lit bébé si possible');
  });

  it('résout la devise depuis l’Hôtel (le DTO du PMS n’en porte aucune)', async () => {
    deps.getHotelCurrency.mockResolvedValue('MGA');
    const reservation = await service.getReservation(SESSION, RESERVATION_ID);

    expect(deps.getHotelCurrency).toHaveBeenCalledWith(HOTEL_ID);
    expect(reservation.currency).toBe('MGA');
    // MGA = 0 décimale : un défaut à EUR aurait produit 16 800 au lieu de 168.
    expect(reservation.total).toBe(168);
  });

  /**
   * `reservation.hotelId ?? ''` ciblait l'endpoint **liste** `/Hotels/` : le BFF interrogeait tout
   * le catalogue pour en déduire une devise, et servait ce que ce corps contenait.
   */
  it.each([
    ['absent', undefined],
    ['vide', ''],
    ['non-GUID', 'hotel-1'],
  ])(
    'refuse une réservation dont l’hôtel est %s, sans appeler /Hotels/',
    async (_label, hotelId) => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.get.mockResolvedValue({
        success: true,
        data: pmsReservation({ hotelId }),
      });

      await expect(
        service.getReservation(SESSION, RESERVATION_ID),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(deps.getHotelCurrency).not.toHaveBeenCalled();
      error.mockRestore();
    },
  );

  it('refuse une réservation servie sans total (jamais un montant fabriqué à 0)', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    deps.get.mockResolvedValue({
      success: true,
      data: pmsReservation({ totalPrice: undefined }),
    });

    await expect(
      service.getReservation(SESSION, RESERVATION_ID),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    error.mockRestore();
  });

  /**
   * `getHotelCurrency` laissait remonter une `PmsRequestError` intacte : le filtre global en
   * relaie `message` **et** `errors`, donc le corps d'erreur d'un endpoint interne du PMS
   * atteignait le navigateur sur une simple relecture de réservation.
   */
  it('convertit un 4xx de résolution de devise en 503, sans relayer le texte du PMS', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    deps.getHotelCurrency.mockRejectedValue(
      new PmsRequestError('Hotel table is locked by admin task', 400, {
        errors: ['trace interne'],
      }),
    );

    const thrown = await service
      .getReservation(SESSION, RESERVATION_ID)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect(bodyOf(thrown).message).not.toMatch(/Hotel table/i);
    error.mockRestore();
  });

  it('traduit un hôtel introuvable en 404 générique', async () => {
    deps.getHotelCurrency.mockRejectedValue(
      new PmsRequestError('Hotel not found in tenant 42', 404),
    );

    const thrown = await service
      .getReservation(SESSION, RESERVATION_ID)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(bodyOf(thrown).message).not.toMatch(/tenant 42/i);
  });

  it('normalise les dates du PMS en date-only (contrat du tunnel)', async () => {
    const reservation = await service.getReservation(SESSION, RESERVATION_ID);
    expect(reservation.checkInDate).toBe(query.checkInDate);
    expect(reservation.checkOutDate).toBe(query.checkOutDate);
  });

  it.each([
    ['introuvable', 404],
    ['appartenant à un autre compte', 403],
  ])(
    'refuse une réservation %s, sans relayer le texte du PMS',
    async (_l, status) => {
      deps.get.mockRejectedValue(
        new PmsRequestError('Not authorized to view this reservation.', status),
      );

      const error = await service
        .getReservation(SESSION, RESERVATION_ID)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(bodyOf(error).message).not.toMatch(/Not authorized/i);
    },
  );

  it('propage une session invalide en 401 (retour à l’identification)', async () => {
    deps.get.mockRejectedValue(new UnauthorizedException('Session expirée.'));
    await expect(
      service.getReservation(SESSION, RESERVATION_ID),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('mappe un statut PMS inconnu sur `Unknown` (jamais `Pending` par défaut)', async () => {
    // Traiter un statut non reconnu comme « en attente » autoriserait le balayeur à annuler une
    // réservation dont il ignore l'état (FR-14).
    deps.get.mockResolvedValue({
      success: true,
      data: pmsReservation({ status: 99 }),
    });
    const reservation = await service.getReservation(SESSION, RESERVATION_ID);
    expect(reservation.status).toBe('Unknown');
  });
});
