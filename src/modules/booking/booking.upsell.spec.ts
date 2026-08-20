import { ConflictException, Logger } from '@nestjs/common';
import type { RequestSession } from '../../common/decorators/current-session.decorator';
import type { PmsClientService } from '../../integration/pms/pms-client.service';
import { PmsRequestError } from '../../integration/pms/pms-errors';
import type { SessionService } from '../auth/session.service';
import type { CatalogService } from '../catalog/catalog.service';
import type { RoomDetailDto } from '../catalog/dto/room-detail.dto';
import { BOOKING_REASON_KEY } from './booking-errors';
import type { BookingOptions } from './booking.constants';
import { BookingService } from './booking.service';
import type { CheckoutHoldService } from './checkout-hold.service';
import type { CreateReservationRequestDto } from './dto/create-reservation.request.dto';

const HOTEL_ID = '11111111-1111-1111-1111-111111111111';
const ROOM_ID = '22222222-2222-2222-2222-222222222222';
const RESERVATION_ID = '44444444-4444-4444-4444-444444444444';
const SPA_ID = '66666666-6666-6666-6666-666666666666';
const BREAKFAST_ID = '77777777-7777-7777-7777-777777777777';

function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const CHECK_IN = isoDatePlus(30);
const CHECK_OUT = isoDatePlus(32); // 2 nuits
const SERVICE_DATE = isoDatePlus(31);

const SESSION: RequestSession = {
  sid: 'sid-1',
  user: {
    userId: '55555555-5555-5555-5555-555555555555',
    email: 'lea@example.com',
    firstName: 'Léa',
    lastName: 'Rakoto',
  },
};

const UPSELL_QUERY = {
  hotelId: HOTEL_ID,
  roomId: ROOM_ID,
  checkInDate: CHECK_IN,
  checkOutDate: CHECK_OUT,
  guests: 2,
};

function roomDetail(overrides: Partial<RoomDetailDto> = {}): RoomDetailDto {
  return {
    id: ROOM_ID,
    hotelId: HOTEL_ID,
    hotelName: 'Hôtel Colline',
    hotelCity: 'Antananarivo',
    hotelLogoUrl: null,
    number: '204',
    category: 'Double Confort',
    capacity: 2,
    amenities: 'wifi',
    floor: 2,
    description: null,
    includedServices: [],
    images: [],
    pricePerNight: 8400,
    totalPrice: 16800,
    currency: 'EUR',
    nights: 2,
    available: true,
    availabilityDegraded: false,
    ...overrides,
  };
}

/** Catalogue PMS : montants **décimaux**, comme le vrai `HotelServiceDto`. */
function pmsServices(overrides: Record<string, unknown>[] = []) {
  return [
    {
      id: SPA_ID,
      hotelId: HOTEL_ID,
      name: 'Spa',
      price: 30,
      unit: 'par séance',
      description: 'Accès spa',
      isActive: true,
      isExternallyBookable: true,
      externalQuantity: 0,
    },
    ...overrides,
  ];
}

function pmsReservation(overrides: Record<string, unknown> = {}) {
  return {
    id: RESERVATION_ID,
    reservationCode: 'RES-20260901-A1B2C',
    hotelId: HOTEL_ID,
    hotelName: 'Hôtel Colline',
    roomId: ROOM_ID,
    roomNumber: '204',
    customerId: SESSION.user.userId,
    checkInDate: `${CHECK_IN}T00:00:00Z`,
    checkOutDate: `${CHECK_OUT}T00:00:00Z`,
    numberOfGuests: 2,
    numberOfNights: 2,
    pricePerNight: 84,
    totalPrice: 168,
    servicesTotal: 0,
    grandTotal: 168,
    services: [],
    status: 1,
    ...overrides,
  };
}

