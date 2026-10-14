import {
  BadGatewayException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { FakeRedis } from '../../../test/fake-redis';
import { CorrelationService } from '../../common/correlation/correlation.service';
import type { RequestSession } from '../../common/decorators/current-session.decorator';
import { PmsClientService } from '../../integration/pms/pms-client.service';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import {
  SERVICE_KEY_TOKEN,
  ServiceKeyProvider,
} from '../../integration/pms/service-key.provider';
import { RedisService } from '../../redis/redis.service';
import { SessionService } from '../auth/session.service';
import { toBookingException } from '../booking/booking-errors';
import { BookingService } from '../booking/booking.service';
import {
  type CheckoutHoldRecord,
  CheckoutHoldService,
} from '../booking/checkout-hold.service';
import type { BookingReservationDto } from '../booking/dto/reservation.dto';
import {
  CONFIRM_LOCK_KEY_PREFIX,
  ConfirmationLockService,
} from './confirmation-lock.service';
import { PAYMENT_OPTIONS, type PaymentOptions } from './payment.constants';
import { PaymentService } from './payment.service';
import { PaymentReconcileStore } from './reconcile.store';

const RESERVATION_ID = '11111111-1111-4111-8111-111111111111';
const CONFIRM_PATH = `/reservations/${RESERVATION_ID}/confirm`;

const session: RequestSession = {
  sid: 'sid-1',
  user: {
    userId: 'user-1',
    email: 'lea@example.com',
    firstName: 'Léa',
    lastName: 'Voyageuse',
    role: 4,
  },
} as RequestSession;

const options: PaymentOptions = {
  confirmLockTtlMs: 60_000,
  confirmWaitTimeoutMs: 2_000,
  confirmPollIntervalMs: 10,
};

/** Réservation relue par `BookingService` (projection BFF, PII déjà écartée par la 2.4). */
const reservation = (
  overrides: Partial<BookingReservationDto> = {},
): BookingReservationDto => ({
  reservationId: RESERVATION_ID,
  reservationCode: 'RES-20260901-A1B2C',
  status: 'Pending',
  hotelId: '22222222-2222-4222-8222-222222222222',
  hotelName: 'Hôtel Colline',
  roomId: '33333333-3333-4333-8333-333333333333',
  roomNumber: '204',
  roomCategory: 'Double Confort',
  checkInDate: '2026-09-01',
  checkOutDate: '2026-09-03',
  nights: 2,
  guests: 2,
  currency: 'EUR',
  pricePerNight: 8400,
  total: 18_300,
  roomTotal: 16_800,
  servicesTotal: 1_500,
  services: [
    {
      lineId: 'line-1',
      serviceId: 'svc-1',
      name: 'Petit-déjeuner',
      unitPrice: 750,
      quantity: 2,
      lineTotal: 1_500,
      serviceDate: '2026-09-02',
      status: 'Pending',
    },
  ],
  holdExpiresAt: '2026-09-01T10:00:00.000Z',
  specialRequests: 'Chambre calme, allergie aux arachides',
  communicationLocale: 'en',
  communicationLocaleState: 'hotel_default_fallback',
  created: false,
  ...overrides,
});

/**
 * Enregistrement de hold d'une réservation du tunnel dont l'intent a été émis : le PMS a créé la
 * ligne `Payment` et le `clientSecret` est parti vers le navigateur (3.1, revue ronde 2).
 */
const heldRecord = (
  overrides: Partial<CheckoutHoldRecord> = {},
): CheckoutHoldRecord => ({
  reservationId: RESERVATION_ID,
  sid: 'sid-1',
  userId: 'user-1',
  hotelId: '22222222-2222-4222-8222-222222222222',
  roomId: '33333333-3333-4333-8333-333333333333',
  expiresAt: Date.now() + 900_000,
  stayKey: 'booking:idem:v1:stay',
  paymentStarted: true,
  intentIssued: true,
  attempts: 0,
  ...overrides,
});

/** `GET /reservations/{id}/payment` (#153) : `status` = `PaymentStatus` du PMS (Refunded = 6). */
const paymentState = (
  payment: { status: number; intentStatus?: string | null } | null,
) => ({
  success: true,
  data: {
    reservationId: RESERVATION_ID,
    payment:
      payment === null
        ? null
        : {
            paymentId: '44444444-4444-4444-8444-444444444444',
            amount: 183,
            currency: 'EUR',
            stripeReadable: true,
            createdAt: '2026-09-01T09:00:00Z',
            paidAt: null,
            intentStatus: 'canceled',
            ...payment,
          },
  },
});

/** Réponse PMS de la confirmation (#152) : montants en unités MAJEURES, devise en majuscules. */
const pmsConfirmation = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    reservationId: RESERVATION_ID,
    grandTotal: 183,
    droppedServices: [],
    reservationCode: 'RES-20260901-A1B2C',
    currency: 'EUR',
    capturedAmount: 183,
    alreadyConfirmed: false,
    ...overrides,
  },
});

