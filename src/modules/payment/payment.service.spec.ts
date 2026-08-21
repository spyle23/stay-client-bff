import { ServiceUnavailableException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { CorrelationService } from '../../common/correlation/correlation.service';
import type { RequestSession } from '../../common/decorators/current-session.decorator';
import { PmsClientService } from '../../integration/pms/pms-client.service';
import { PmsRequestError } from '../../integration/pms/pms-errors';
import { SessionService } from '../auth/session.service';
import { BookingService } from '../booking/booking.service';
import { CheckoutHoldService } from '../booking/checkout-hold.service';
import type { BookingReservationDto } from '../booking/dto/reservation.dto';
import { PaymentService } from './payment.service';

/**
 * Story 3.1 — module `payment` du BFF.
 *
 * Les scénarios sont écrits autour des trois invariants que la story impose, pas autour des méthodes :
 * l'ORDRE du gel de hold, le contrôle de montant, et la traduction des refus PMS.
 */
describe('PaymentService', () => {
  let service: PaymentService;
  let pms: { post: jest.Mock };
  let sessions: { withCustomerAuth: jest.Mock };
  let booking: { getReservation: jest.Mock };
  let holds: {
    markPaymentStarted: jest.Mock;
    clearPaymentStarted: jest.Mock;
  };

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

  const RESERVATION_ID = '11111111-1111-4111-8111-111111111111';

  /** Réservation `Pending` de 45,00 € (4500 unités mineures) — le cas nominal du tunnel. */
  const pendingReservation = (
    overrides: Partial<BookingReservationDto> = {},
  ): BookingReservationDto =>
    ({
      reservationId: RESERVATION_ID,
      reservationCode: 'RES-20260820-ABCDE',
      status: 'Pending',
      currency: 'EUR',
      total: 4500,
      ...overrides,
    }) as BookingReservationDto;

  // ⚠️ Les valeurs Stripe de ces fixtures évitent DÉLIBÉRÉMENT les formats réels
  // (`pi_…_secret_…`, `pk_test_…`) : ces gabarits sont reconnus par les scanners de secrets, qui
  // alertent sur un dépôt même quand la valeur est inventée. Un faux positif récurrent finit par
  // être ignoré — et c'est le jour où l'alerte est vraie qu'on le paie.
  /** Réponse nominale du PMS pour cette réservation. */
  const pmsIntent = (overrides: Record<string, unknown> = {}) => ({
    data: {
      paymentId: '22222222-2222-4222-8222-222222222222',
      clientSecret: 'fake-intent-client-secret',
      paymentIntentId: 'fake-intent-id',
      amountInCents: 4500,
      currency: 'eur',
      publishableKey: 'fake-publishable-key',
      captureMethod: 'manual',
      ...overrides,
    },
  });

  beforeEach(async () => {
    pms = { post: jest.fn() };
    sessions = {
      // Reproduit fidèlement le contrat : la fonction reçoit un jeton et son résultat est renvoyé.
      withCustomerAuth: jest.fn(
        (_sid: string, fn: (token: string) => Promise<unknown>) =>
          fn('access-token'),
      ),
    };
    booking = { getReservation: jest.fn() };
    holds = {
      markPaymentStarted: jest.fn().mockResolvedValue(undefined),
      clearPaymentStarted: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PmsClientService, useValue: pms },
        { provide: SessionService, useValue: sessions },
        { provide: BookingService, useValue: booking },
        { provide: CheckoutHoldService, useValue: holds },
        {
          provide: CorrelationService,
          useValue: { getCorrelationId: () => 'corr-1' },
        },
      ],
    }).compile();

    service = module.get(PaymentService);
  });

  /** Clés d'idempotence réellement posées sur le fil, dans l'ordre des appels. */
  const idempotencyKeys = (): string[] =>
    pms.post.mock.calls.map((call: unknown[]) => {
      const context = call[2] as { idempotencyKey: string };
      return context.idempotencyKey;
    });

  describe('createIntent — cas nominal', () => {
    beforeEach(() => {
      booking.getReservation.mockResolvedValue(pendingReservation());
      pms.post.mockResolvedValue(pmsIntent());
    });

    it('projette le strict nécessaire au Payment Element, sans le paymentId du PMS', async () => {
      const result = await service.createIntent(session, RESERVATION_ID);

      expect(result).toEqual({
        clientSecret: 'fake-intent-client-secret',
        publishableKey: 'fake-publishable-key',
        paymentIntentId: 'fake-intent-id',
        amount: 4500,
        currency: 'EUR',
        captureMethod: 'manual',
      });
      // Le navigateur n'a aucun usage du paymentId en 3.1 ; il sert à la réconciliation (3.4).
      expect(result).not.toHaveProperty('paymentId');
    });

    it('rapporte le mode de capture du PMS au lieu de le supposer', async () => {
      pms.post.mockResolvedValue(pmsIntent({ captureMethod: 'automatic' }));

      const result = await service.createIntent(session, RESERVATION_ID);

      // Si le PMS repassait en capture automatique, le front doit CESSER de promettre
      // « aucun débit ferme » — pas continuer à l'afficher.
      expect(result.captureMethod).toBe('automatic');
    });

    it("n'autorise aucun rejeu automatique de l'écriture (maxRetries: 0)", async () => {
      await service.createIntent(session, RESERVATION_ID);

      expect(pms.post).toHaveBeenCalledWith(
        '/payments/room-reservation/intent',
        { roomReservationId: RESERVATION_ID },
        expect.objectContaining({ maxRetries: 0, bearerToken: 'access-token' }),
      );
    });

    it("pose une clé d'idempotence stable entre deux appels identiques", async () => {
      await service.createIntent(session, RESERVATION_ID);
      await service.createIntent(session, RESERVATION_ID);

      const [first, second] = idempotencyKeys();
      expect(first).toBe(second);
      // Jamais l'identifiant de session en clair sur le fil.
      expect(first).not.toContain(session.sid);
    });

    it("distingue deux réservations par leur clé d'idempotence", async () => {
      const other = '33333333-3333-4333-8333-333333333333';
      booking.getReservation.mockResolvedValue(
        pendingReservation({ reservationId: other }),
      );

      await service.createIntent(session, RESERVATION_ID);
      await service.createIntent(session, other);

      const [first, second] = idempotencyKeys();
      expect(first).not.toBe(second);
    });
  });

  describe('FR-14 — le hold est gelé AVANT que le clientSecret ne parte', () => {
    it('marque paymentStarted avant de demander l’intent au PMS', async () => {
      const order: string[] = [];
      booking.getReservation.mockResolvedValue(pendingReservation());
      holds.markPaymentStarted.mockImplementation(() => {
        order.push('mark');
        return Promise.resolve();
      });
      pms.post.mockImplementation(() => {
        order.push('pms');
        return Promise.resolve(pmsIntent());
      });

      await service.createIntent(session, RESERVATION_ID);

      // L'ORDRE est l'invariant, pas le simple fait d'appeler : marquer après coup laisserait une
      // fenêtre pendant laquelle le balayeur annulerait une réservation en cours de paiement.
      expect(order).toEqual(['mark', 'pms']);
    });

    it('ne renvoie aucun clientSecret si le gel échoue (Redis indisponible)', async () => {
      booking.getReservation.mockResolvedValue(pendingReservation());
      holds.markPaymentStarted.mockRejectedValue(
        new ServiceUnavailableException('Redis indisponible'),
      );

      await expect(
        service.createIntent(session, RESERVATION_ID),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // Émettre un intent que le balayeur peut encore annuler serait pire qu'un refus.
      expect(pms.post).not.toHaveBeenCalled();
    });
  });

  describe('revue de code — gel relâché sur un refus antérieur à tout appel Stripe', () => {
    beforeEach(() => {
      booking.getReservation.mockResolvedValue(pendingReservation());
    });

    /**
     * Le gel est posé AVANT l'appel PMS (décision D-2), ce qui est le seul instant sûr. Mais un
     * refus déterministe laissait la chambre immobilisée pour toujours : le balayeur ne touche plus
     * jamais un hold marqué, et le PMS n'a pas de filet d'expiration (dépendance D3).
     */
    it.each([
      [
        'currency-unsupported',
        'The hotel currency is not supported for card payment',
      ],
      [
        'reservation-not-pending',
        'This reservation is no longer awaiting payment',
      ],
    ])('relâche le gel quand le PMS refuse pour %s', async (_reason, text) => {
      pms.post.mockRejectedValue(
        new PmsRequestError('Le PMS a renvoyé le statut 400', 400, {
          errors: [text],
        }),
      );

      await expect(
        service.createIntent(session, RESERVATION_ID),
      ).rejects.toBeDefined();

      expect(holds.clearPaymentStarted).toHaveBeenCalledWith(RESERVATION_ID);
    });

    it('NE relâche PAS le gel quand le paiement est déjà autorisé', async () => {
      pms.post.mockRejectedValue(
        new PmsRequestError('Le PMS a renvoyé le statut 400', 400, {
          errors: ['A payment is already engaged for this reservation'],
        }),
      );

      await expect(
        service.createIntent(session, RESERVATION_ID),
      ).rejects.toBeDefined();

      // Un paiement EXISTE : relâcher le gel ferait annuler une réservation payée par le balayeur.
      expect(holds.clearPaymentStarted).not.toHaveBeenCalled();
    });

    it('NE relâche PAS le gel sur une panne (le doute profite au paiement)', async () => {
      pms.post.mockRejectedValue(new PmsRequestError('PMS indisponible', 503));

      await expect(
        service.createIntent(session, RESERVATION_ID),
      ).rejects.toBeDefined();

      expect(holds.clearPaymentStarted).not.toHaveBeenCalled();
    });
  });

  describe('AC-5 — contrôle de montant', () => {
    it('refuse un montant PMS divergent du total de la réservation', async () => {
      booking.getReservation.mockResolvedValue(pendingReservation());
      pms.post.mockResolvedValue(pmsIntent({ amountInCents: 9900 }));

      await expect(
        service.createIntent(session, RESERVATION_ID),
      ).rejects.toMatchObject({
        response: { errors: { reason: ['amount-mismatch'] } },
      });
    });

    it('refuse une devise divergente, même à montant identique', async () => {
      // Deux devises de même exposant donnent des unités mineures numériquement identiques :
      // sans contrôle de devise, 168 CHF étaient autorisés pour un séjour affiché à 168 €.
      booking.getReservation.mockResolvedValue(
        pendingReservation({ total: 4500, currency: 'EUR' }),
      );
      pms.post.mockResolvedValue(
        pmsIntent({ amountInCents: 4500, currency: 'chf' }),
      );

      await expect(
        service.createIntent(session, RESERVATION_ID),
      ).rejects.toMatchObject({
        response: { errors: { reason: ['amount-mismatch'] } },
      });
    });

    it('accepte un montant identique au centime', async () => {
      booking.getReservation.mockResolvedValue(
        pendingReservation({ total: 12500, currency: 'KWD' }),
      );
      pms.post.mockResolvedValue(
        pmsIntent({ amountInCents: 12500, currency: 'kwd' }),
      );

      const result = await service.createIntent(session, RESERVATION_ID);

      expect(result.amount).toBe(12500);
      expect(result.currency).toBe('KWD');
    });
  });

  describe('AC-8 — seule une réservation Pending est payable', () => {
    it.each(['Confirmed', 'Cancelled', 'CheckedIn', 'Unknown'] as const)(
      'refuse une réservation %s',
      async (status) => {
        booking.getReservation.mockResolvedValue(
          pendingReservation({ status }),
        );

        await expect(
          service.createIntent(session, RESERVATION_ID),
        ).rejects.toMatchObject({
          response: { errors: { reason: ['reservation-not-pending'] } },
        });

        // Ni gel, ni appel PMS : rien ne doit bouger sur une réservation qu'on ne paiera pas.
        expect(holds.markPaymentStarted).not.toHaveBeenCalled();
        expect(pms.post).not.toHaveBeenCalled();
      },
    );
  });

  describe('classification des refus PMS', () => {
    beforeEach(() => {
      booking.getReservation.mockResolvedValue(pendingReservation());
    });

    it('traduit « already been settled » en already-authorized', async () => {
      pms.post.mockRejectedValue(
        new PmsRequestError('Le PMS a renvoyé le statut 400', 400, {
          errors: ['A payment has already been settled for this reservation'],
        }),
      );

      await expect(
        service.createIntent(session, RESERVATION_ID),
      ).rejects.toMatchObject({
        response: { errors: { reason: ['already-authorized'] } },
      });
    });

    it('laisse remonter une panne PMS au lieu de la présenter comme un refus', async () => {
      const outage = new PmsRequestError('PMS indisponible', 503);
      pms.post.mockRejectedValue(outage);

      // Un 503 doit rester un 503 : dire « paiement refusé » ferait croire à une carte rejetée.
      await expect(service.createIntent(session, RESERVATION_ID)).rejects.toBe(
        outage,
      );
    });

    it('traite un 429 comme une panne, pas comme un refus métier', async () => {
      const throttled = new PmsRequestError('Trop de requêtes', 429);
      pms.post.mockRejectedValue(throttled);

      await expect(service.createIntent(session, RESERVATION_ID)).rejects.toBe(
        throttled,
      );
    });

    it('classe un 401 du PMS en session-invalid', async () => {
      pms.post.mockRejectedValue(new PmsRequestError('Non autorisé', 401));

      await expect(
        service.createIntent(session, RESERVATION_ID),
      ).rejects.toMatchObject({
        response: { errors: { reason: ['session-invalid'] } },
      });
    });

    it('classe une devise non encaissable en currency-unsupported', async () => {
      pms.post.mockRejectedValue(
        new PmsRequestError('Le PMS a renvoyé le statut 400', 400, {
          errors: {
            '': ['The hotel currency is not supported for card payment'],
          },
        }),
      );

      await expect(
        service.createIntent(session, RESERVATION_ID),
      ).rejects.toMatchObject({
        response: { errors: { reason: ['currency-unsupported'] } },
      });
    });
  });

  describe('rupture de contrat PMS', () => {
    beforeEach(() => {
      booking.getReservation.mockResolvedValue(pendingReservation());
    });

    it.each([
      ['clientSecret', { clientSecret: null }],
      ['publishableKey', { publishableKey: null }],
      ['paymentIntentId', { paymentIntentId: null }],
      ['amountInCents', { amountInCents: null }],
      ['currency', { currency: null }],
    ])('échoue franchement quand %s manque', async (_label, missing) => {
      pms.post.mockResolvedValue(pmsIntent(missing));

      // Un intent amputé ne pourrait jamais être confirmé par le navigateur : mieux vaut un échec
      // net qu'un Payment Element qui tombe sur un message Stripe opaque.
      await expect(
        service.createIntent(session, RESERVATION_ID),
      ).rejects.toThrow();
    });
  });
});