/** Reservation PMS PORTANT un panier - utilisee seulement par les tests d'upsell. */
function pmsReservationWithServices() {
  return pmsReservation({
    servicesTotal: 60,
    grandTotal: 228,
    services: [
      {
        id: '88888888-8888-8888-8888-888888888888',
        serviceId: SPA_ID,
        serviceName: 'Spa',
        price: 30,
        quantity: 2,
        totalPrice: 60,
        serviceDate: `${SERVICE_DATE}T00:00:00Z`,
        status: 1,
      },
    ],
  });
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

function makeDeps() {
  return {
    getRoomDetail: jest.fn().mockResolvedValue(roomDetail()),
    getHotelCurrency: jest.fn().mockResolvedValue('EUR'),
    post: jest
      .fn()
      .mockResolvedValue({ success: true, data: pmsReservation() }),
    // Le catalogue de services et la relecture de réservation passent tous deux par `get` :
    // le double route sur le chemin, comme le ferait le vrai client.
    get: jest
      .fn()
      .mockImplementation((path: string) =>
        path.includes('/services')
          ? Promise.resolve({ success: true, data: pmsServices() })
          : Promise.resolve({ success: true, data: pmsReservation() }),
      ),
    put: jest.fn().mockResolvedValue({ success: true, data: null }),
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

function buildService(deps: ReturnType<typeof makeDeps>): BookingService {
  return new BookingService(
    {
      getRoomDetail: deps.getRoomDetail,
      getHotelCurrency: deps.getHotelCurrency,
    } as unknown as CatalogService,
    {
      post: deps.post,
      get: deps.get,
      put: deps.put,
    } as unknown as PmsClientService,
    {
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
    baseOptions,
  );
}

function createBody(
  overrides: Partial<CreateReservationRequestDto> = {},
): CreateReservationRequestDto {
  return {
    hotelId: HOTEL_ID,
    roomId: ROOM_ID,
    checkInDate: CHECK_IN,
    checkOutDate: CHECK_OUT,
    guests: 2,
    expectedTotal: 16_800,
    expectedCurrency: 'EUR',
    ...overrides,
  };
}

/**
 * Bascule les doubles PMS sur une reservation PORTANT le panier. A appeler dans tout test dont le
 * `expectedTotal` inclut des services : sinon le post-controle de total voit un grand total sans
 * services et refuse legitimement en `price-changed`.
 */
function withServicesResponse(deps: ReturnType<typeof makeDeps>): void {
  deps.post.mockResolvedValue({
    success: true,
    data: pmsReservationWithServices(),
  });
  deps.get.mockImplementation((path: string) =>
    path.includes('/services')
      ? Promise.resolve({ success: true, data: pmsServices() })
      : Promise.resolve({ success: true, data: pmsReservationWithServices() }),
  );
}

function postBody(deps: ReturnType<typeof makeDeps>): Record<string, unknown> {
  const call = deps.post.mock.calls[0] as unknown[];
  return call[1] as Record<string, unknown>;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('catalogue d’upsell (AC-1, AC-2)', () => {
  it('compose le catalogue en unités mineures de la devise de l’hôtel', async () => {
    const deps = makeDeps();

    const result = await buildService(deps).getUpsellServices(
      SESSION,
      UPSELL_QUERY,
    );

    expect(result.degraded).toBe(false);
    expect(result.services).toEqual([
      {
        serviceId: SPA_ID,
        name: 'Spa',
        description: 'Accès spa',
        unitPrice: 3_000, // 30 EUR → unités mineures
        currency: 'EUR',
        unit: 'par séance',
      },
    ]);
  });

  it('exclut un service DÉJÀ INCLUS dans la chambre', async () => {
    const deps = makeDeps();
    deps.getRoomDetail.mockResolvedValue(
      roomDetail({
        includedServices: [{ name: '  SPA  ', quantity: null, notes: null }],
      }),
    );

    const result = await buildService(deps).getUpsellServices(
      SESSION,
      UPSELL_QUERY,
    );

    // Le rapprochement est insensible à la casse, aux accents et aux blancs de bord : vendre ce
    // qui est déjà compris dans le tarif est une rupture de confiance directe.
    expect(result.services).toHaveLength(0);
  });

  it('écarte les services inactifs, non vendables ou sans prix exploitable', async () => {
    const deps = makeDeps();
    deps.get.mockImplementation((path: string) =>
      path.includes('/services')
        ? Promise.resolve({
            success: true,
            data: [
              { id: SPA_ID, name: 'Inactif', price: 30, isActive: false },
              {
                id: BREAKFAST_ID,
                name: 'Non vendable',
                price: 20,
                isActive: true,
                isExternallyBookable: false,
              },
              {
                id: '99999999-9999-9999-9999-999999999999',
                name: 'Gratuit ?',
                price: 0,
                isActive: true,
                isExternallyBookable: true,
              },
            ],
          })
        : Promise.resolve({ success: true, data: pmsReservation() }),
    );

    const result = await buildService(deps).getUpsellServices(
      SESSION,
      UPSELL_QUERY,
    );

    // Un prix nul n'est pas « gratuit » : c'est une donnée incomplète, et la vendre produirait
    // une ligne de panier à 0.
    expect(result.services).toHaveLength(0);
  });

  it('écarte un service à STOCK FINI — il exigerait un créneau que le tunnel ne collecte pas', async () => {
    const deps = makeDeps();
    deps.get.mockImplementation((path: string) =>
      path.includes('/services')
        ? Promise.resolve({
            success: true,
            data: [
              {
                id: SPA_ID,
                hotelId: HOTEL_ID,
                name: 'Billard',
                price: 10,
                isActive: true,
                isExternallyBookable: true,
                // > 0 = stock fini : le PMS exige StartTime/EndTime et refuserait la création.
                externalQuantity: 2,
              },
            ],
          })
        : Promise.resolve({ success: true, data: pmsReservation() }),
    );

    const result = await buildService(deps).getUpsellServices(
      SESSION,
      UPSELL_QUERY,
    );

    // Le proposer reviendrait à promettre un ajout que la création rejetterait à coup sûr.
    expect(result.services).toHaveLength(0);
  });

  it('dégrade sans fermer le tunnel quand le catalogue PMS est en panne', async () => {
    const deps = makeDeps();
    deps.get.mockImplementation((path: string) =>
      path.includes('/services')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ success: true, data: pmsReservation() }),
    );

    const result = await buildService(deps).getUpsellServices(
      SESSION,
      UPSELL_QUERY,
    );

    expect(result).toEqual({ services: [], degraded: true });
  });

  it('dégrade quand la fiche chambre est indisponible — plutôt que vendre ce qui est peut-être inclus', async () => {
    const deps = makeDeps();
    deps.getRoomDetail.mockRejectedValue(new Error('catalogue KO'));

    const result = await buildService(deps).getUpsellServices(
      SESSION,
      UPSELL_QUERY,
    );

    expect(result).toEqual({ services: [], degraded: true });
  });
});

describe('création avec panier (AC-3, AC-4, AC-9)', () => {
  it('transmet les lignes au PMS avec des dates ancrées UTC, sans aucun prix', async () => {
    const deps = makeDeps();
    withServicesResponse(deps);

    await buildService(deps).createReservation(
      SESSION,
      createBody({
        expectedTotal: 22_800, // 16 800 chambre + 6 000 services
        services: [
          { serviceId: SPA_ID, quantity: 2, serviceDate: SERVICE_DATE },
        ],
      }),
    );

    expect(postBody(deps).services).toEqual([
      {
        serviceId: SPA_ID,
        quantity: 2,
        serviceDate: `${SERVICE_DATE}T00:00:00Z`,
      },
    ]);
  });

  it('OMET la clé `services` quand le panier est vide — requête identique à l’avant-D6', async () => {
    const deps = makeDeps();

    await buildService(deps).createReservation(SESSION, createBody());

    expect(postBody(deps)).not.toHaveProperty('services');
  });

  it('OMET la clé `services` sur un tableau vide, plutôt que d’envoyer `[]`', async () => {
    const deps = makeDeps();

    await buildService(deps).createReservation(
      SESSION,
      createBody({ services: [] }),
    );

    expect(postBody(deps)).not.toHaveProperty('services');
  });

  it('refuse un total annoncé qui ignore les services, sans rien écrire', async () => {
    const deps = makeDeps();

    await expect(
      buildService(deps).createReservation(
        SESSION,
        createBody({
          expectedTotal: 16_800, // total chambre seul : l'écran n'a pas compté l'upsell
          services: [
            { serviceId: SPA_ID, quantity: 2, serviceDate: SERVICE_DATE },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(deps.post).not.toHaveBeenCalled();
  });

  it('tarife le panier au CATALOGUE, pas au prix annoncé par le client', async () => {
    const deps = makeDeps();
    withServicesResponse(deps);

    // 2 × 30 EUR = 6 000 unités mineures ; le total attendu doit valoir 16 800 + 6 000.
    await expect(
      buildService(deps).createReservation(
        SESSION,
        createBody({
          expectedTotal: 22_800,
          services: [
            { serviceId: SPA_ID, quantity: 2, serviceDate: SERVICE_DATE },
          ],
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('refuse un service inconnu du catalogue avant toute écriture', async () => {
    const deps = makeDeps();

    await expect(
      buildService(deps).createReservation(
        SESSION,
        createBody({
          expectedTotal: 22_800,
          services: [
            { serviceId: BREAKFAST_ID, quantity: 1, serviceDate: SERVICE_DATE },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      response: { errors: { [BOOKING_REASON_KEY]: ['service-unavailable'] } },
    });

    expect(deps.post).not.toHaveBeenCalled();
  });
});

describe('lecture d’une réservation avec services', () => {
  it('expose le GRAND total comme montant qui engage, et détaille les lignes', async () => {
    const deps = makeDeps();
    withServicesResponse(deps);

    const dto = await buildService(deps).getReservation(
      SESSION,
      RESERVATION_ID,
    );

    expect(dto.roomTotal).toBe(16_800);
    expect(dto.servicesTotal).toBe(6_000);
    expect(dto.total).toBe(22_800); // grandTotal, pas totalPrice
    expect(dto.services).toEqual([
      {
        lineId: '88888888-8888-8888-8888-888888888888',
        serviceId: SPA_ID,
        name: 'Spa',
        unitPrice: 3_000,
        quantity: 2,
        lineTotal: 6_000,
        serviceDate: SERVICE_DATE,
        status: 'Pending',
      },
    ]);
  });

  it('retombe sur `totalPrice` quand le PMS ne porte pas encore `grandTotal`', async () => {
    const deps = makeDeps();
    deps.get.mockImplementation((path: string) =>
      path.includes('/services')
        ? Promise.resolve({ success: true, data: pmsServices() })
        : Promise.resolve({
            success: true,
            data: pmsReservation({
              grandTotal: undefined,
              servicesTotal: undefined,
              services: undefined,
            }),
          }),
    );

    const dto = await buildService(deps).getReservation(
      SESSION,
      RESERVATION_ID,
    );

    expect(dto.total).toBe(16_800);
    expect(dto.servicesTotal).toBe(0);
    expect(dto.services).toEqual([]);
  });
});

describe('modification du panier (AC-5)', () => {
  it('envoie un remplacement complet et relit la réservation', async () => {
    const deps = makeDeps();

    await buildService(deps).replaceServices(SESSION, RESERVATION_ID, {
      services: [{ serviceId: SPA_ID, quantity: 1, serviceDate: SERVICE_DATE }],
    });

    const call = deps.put.mock.calls[0] as unknown[];
    expect(call[0]).toBe(`/roomreservations/${RESERVATION_ID}/services`);
    expect(call[1]).toEqual({
      services: [
        {
          serviceId: SPA_ID,
          quantity: 1,
          serviceDate: `${SERVICE_DATE}T00:00:00Z`,
        },
      ],
    });
    expect(deps.get).toHaveBeenCalled();
  });

  it('vide le panier sur un tableau vide (sémantique replace)', async () => {
    const deps = makeDeps();

    await buildService(deps).replaceServices(SESSION, RESERVATION_ID, {
      services: [],
    });

    const call = deps.put.mock.calls[0] as unknown[];
    expect(call[1]).toEqual({ services: [] });
  });

  it('traduit le gel par paiement en motif métier, jamais en 503', async () => {
    const deps = makeDeps();
    deps.put.mockRejectedValue(
      new PmsRequestError(
        'Cannot modify services: a payment is already engaged for this reservation',
        400,
      ),
    );

    await expect(
      buildService(deps).replaceServices(SESSION, RESERVATION_ID, {
        services: [],
      }),
    ).rejects.toMatchObject({
      response: { errors: { [BOOKING_REASON_KEY]: ['services-locked'] } },
    });
  });

  it('classe « service does not belong to this hotel » en service, pas en chambre introuvable', async () => {
    const deps = makeDeps();
    deps.put.mockRejectedValue(
      new PmsRequestError('Service does not belong to this hotel', 400),
    );

    // Le motif chambre `does not belong to this hotel` est plus général et le capterait s'il
    // était évalué en premier — le voyageur serait envoyé corriger son séjour pour un service.
    await expect(
      buildService(deps).replaceServices(SESSION, RESERVATION_ID, {
        services: [],
      }),
    ).rejects.toMatchObject({
      response: { errors: { [BOOKING_REASON_KEY]: ['service-unavailable'] } },
    });
  });

  it('laisse remonter une panne PMS en 503 plutôt que de la maquiller en refus métier', async () => {
    const deps = makeDeps();
    deps.put.mockRejectedValue(
      new PmsRequestError('Internal Server Error', 500),
    );

    await expect(
      buildService(deps).replaceServices(SESSION, RESERVATION_ID, {
        services: [],
      }),
    ).rejects.not.toBeInstanceOf(ConflictException);
  });
});