/**
 * Story 3.2 (B3 / B8) — `PaymentService.confirm`.
 *
 * Le verrou est le VRAI `ConfirmationLockService`, sur un faux Redis fidèle (`SET NX PX`,
 * compare-and-delete, expiration) : un double permissif validerait un single-flight qui n'en est pas
 * un (leçon 2.1).
 */
describe('PaymentService.confirm', () => {
  let service: PaymentService;
  let redis: FakeRedis;
  let calls: string[];
  let pms: { post: jest.Mock; get: jest.Mock };
  let booking: { getReservation: jest.Mock };
  let holds: {
    read: jest.Mock;
    forget: jest.Mock;
    release: jest.Mock;
    markPaymentStarted: jest.Mock;
    clearPaymentStarted: jest.Mock;
  };
  let reconcile: { enroll: jest.Mock; remove: jest.Mock };

  async function build(redisService: RedisService): Promise<void> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        ConfirmationLockService,
        ServiceKeyProvider,
        { provide: SERVICE_KEY_TOKEN, useValue: 'svc-key-test' },
        { provide: PAYMENT_OPTIONS, useValue: options },
        { provide: RedisService, useValue: redisService },
        { provide: PmsClientService, useValue: pms },
        {
          provide: SessionService,
          useValue: { withCustomerAuth: jest.fn() },
        },
        { provide: BookingService, useValue: booking },
        { provide: CheckoutHoldService, useValue: holds },
        { provide: PaymentReconcileStore, useValue: reconcile },
        {
          provide: CorrelationService,
          useValue: { getCorrelationId: () => 'corr-1' },
        },
      ],
    }).compile();
    service = module.get(PaymentService);
  }

  beforeEach(async () => {
    calls = [];
    redis = new FakeRedis();
    pms = {
      post: jest.fn((path: string) => {
        calls.push(`pms.post ${path}`);
        return Promise.resolve(pmsConfirmation());
      }),
      // Lecture de service du paiement (#153), lue pour énoncer le statut de débit d'un échec (#4).
      get: jest.fn().mockResolvedValue(paymentState(null)),
    };
    let confirmed = false;
    pms.post.mockImplementation((path: string) => {
      calls.push(`pms.post ${path}`);
      confirmed = true;
      return Promise.resolve(pmsConfirmation());
    });
    booking = {
      getReservation: jest.fn(() => {
        calls.push('booking.getReservation');
        return Promise.resolve(
          confirmed
            ? reservation({
                status: 'Confirmed',
                services: [
                  { ...reservation().services[0], status: 'Confirmed' },
                ],
              })
            : reservation(),
        );
      }),
    };
    holds = {
      // Hold du tunnel : paiement engagé (intent émis, story 3.1), seul cas confirmable.
      read: jest.fn(() => {
        calls.push('holds.read');
        return Promise.resolve(heldRecord());
      }),
      forget: jest.fn(() => {
        calls.push('holds.forget');
        return Promise.resolve();
      }),
      release: jest.fn().mockResolvedValue(undefined),
      markPaymentStarted: jest.fn().mockResolvedValue(undefined),
      clearPaymentStarted: jest.fn().mockResolvedValue(undefined),
    };
    reconcile = {
      enroll: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    await build(new RedisService(redis as unknown as Redis));
  });

  describe('chemin nominal', () => {
    it('relit, vérifie le paiement engagé, confirme sous X-Service-Key, relit, oublie le hold', async () => {
      await service.confirm(session, RESERVATION_ID);

      expect(calls).toEqual([
        'booking.getReservation',
        'holds.read',
        `pms.post ${CONFIRM_PATH}`,
        'booking.getReservation',
        'holds.forget',
      ]);
    });

    it('appelle le PMS avec la seule clé de service : ni Bearer, ni corps, clé d’idempotence stable', async () => {
      await service.confirm(session, RESERVATION_ID);
      await redis.del(CONFIRM_LOCK_KEY_PREFIX + RESERVATION_ID);

      const [path, body, ctx] = pms.post.mock.calls[0] as [
        string,
        unknown,
        {
          headers: Record<string, string>;
          bearerToken?: string;
          idempotencyKey: string;
          maxRetries?: number;
          correlationId?: string;
        },
      ];
      expect(path).toBe(CONFIRM_PATH);
      expect(body).toBeUndefined();
      expect(ctx.headers['X-Service-Key']).toBe('svc-key-test');
      expect(ctx.bearerToken).toBeUndefined();
      expect(ctx.correlationId).toBe('corr-1');
      // `maxRetries` par défaut : la route est idempotente par contrat PMS (#152).
      expect(ctx.maxRetries).toBeUndefined();
      expect(ctx.idempotencyKey).toMatch(/^[0-9a-f]{40}$/);
      expect(ctx.idempotencyKey).not.toContain(RESERVATION_ID);
    });

    it('construit une preuve réduite : aucune PII, aucun jeton, montant capturé en unités mineures', async () => {
      const proof = await service.confirm(session, RESERVATION_ID);

      expect(proof).toEqual({
        reservationId: RESERVATION_ID,
        reservationCode: 'RES-20260901-A1B2C',
        status: 'Confirmed',
        hotelName: 'Hôtel Colline',
        roomNumber: '204',
        roomCategory: 'Double Confort',
        checkInDate: '2026-09-01',
        checkOutDate: '2026-09-03',
        nights: 2,
        guests: 2,
        currency: 'EUR',
        total: 18_300,
        roomTotal: 16_800,
        servicesTotal: 1_500,
        services: [
          expect.objectContaining({ serviceId: 'svc-1', status: 'Confirmed' }),
        ],
        capturedAmount: 18_300,
        communicationLocale: 'en',
        communicationLocaleState: 'hotel_default_fallback',
        alreadyConfirmed: false,
      });
      const serialized = JSON.stringify(proof);
      expect(serialized).not.toMatch(
        /customerName|customerEmail|validationToken|specialRequests|arachides/,
      );
    });

    it('rapporte alreadyConfirmed quand le PMS dit que la confirmation avait déjà eu lieu', async () => {
      pms.post.mockResolvedValueOnce(
        pmsConfirmation({ alreadyConfirmed: true }),
      );

      const proof = await service.confirm(session, RESERVATION_ID);

      expect(proof.alreadyConfirmed).toBe(true);
    });

    it('libère le verrou après la confirmation', async () => {
      await service.confirm(session, RESERVATION_ID);

      expect(await redis.get(CONFIRM_LOCK_KEY_PREFIX + RESERVATION_ID)).toBe(
        null,
      );
    });

    it('relecture finale en panne : preuve tirée de la première lecture et du résultat PMS', async () => {
      booking.getReservation
        .mockResolvedValueOnce(reservation())
        .mockRejectedValueOnce(new PmsUnavailableError('down'));
      pms.post.mockResolvedValueOnce(
        pmsConfirmation({
          grandTotal: 168,
          capturedAmount: 168,
          droppedServices: [{ id: 'line-1' }],
        }),
      );

      const proof = await service.confirm(session, RESERVATION_ID);

      // La confirmation a réussi : la perdre sur une simple relecture renverrait le voyageur
      // réessayer une opération déjà faite.
      expect(proof.status).toBe('Confirmed');
      expect(proof.total).toBe(16_800);
      expect(proof.servicesTotal).toBe(0);
      expect(proof.services[0].status).toBe('Cancelled');
      expect(proof.capturedAmount).toBe(16_800);
    });

    it('devise PMS divergente : capturé non affiché (null), jamais un montant dans la mauvaise devise', async () => {
      pms.post.mockResolvedValueOnce(pmsConfirmation({ currency: 'CHF' }));

      const proof = await service.confirm(session, RESERVATION_ID);

      expect(proof.capturedAmount).toBeNull();
      expect(proof.currency).toBe('EUR');
    });
  });

  describe('chemin idempotent rapide (AC-2)', () => {
    it.each(['Confirmed', 'CheckedIn', 'CheckedOut'] as const)(
      'réservation déjà %s : preuve sans AUCUN appel au PMS, hold oublié',
      async (status) => {
        booking.getReservation.mockResolvedValue(reservation({ status }));

        const proof = await service.confirm(session, RESERVATION_ID);

        expect(pms.post).not.toHaveBeenCalled();
        expect(holds.forget).toHaveBeenCalledWith(RESERVATION_ID);
        expect(proof.alreadyConfirmed).toBe(true);
        expect(proof.status).toBe(status);
        // Non relu sur ce chemin : le front affiche le total, garanti égal au capturé par le PMS.
        expect(proof.capturedAmount).toBeNull();
        expect(proof.total).toBe(18_300);
      },
    );

    it('ne prend pas le verrou sur le chemin rapide', async () => {
      booking.getReservation.mockResolvedValue(
        reservation({ status: 'Confirmed' }),
      );
      await redis.set(
        CONFIRM_LOCK_KEY_PREFIX + RESERVATION_ID,
        'autre',
        'PX',
        60_000,
      );

      await expect(
        service.confirm(session, RESERVATION_ID),
      ).resolves.toMatchObject({ alreadyConfirmed: true });
    });
  });

  describe('single-flight (AC-3)', () => {
    it('deux appels concurrents : UN seul POST de confirmation, la même preuve pour les deux', async () => {
      let releasePms!: () => void;
      const pmsGate = new Promise<void>((resolve) => {
        releasePms = resolve;
      });
      let confirmed = false;
      booking.getReservation.mockImplementation(() =>
        Promise.resolve(
          reservation({ status: confirmed ? 'Confirmed' : 'Pending' }),
        ),
      );
      pms.post.mockImplementation(async () => {
        await pmsGate;
        confirmed = true;
        return pmsConfirmation();
      });

      const first = service.confirm(session, RESERVATION_ID);
      const second = service.confirm(session, RESERVATION_ID);
      await new Promise((resolve) => setTimeout(resolve, 50));
      releasePms();
      const [a, b] = await Promise.all([first, second]);

      expect(pms.post).toHaveBeenCalledTimes(1);
      expect(a.reservationCode).toBe(b.reservationCode);
      expect(a.total).toBe(b.total);
      expect([a.alreadyConfirmed, b.alreadyConfirmed].sort()).toEqual([
        false,
        true,
      ]);
    });

    it('le perdant reprend la main si le gagnant a échoué (réservation toujours Pending)', async () => {
      await redis.set(
        CONFIRM_LOCK_KEY_PREFIX + RESERVATION_ID,
        'gagnant',
        'PX',
        60_000,
      );
      setTimeout(() => {
        void redis.del(CONFIRM_LOCK_KEY_PREFIX + RESERVATION_ID);
      }, 30);

      const proof = await service.confirm(session, RESERVATION_ID);

      expect(pms.post).toHaveBeenCalledTimes(1);
      expect(proof.alreadyConfirmed).toBe(false);
    });

    it('verrou toujours tenu au-delà de l’attente : 503 rejouable, aucun appel PMS', async () => {
      await redis.set(
        CONFIRM_LOCK_KEY_PREFIX + RESERVATION_ID,
        'gagnant',
        'PX',
        60_000,
      );

      await expect(
        service.confirm(session, RESERVATION_ID),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(pms.post).not.toHaveBeenCalled();
    }, 10_000);

    it('panne Redis : 503, jamais 500, et aucun appel PMS', async () => {
      await build(
        new RedisService({
          set: () => Promise.reject(new Error('ECONNREFUSED')),
          get: () => Promise.reject(new Error('ECONNREFUSED')),
          eval: () => Promise.reject(new Error('ECONNREFUSED')),
        } as unknown as Redis),
      );

      await expect(
        service.confirm(session, RESERVATION_ID),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(pms.post).not.toHaveBeenCalled();
    });
  });

  describe('paiement engagé exigé (revue ronde 1 : jamais de chambre sans débit)', () => {
    const refusal = async (): Promise<{ type: unknown; reason: unknown }> => {
      const err: unknown = await service
        .confirm(session, RESERVATION_ID)
        .catch((e: unknown) => e);
      const response = (
        err as { getResponse?: () => { errors?: { reason?: string[] } } }
      ).getResponse?.();
      return { type: err, reason: response?.errors?.reason?.[0] };
    };

    it('lit le hold AVANT de prendre le verrou et d’appeler le PMS', async () => {
      await service.confirm(session, RESERVATION_ID);

      expect(calls.indexOf('holds.read')).toBeGreaterThan(
        calls.indexOf('booking.getReservation'),
      );
      expect(calls.indexOf('holds.read')).toBeLessThan(
        calls.indexOf(`pms.post ${CONFIRM_PATH}`),
      );
    });

    it.each([
      [
        'hold sans paiement engagé (aucun intent émis)',
        heldRecord({ paymentStarted: false, intentIssued: false }),
      ],
      [
        'gel posé mais intent en échec (Stripe, circuit ouvert, timeout : aucune ligne Payment)',
        heldRecord({ paymentStarted: true, intentIssued: false }),
      ],
      [
        'gel posé, intentIssued absent (hold antérieur au correctif)',
        heldRecord({ paymentStarted: true, intentIssued: undefined }),
      ],
      ['hold absent (expiré, libéré ou jamais créé)', null],
    ])(
      'Pending + %s : 409 payment-not-authorized, aucun appel PMS, aucun verrou',
      async (_label, hold) => {
        holds.read.mockResolvedValue(hold);

        const { type, reason } = await refusal();

        expect(type).toBeInstanceOf(ConflictException);
        expect(reason).toBe('payment-not-authorized');
        expect(pms.post).not.toHaveBeenCalled();
        expect(holds.forget).not.toHaveBeenCalled();
        expect(
          await redis.get(CONFIRM_LOCK_KEY_PREFIX + RESERVATION_ID),
        ).toBeNull();
      },
    );

    it('intent émis puis gel relâché par un refus ultérieur : la confirmation part (le paiement existe)', async () => {
      holds.read.mockResolvedValue(
        heldRecord({ paymentStarted: false, intentIssued: true }),
      );

      await expect(
        service.confirm(session, RESERVATION_ID),
      ).resolves.toMatchObject({ status: 'Confirmed' });
      expect(pms.post).toHaveBeenCalledTimes(1);
    });

    it('panne Redis à la lecture du hold : 503, jamais une confirmation sans preuve de paiement', async () => {
      holds.read.mockRejectedValue(new ServiceUnavailableException());

      await expect(
        service.confirm(session, RESERVATION_ID),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(pms.post).not.toHaveBeenCalled();
    });

    it.each(['Confirmed', 'CheckedIn', 'CheckedOut'] as const)(
      'déjà %s : la preuve est rendue même sans hold (rechargement après expiration)',
      async (status) => {
        booking.getReservation.mockResolvedValue(reservation({ status }));
        holds.read.mockResolvedValue(null);

        await expect(
          service.confirm(session, RESERVATION_ID),
        ).resolves.toMatchObject({ alreadyConfirmed: true });
        expect(pms.post).not.toHaveBeenCalled();
      },
    );

    it('annulée sans hold : reservation-cancelled reste le motif (statut d’abord)', async () => {
      booking.getReservation.mockResolvedValue(
        reservation({ status: 'Cancelled' }),
      );
      holds.read.mockResolvedValue(null);

      const { reason } = await refusal();

      expect(reason).toBe('reservation-cancelled');
    });
  });

  describe('hold : forget après succès, jamais release, rien après échec (AC-5)', () => {
    it('succès : forget, jamais release', async () => {
      await service.confirm(session, RESERVATION_ID);

      expect(holds.forget).toHaveBeenCalledWith(RESERVATION_ID);
      expect(holds.release).not.toHaveBeenCalled();
    });

    it('échec : ni forget ni release', async () => {
      pms.post.mockRejectedValueOnce(
        new PmsRequestError('x', 400, {
          errors: ['Reservation payment is not authorized'],
        }),
      );

      await expect(service.confirm(session, RESERVATION_ID)).rejects.toThrow();
      expect(holds.forget).not.toHaveBeenCalled();
      expect(holds.release).not.toHaveBeenCalled();
    });

    it('échec : le verrou est rendu (un nouvel essai peut partir)', async () => {
      pms.post.mockRejectedValueOnce(
        new PmsUnavailableError('down', undefined, {
          status: 502,
          body: { errors: ['Payment capture failed'] },
        }),
      );

      await expect(service.confirm(session, RESERVATION_ID)).rejects.toThrow();
      expect(await redis.get(CONFIRM_LOCK_KEY_PREFIX + RESERVATION_ID)).toBe(
        null,
      );
    });

    it('forget en panne après une confirmation réussie : la preuve est quand même rendue', async () => {
      holds.forget.mockRejectedValueOnce(new ServiceUnavailableException());

      await expect(
        service.confirm(session, RESERVATION_ID),
      ).resolves.toMatchObject({ status: 'Confirmed' });
    });
  });

  describe('réconciliation (#5 AC-1) : la réservation confirmée sort de son index', () => {
    it('après une confirmation réussie', async () => {
      await service.confirm(session, RESERVATION_ID);
      expect(reconcile.remove).toHaveBeenCalledWith(RESERVATION_ID);
    });

    it('sur le chemin idempotent rapide (déjà confirmée)', async () => {
      booking.getReservation.mockResolvedValue(
        reservation({ status: 'Confirmed' }),
      );
      await service.confirm(session, RESERVATION_ID);
      expect(reconcile.remove).toHaveBeenCalledWith(RESERVATION_ID);
    });

    it('jamais après un échec : le filet reste tendu', async () => {
      pms.post.mockRejectedValueOnce(new PmsUnavailableError('down'));
      await expect(service.confirm(session, RESERVATION_ID)).rejects.toThrow();
      expect(reconcile.remove).not.toHaveBeenCalled();
    });

    it('panne Redis au retrait : la preuve est quand même rendue', async () => {
      reconcile.remove.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(
        service.confirm(session, RESERVATION_ID),
      ).resolves.toMatchObject({ status: 'Confirmed' });
    });
  });

  describe('motifs de refus (AC-6)', () => {
    const reasonOf = async (): Promise<{ type: unknown; reason: unknown }> => {
      const err: unknown = await service
        .confirm(session, RESERVATION_ID)
        .catch((e: unknown) => e);
      const response = (
        err as { getResponse?: () => { errors?: { reason?: string[] } } }
      ).getResponse?.();
      return { type: err, reason: response?.errors?.reason?.[0] };
    };

    it.each([
      ['Reservation payment is not authorized', 'payment-not-authorized'],
      ['Authorized amount does not match the amount due', 'amount-mismatch'],
      [
        'Cannot confirm a reservation in status Cancelled',
        'reservation-cancelled',
      ],
    ])('400 « %s » → %s (409)', async (text, reason) => {
      pms.post.mockRejectedValueOnce(
        new PmsRequestError('x', 400, { errors: [text] }),
      );

      const { type, reason: actual } = await reasonOf();

      expect(type).toBeInstanceOf(ConflictException);
      expect(actual).toBe(reason);
    });

    it('502 « capture échouée » → capture-failed (502, rejouable)', async () => {
      pms.post.mockRejectedValueOnce(
        new PmsUnavailableError('down', undefined, {
          status: 502,
          body: { success: false, errors: ['Payment capture failed'] },
        }),
      );

      const { type, reason } = await reasonOf();

      expect(type).toBeInstanceOf(BadGatewayException);
      expect(reason).toBe('capture-failed');
    });

    it('502 « autorisation expirée » → authorisation-expired (409, déterministe)', async () => {
      pms.post.mockRejectedValueOnce(
        new PmsUnavailableError('down', undefined, {
          status: 502,
          body: {
            success: false,
            errors: ['Payment authorisation has expired'],
          },
        }),
      );

      const { type, reason } = await reasonOf();

      expect(type).toBeInstanceOf(ConflictException);
      expect(reason).toBe('authorisation-expired');
    });

    it('404 du PMS → reservation-not-found', async () => {
      pms.post.mockRejectedValueOnce(
        new PmsRequestError('x', 404, { errors: ['Reservation not found'] }),
      );

      const { type, reason } = await reasonOf();

      expect(type).toBeInstanceOf(NotFoundException);
      expect(reason).toBe('reservation-not-found');
    });

    it('panne PMS sans motif → PmsUnavailableError (503 par le filtre global)', async () => {
      pms.post.mockRejectedValueOnce(new PmsUnavailableError('down'));

      const { type } = await reasonOf();

      expect(type).toBeInstanceOf(PmsUnavailableError);
    });

    it('clé de service refusée (401) → 503, jamais « session expirée »', async () => {
      pms.post.mockRejectedValueOnce(
        new PmsRequestError('Unauthorized', 401, { errors: ['Invalid key'] }),
      );

      const { type, reason } = await reasonOf();

      expect(type).toBeInstanceOf(ServiceUnavailableException);
      expect(reason).toBeUndefined();
    });

    it('réservation d’un autre compte (404 à la relecture) → reservation-not-found, aucun appel PMS', async () => {
      booking.getReservation.mockRejectedValueOnce(
        toBookingException('room-not-found'),
      );

      const { type, reason } = await reasonOf();

      expect(type).toBeInstanceOf(NotFoundException);
      expect(reason).toBe('reservation-not-found');
      expect(pms.post).not.toHaveBeenCalled();
    });

    it('session expirée à la relecture : 401 propagé tel quel', async () => {
      booking.getReservation.mockRejectedValueOnce(
        new UnauthorizedException('Session expirée.'),
      );

      const { type } = await reasonOf();

      expect(type).toBeInstanceOf(UnauthorizedException);
    });

    it('réservation annulée à la relecture : reservation-cancelled, aucun appel PMS', async () => {
      booking.getReservation.mockResolvedValue(
        reservation({ status: 'Cancelled' }),
      );

      const { type, reason } = await reasonOf();

      expect(type).toBeInstanceOf(ConflictException);
      expect(reason).toBe('reservation-cancelled');
      expect(pms.post).not.toHaveBeenCalled();
    });

    it('contrat PMS rompu (2xx sans données) → 503', async () => {
      pms.post.mockResolvedValueOnce({ success: true });

      const { type } = await reasonOf();

      expect(type).toBeInstanceOf(ServiceUnavailableException);
    });
  });

  /**
   * #4 (story 3.3) AC-7 / AC-8 — chambre devenue indisponible avant la capture : le PMS n'a rien
   * capturé, a libéré le paiement et annulé la `Pending`. Le BFF classe `room-unavailable` et énonce
   * le statut de débit lu au PMS (route de service) : jamais deviné.
   */
  describe('chambre devenue indisponible (#4, AC-7, AC-8)', () => {
    const roomTaken = () =>
      new PmsRequestError('Le PMS a renvoyé le statut 409.', 409, {
        errors: ['Room is no longer available for this reservation'],
      });

    const failure = async () => {
      const err: unknown = await service
        .confirm(session, RESERVATION_ID)
        .catch((e: unknown) => e);
      const response = (
        err as { getResponse?: () => { errors?: Record<string, string[]> } }
      ).getResponse?.();
      return { err, errors: response?.errors ?? {} };
    };

    it('409 du PMS → room-unavailable (409), autorisation libérée : « aucun débit »', async () => {
      pms.post.mockRejectedValueOnce(roomTaken());
      pms.get.mockResolvedValue(paymentState({ status: 5 }));

      const { err, errors } = await failure();

      expect(err).toBeInstanceOf(ConflictException);
      expect(errors.reason).toEqual(['room-unavailable']);
      expect(errors.debit).toEqual(['none']);
    });

    it('AC-5 : argent déjà encaissé puis remboursé → « remboursement intégral émis »', async () => {
      pms.post.mockRejectedValueOnce(roomTaken());
      pms.get.mockResolvedValue(
        paymentState({ status: 6, intentStatus: 'succeeded' }),
      );

      const { errors } = await failure();

      expect(errors.reason).toEqual(['room-unavailable']);
      expect(errors.debit).toEqual(['refunded']);
    });

    it('lit le paiement par la route de service, jamais avec un Bearer', async () => {
      pms.post.mockRejectedValueOnce(roomTaken());

      await failure();

      expect(pms.get).toHaveBeenCalledWith(
        `/reservations/${RESERVATION_ID}/payment`,
        expect.objectContaining({
          headers: { 'X-Service-Key': 'svc-key-test' },
        }),
      );
      const [, ctx] = pms.get.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(ctx).not.toHaveProperty('bearerToken');
    });

    it('lecture du paiement en échec : le motif reste, aucun statut de débit inventé', async () => {
      pms.post.mockRejectedValueOnce(roomTaken());
      pms.get.mockRejectedValue(new PmsUnavailableError('down'));

      const { err, errors } = await failure();

      expect(err).toBeInstanceOf(ConflictException);
      expect(errors.reason).toEqual(['room-unavailable']);
      expect(errors).not.toHaveProperty('debit');
    });

    it('la réservation est morte : le hold est libéré (best-effort), jamais seulement oublié', async () => {
      pms.post.mockRejectedValueOnce(roomTaken());

      await failure();

      expect(holds.release).toHaveBeenCalledWith(RESERVATION_ID);
    });

    it('libération du hold en panne : le motif est quand même rendu', async () => {
      pms.post.mockRejectedValueOnce(roomTaken());
      holds.release.mockRejectedValue(new ServiceUnavailableException());

      const { errors } = await failure();

      expect(errors.reason).toEqual(['room-unavailable']);
    });

    it.each([
      [5, 'none'],
      [6, 'refunded'],
      [3, 'captured'],
    ])(
      'réservation annulée relue (paiement %i) → reservation-cancelled, débit « %s »',
      async (status, debit) => {
        booking.getReservation.mockResolvedValue(
          reservation({ status: 'Cancelled' }),
        );
        pms.get.mockResolvedValue(paymentState({ status }));

        const { errors } = await failure();

        expect(errors.reason).toEqual(['reservation-cancelled']);
        expect(errors.debit).toEqual([debit]);
        expect(pms.post).not.toHaveBeenCalled();
      },
    );

    it('réservation annulée sans aucun paiement → « aucun débit »', async () => {
      booking.getReservation.mockResolvedValue(
        reservation({ status: 'Cancelled' }),
      );

      const { errors } = await failure();

      expect(errors.debit).toEqual(['none']);
    });
  });

  describe('D10 — langue de communication', () => {
    it('reste en repli hotel_default_fallback : jamais « applied » tant que D10 n’est pas livrée', async () => {
      const proof = await service.confirm(session, RESERVATION_ID);

      expect(proof.communicationLocaleState).toBe('hotel_default_fallback');
    });

    it('une langue inconnue reste inconnue (null), sans valeur par défaut inventée', async () => {
      booking.getReservation.mockResolvedValue(
        reservation({ status: 'Confirmed', communicationLocale: null }),
      );

      const proof = await service.confirm(session, RESERVATION_ID);

      expect(proof.communicationLocale).toBeNull();
    });
  });
});
