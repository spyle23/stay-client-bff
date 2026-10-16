import { Logger, UnauthorizedException } from '@nestjs/common';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { PmsClientService } from '../../integration/pms/pms-client.service';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import type { ServiceKeyProvider } from '../../integration/pms/service-key.provider';
import type { SessionService } from '../auth/session.service';
import type { BookingOptions } from './booking.constants';
import type { CheckoutHoldService } from './checkout-hold.service';
import { INTENT_MEMBER_PREFIX } from './checkout-hold.service';
import { CheckoutHoldSweeper } from './checkout-hold.sweeper';

const RESERVATION_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_RESERVATION_ID = '77777777-7777-7777-7777-777777777777';
const ROOM_ID = '22222222-2222-2222-2222-222222222222';
const INTENT_ID = '55555555-5555-5555-5555-555555555555';
const INTENT_MEMBER = `${INTENT_MEMBER_PREFIX}${INTENT_ID}`;

const CHECK_IN = '2026-09-01';
const CHECK_OUT = '2026-09-03';

const options: BookingOptions = {
  maxStayNights: 90,
  holdTtlSeconds: 900,
  holdRecordGraceSeconds: 3600,
  stayLockTtlMs: 90_000,
  lockWaitTimeoutMs: 5_000,
  lockPollIntervalMs: 100,
  sweeperIntervalMs: 60_000,
  sweeperBatchSize: 50,
  sweeperMaxAttempts: 3,
  sweeperRetryDelayMs: 60_000,
  sweeperEnabled: false,
  pmsCallBudgetMs: 24_750,
  intentReconcileDelayMs: 90_000,
  communicationLocaleTtlSeconds: 172_800,
  paymentWindowSeconds: 1_800,
};

function holdRecord(overrides: Record<string, unknown> = {}) {
  return {
    reservationId: RESERVATION_ID,
    sid: 'sid-1',
    userId: 'user-1',
    hotelId: 'hotel-1',
    roomId: ROOM_ID,
    expiresAt: Date.now() - 1_000,
    stayKey: 'booking:idem:v1:abc',
    paymentStarted: false,
    attempts: 0,
    ...overrides,
  };
}

function intentRecord(overrides: Record<string, unknown> = {}) {
  return {
    intentId: INTENT_ID,
    sid: 'sid-1',
    userId: 'user-1',
    hotelId: 'hotel-1',
    roomId: ROOM_ID,
    checkInDate: CHECK_IN,
    checkOutDate: CHECK_OUT,
    guests: 2,
    stayKey: 'booking:idem:v1:abc',
    reconcileAt: Date.now() - 1_000,
    attempts: 0,
    ...overrides,
  };
}

/** Réponse `my-reservations` du PMS — paginée, montants décimaux, dates en datetime. */
function myReservations(items: Record<string, unknown>[], hasNextPage = false) {
  return {
    success: true,
    data: items,
    pagination: { page: 1, pageSize: 100, hasNextPage },
  };
}

/** La réservation `Pending` orpheline que la réconciliation doit retrouver. */
function orphanReservation(overrides: Record<string, unknown> = {}) {
  return {
    id: RESERVATION_ID,
    roomId: ROOM_ID,
    checkInDate: `${CHECK_IN}T00:00:00Z`,
    checkOutDate: `${CHECK_OUT}T00:00:00Z`,
    status: 1,
    ...overrides,
  };
}

/** Paiement lu par la route de service `GET /reservations/{id}/payment` (#153). */
function payment(overrides: Record<string, unknown> = {}) {
  return {
    paymentId: '99999999-9999-4999-8999-999999999999',
    status: 1,
    amount: 168,
    currency: 'EUR',
    intentStatus: 'requires_payment_method',
    amountCapturable: 0,
    amountReceived: 0,
    stripeReadable: true,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    paidAt: null,
    ...overrides,
  };
}

/**
 * #187 — refus de l'annulation « abandon seulement », tel que `PmsClientService.toRequestError` le
 * produit du corps réel du PMS (`ApiResponse.Fail` : texte dans `errors`, `message` à `null`).
 */
function abandonRefused(
  text = 'Cannot abandon a reservation whose payment is engaged',
): PmsRequestError {
  return new PmsRequestError('Le PMS a renvoyé le statut 409.', 409, {
    errors: [text],
    responseBody: { success: false, data: null, message: null, errors: [text] },
  });
}

/**
 * Aiguille les lectures PMS par chemin : la réservation (JWT du voyageur) et son paiement (route
 * de service). `payment: null` simule une réservation sans aucune ligne `Payment`.
 */
function routePms(
  deps: ReturnType<typeof makeDeps>,
  setup: {
    status?: number;
    payment?: Record<string, unknown> | null;
    paymentError?: Error;
  },
): void {
  deps.get.mockImplementation((path: string) => {
    if (path.endsWith('/payment')) {
      if (setup.paymentError) {
        return Promise.reject(setup.paymentError);
      }
      return Promise.resolve({
        success: true,
        data: { reservationId: RESERVATION_ID, payment: setup.payment ?? null },
      });
    }
    return Promise.resolve({
      success: true,
      data: { status: setup.status ?? 1 },
    });
  });
}

function makeDeps() {
  return {
    acquireSweeperLock: jest.fn().mockResolvedValue('sweep-token'),
    releaseSweeperLock: jest.fn().mockResolvedValue(undefined),
    dueHolds: jest.fn().mockResolvedValue([RESERVATION_ID]),
    read: jest.fn().mockResolvedValue(holdRecord()),
    release: jest.fn().mockResolvedValue(undefined),
    forget: jest.fn().mockResolvedValue(undefined),
    reschedule: jest.fn().mockResolvedValue(1),
    readIntent: jest.fn().mockResolvedValue(intentRecord()),
    dropIntent: jest.fn().mockResolvedValue(undefined),
    rescheduleIntent: jest.fn().mockResolvedValue(1),
    clearIdempotentKey: jest.fn().mockResolvedValue(undefined),
    defer: jest.fn().mockResolvedValue(true),
    get: jest.fn().mockResolvedValue({ success: true, data: { status: 1 } }),
    getList: jest.fn().mockResolvedValue(myReservations([orphanReservation()])),
    post: jest.fn().mockResolvedValue({ success: true, data: undefined }),
    // `withCustomerAuth` est la SEULE porte d'appel PMS authentifié : le double le reproduit
    // fidèlement (il résout la session PUIS exécute l'opération avec le jeton obtenu).
    withCustomerAuth: jest.fn(
      (_sid: string, fn: (token: string) => Promise<unknown>) => fn('jeton'),
    ),
    // Lecture de service (#5) : le double marque le contexte pour prouver la route empruntée.
    serviceContext: jest.fn(
      (method: string, path: string, extra?: Record<string, unknown>) => ({
        ...extra,
        headers: { 'X-Service-Key': `service:${method} ${path}` },
      }),
    ),
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
    doesExist: jest.fn().mockReturnValue(true),
  };
}

function buildSweeper(
  deps: ReturnType<typeof makeDeps>,
  overrides: Partial<BookingOptions> = {},
): CheckoutHoldSweeper {
  return new CheckoutHoldSweeper(
    {
      acquireSweeperLock: deps.acquireSweeperLock,
      releaseSweeperLock: deps.releaseSweeperLock,
      dueHolds: deps.dueHolds,
      read: deps.read,
      release: deps.release,
      forget: deps.forget,
      reschedule: deps.reschedule,
      readIntent: deps.readIntent,
      dropIntent: deps.dropIntent,
      rescheduleIntent: deps.rescheduleIntent,
      clearIdempotentKey: deps.clearIdempotentKey,
      defer: deps.defer,
    } as unknown as CheckoutHoldService,
    { withCustomerAuth: deps.withCustomerAuth } as unknown as SessionService,
    {
      get: deps.get,
      getList: deps.getList,
      post: deps.post,
    } as unknown as PmsClientService,
    { serviceContext: deps.serviceContext } as unknown as ServiceKeyProvider,
    {
      addInterval: deps.addInterval,
      deleteInterval: deps.deleteInterval,
      doesExist: deps.doesExist,
    } as unknown as SchedulerRegistry,
    { ...options, ...overrides },
  );
}

describe('CheckoutHoldSweeper', () => {
  let deps: ReturnType<typeof makeDeps>;
  let sweeper: CheckoutHoldSweeper;

  beforeEach(() => {
    deps = makeDeps();
    sweeper = buildSweeper(deps);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('libération nominale (AC-6)', () => {
    it('annule une `Pending` échue puis retire le hold', async () => {
      await sweeper.sweep();

      expect(deps.post).toHaveBeenCalledWith(
        `/roomreservations/${RESERVATION_ID}/cancel?abandonOnly=true`,
        undefined,
        expect.objectContaining({ bearerToken: 'jeton' }),
      );
      expect(deps.release).toHaveBeenCalledWith(RESERVATION_ID);
    });

    it('#187 AC-2 : abandon refusé par le PMS (paiement engagé entre-temps) → hold oublié, sans report', async () => {
      deps.post.mockRejectedValue(abandonRefused());

      await sweeper.sweep();

      expect(deps.forget).toHaveBeenCalledWith(RESERVATION_ID);
      expect(deps.release).not.toHaveBeenCalled();
      expect(deps.reschedule).not.toHaveBeenCalled();
    });

    it('relit la réservation avec le JWT du propriétaire (via le `sid` mémorisé)', async () => {
      await sweeper.sweep();
      expect(deps.get).toHaveBeenCalledWith(
        `/roomreservations/${RESERVATION_ID}`,
        expect.objectContaining({ bearerToken: 'jeton' }),
      );
    });

    it('borne le lot au paramètre configuré', async () => {
      await sweeper.sweep();
      expect(deps.dueHolds).toHaveBeenCalledWith(
        expect.any(Number),
        options.sweeperBatchSize,
      );
    });

    /**
     * Une annulation automatique laisse une trace EN BASE côté Stay-api. Sans corrélation, elle y
     * est indistinguable d'une annulation faite par un humain : l'identifiant de passe doit donc
     * atteindre le PMS, pas seulement les logs du BFF.
     */
    it('propage l’identifiant de passe au PMS en X-Correlation-ID', async () => {
      await sweeper.sweep();

      const read = deps.get.mock.calls[0] as unknown as [
        string,
        { correlationId?: string },
      ];
      const cancel = deps.post.mock.calls[0] as unknown as [
        string,
        undefined,
        { correlationId?: string },
      ];
      expect(read[1].correlationId).toMatch(/^sweeper-/);
      // Même passe, même corrélation : la lecture et l'annulation doivent être rattachables.
      expect(cancel[2].correlationId).toBe(read[1].correlationId);
    });
  });

  describe('invariant FR-14 — ne jamais annuler une réservation payée (AC-7)', () => {
    it('n’annule JAMAIS une réservation `Confirmed`', async () => {
      deps.get.mockResolvedValue({ success: true, data: { status: 2 } });

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.forget).toHaveBeenCalledWith(RESERVATION_ID);
      // `forget` retire l'index sans purger l'idempotence : la réservation est aboutie.
      expect(deps.release).not.toHaveBeenCalled();
    });

    it.each([
      ['CheckedIn', 3],
      ['CheckedOut', 4],
    ])('n’annule JAMAIS une réservation %s', async (_label, status) => {
      deps.get.mockResolvedValue({ success: true, data: { status } });
      await sweeper.sweep();
      expect(deps.post).not.toHaveBeenCalled();
    });

    it('n’annule JAMAIS un hold dont l’autorisation est acquise (seam story 3.1)', async () => {
      deps.read.mockResolvedValue(
        holdRecord({
          paymentStarted: true,
          intentIssued: true,
          intentIssuedAt: Date.now() - 7_200_000,
        }),
      );
      routePms(deps, {
        payment: payment({ intentStatus: 'requires_capture' }),
      });

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.release).not.toHaveBeenCalled();
    });

    /**
     * Un statut absent, `null` ou hors table est un **doute**, pas une permission. La garde
     * précédente ne testait que `undefined` : `null` et tout code non répertorié tombaient dans
     * la branche « statut reconnu non-`Pending` » → hold retiré **sans annulation ni alerte**,
     * l'exact contraire de l'invariant documenté en tête de fichier.
     */
    it.each([
      ['statut absent', { success: true, data: undefined }],
      ['statut null', { success: true, data: { status: null } }],
      ['code hors table', { success: true, data: { status: 99 } }],
      ['corps sans statut', { success: true, data: {} }],
    ])('reporte plutôt que d’annuler quand le %s', async (_label, response) => {
      deps.get.mockResolvedValue(response);

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      // Ni annulation, ni oubli silencieux : l'entrée reste suivie.
      expect(deps.forget).not.toHaveBeenCalled();
      expect(deps.release).not.toHaveBeenCalled();
      expect(deps.reschedule).toHaveBeenCalledWith(
        RESERVATION_ID,
        expect.any(Number),
      );
    });

    it('reporte plutôt que d’annuler quand le PMS est injoignable', async () => {
      deps.get.mockRejectedValue(new PmsUnavailableError('panne'));

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.reschedule).toHaveBeenCalled();
    });

    it('purge complètement un hold dont la réservation est déjà `Cancelled`', async () => {
      deps.get.mockResolvedValue({ success: true, data: { status: 5 } });

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      // `release` purge aussi l'idempotence : un rejeu de création doit repartir de zéro.
      expect(deps.release).toHaveBeenCalledWith(RESERVATION_ID);
    });

    /**
     * TOCTOU : l'enregistrement est lu AVANT l'aller-retour PMS. La story 3.1 peut poser
     * `paymentStarted` pendant ce trajet — décider sur l'état périmé annulerait une réservation
     * dont le paiement vient de démarrer.
     */
    it('relit l’enregistrement juste avant l’annulation et renonce si un paiement a démarré', async () => {
      deps.read
        .mockResolvedValueOnce(holdRecord())
        .mockResolvedValue(holdRecord({ paymentStarted: true }));

      await sweeper.sweep();

      expect(deps.get).toHaveBeenCalled(); // le statut `Pending` a bien été constaté
      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.release).not.toHaveBeenCalled();
      // #4 : le hold reste suivi (fin du `forget` immédiat) ; la passe suivante lira le paiement.
      expect(deps.forget).not.toHaveBeenCalled();
      expect(deps.defer).toHaveBeenCalledWith(
        RESERVATION_ID,
        expect.any(Number),
      );
      expect(deps.reschedule).not.toHaveBeenCalled();
    });

    it('renonce à annuler si l’enregistrement disparaît pendant la passe (doute)', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.read.mockResolvedValueOnce(holdRecord()).mockResolvedValue(null);

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('Intervention manuelle requise'),
      );
    });
  });

  /**
   * #4 (story 3.3) — formulaire de paiement abandonné. Le hold `paymentStarted` reste dans l'index
   * jusqu'à son issue : le balayeur lit le paiement au PMS (route de service de #153) et n'annule
   * qu'un intent resté en attente du voyageur au-delà de la fenêtre de paiement.
   */
  describe('fenêtre de paiement (#4, AC-2, AC-3, AC-9)', () => {
    const WINDOW_MS = options.paymentWindowSeconds * 1000;
    const paymentPath = `/reservations/${RESERVATION_ID}/payment`;

    /** Hold dont l'intent a été émis il y a `ageMs`. */
    function issuedHold(
      ageMs: number,
      overrides: Record<string, unknown> = {},
    ) {
      return holdRecord({
        paymentStarted: true,
        intentIssued: true,
        paymentStartedAt: Date.now() - ageMs - 1_000,
        intentIssuedAt: Date.now() - ageMs,
        ...overrides,
      });
    }

    it.each([
      'requires_payment_method',
      'requires_confirmation',
      'requires_action',
    ])(
      'AC-2 : intent `%s` au-delà de la fenêtre → annulation sous JWT du voyageur, hold libéré',
      async (intentStatus) => {
        deps.read.mockResolvedValue(issuedHold(WINDOW_MS + 1_000));
        routePms(deps, { payment: payment({ intentStatus }) });

        await sweeper.sweep();

        expect(deps.post).toHaveBeenCalledWith(
          `/roomreservations/${RESERVATION_ID}/cancel?abandonOnly=true`,
          undefined,
          expect.objectContaining({ bearerToken: 'jeton' }),
        );
        expect(deps.release).toHaveBeenCalledWith(RESERVATION_ID);
      },
    );

    it('AC-2 : lit le paiement par la route de service, jamais avec le JWT du voyageur', async () => {
      deps.read.mockResolvedValue(issuedHold(WINDOW_MS + 1_000));
      routePms(deps, { payment: payment() });

      await sweeper.sweep();

      const [method, path, extra] = deps.serviceContext.mock.calls[0] as [
        string,
        string,
        { correlationId?: string },
      ];
      expect(method).toBe('GET');
      expect(path).toBe(paymentPath);
      expect(extra.correlationId).toMatch(/^sweeper-/);
      const read = deps.get.mock.calls.find(
        ([path]) => path === paymentPath,
      ) as unknown as [string, Record<string, unknown>];
      expect(read[1]).not.toHaveProperty('bearerToken');
      expect(read[1]).toHaveProperty('headers');
    });

    it('AC-2 : avant la fin de la fenêtre, attend son échéance sans compter de tentative', async () => {
      const hold = issuedHold(60_000);
      deps.read.mockResolvedValue(hold);
      routePms(deps, { payment: payment() });

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.forget).not.toHaveBeenCalled();
      expect(deps.reschedule).not.toHaveBeenCalled();
      expect(deps.defer).toHaveBeenCalledWith(
        RESERVATION_ID,
        ((hold as Record<string, unknown>).intentIssuedAt as number) +
          WINDOW_MS,
      );
    });

    it('AC-2 : la fenêtre part de l’émission de l’intent, pas de la pose du gel', async () => {
      // Gel posé il y a longtemps, intent émis il y a 1 min : la fenêtre n'est pas écoulée.
      deps.read.mockResolvedValue(
        issuedHold(60_000, { paymentStartedAt: Date.now() - 2 * WINDOW_MS }),
      );
      routePms(deps, { payment: payment() });

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
    });

    it('AC-2 : un intent déjà annulé chez Stripe se libère aussi à la fin de la fenêtre', async () => {
      deps.read.mockResolvedValue(issuedHold(WINDOW_MS + 1_000));
      routePms(deps, {
        payment: payment({ intentStatus: 'canceled', status: 5 }),
      });

      await sweeper.sweep();

      expect(deps.post).toHaveBeenCalledWith(
        `/roomreservations/${RESERVATION_ID}/cancel?abandonOnly=true`,
        undefined,
        expect.anything(),
      );
    });

    it.each(['requires_capture', 'succeeded'])(
      'AC-3 : intent `%s` → jamais annulé, laissé à la confirmation et à la réconciliation',
      async (intentStatus) => {
        deps.read.mockResolvedValue(issuedHold(10 * WINDOW_MS));
        routePms(deps, { payment: payment({ intentStatus }) });

        await sweeper.sweep();

        expect(deps.post).not.toHaveBeenCalled();
        expect(deps.release).not.toHaveBeenCalled();
        expect(deps.forget).toHaveBeenCalledWith(RESERVATION_ID);
      },
    );

    it.each([
      ['intent `processing`', { intentStatus: 'processing' }],
      ['Stripe illisible', { intentStatus: null, stripeReadable: false }],
      ['statut d’intent inconnu', { intentStatus: 'requires_unknown_step' }],
    ])(
      'AC-3 : %s → doute, report sans tentative ni annulation',
      async (_label, overrides) => {
        deps.read.mockResolvedValue(issuedHold(10 * WINDOW_MS));
        routePms(deps, { payment: payment(overrides) });

        await sweeper.sweep();

        expect(deps.post).not.toHaveBeenCalled();
        expect(deps.forget).not.toHaveBeenCalled();
        expect(deps.release).not.toHaveBeenCalled();
        expect(deps.reschedule).not.toHaveBeenCalled();
        expect(deps.defer).toHaveBeenCalledWith(
          RESERVATION_ID,
          expect.any(Number),
        );
      },
    );

    it('AC-3 : lecture du paiement en échec → report compté, jamais d’annulation', async () => {
      deps.read.mockResolvedValue(issuedHold(10 * WINDOW_MS));
      routePms(deps, { paymentError: new PmsUnavailableError('panne') });

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.reschedule).toHaveBeenCalledWith(
        RESERVATION_ID,
        expect.any(Number),
      );
    });

    it('intent émis mais aucun paiement lu : doute, jamais d’annulation', async () => {
      deps.read.mockResolvedValue(issuedHold(10 * WINDOW_MS));
      routePms(deps, { payment: null });

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.defer).toHaveBeenCalled();
    });

    it('gel sans intent ni paiement, fenêtre écoulée → annulation (autorisation orpheline)', async () => {
      deps.read.mockResolvedValue(
        holdRecord({
          paymentStarted: true,
          paymentStartedAt: Date.now() - WINDOW_MS - 1_000,
        }),
      );
      routePms(deps, { payment: null });

      await sweeper.sweep();

      expect(deps.post).toHaveBeenCalledWith(
        `/roomreservations/${RESERVATION_ID}/cancel?abandonOnly=true`,
        undefined,
        expect.anything(),
      );
      expect(deps.release).toHaveBeenCalledWith(RESERVATION_ID);
    });

    it('gel sans intent, fenêtre en cours → attente (l’appel d’intent peut être en vol)', async () => {
      const startedAt = Date.now() - 5_000;
      deps.read.mockResolvedValue(
        holdRecord({ paymentStarted: true, paymentStartedAt: startedAt }),
      );
      routePms(deps, { payment: null });

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.defer).toHaveBeenCalledWith(
        RESERVATION_ID,
        startedAt + WINDOW_MS,
      );
    });

    it('hold antérieur au champ : la fenêtre part de la création du paiement au PMS', async () => {
      deps.read.mockResolvedValue(
        holdRecord({ paymentStarted: true, intentIssued: true }),
      );
      const createdAt = Date.now() - 120_000;
      routePms(deps, {
        payment: payment({ createdAt: new Date(createdAt).toISOString() }),
      });

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.defer).toHaveBeenCalledWith(
        RESERVATION_ID,
        createdAt + WINDOW_MS,
      );
    });

    it('AC-9 : réservation relue `Cancelled` (filet 48 h du PMS) → hold et index retirés sans erreur', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.read.mockResolvedValue(issuedHold(10 * WINDOW_MS));
      routePms(deps, { status: 5, payment: payment() });

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.release).toHaveBeenCalledWith(RESERVATION_ID);
      expect(error).not.toHaveBeenCalled();
      // Inutile de lire le paiement d'une réservation déjà libérée.
      expect(deps.get).not.toHaveBeenCalledWith(paymentPath, expect.anything());
    });

    it('réservation relue `Confirmed` → hold retiré de l’index, jamais annulé', async () => {
      deps.read.mockResolvedValue(issuedHold(10 * WINDOW_MS));
      routePms(deps, { status: 2, payment: payment() });

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.forget).toHaveBeenCalledWith(RESERVATION_ID);
      expect(deps.release).not.toHaveBeenCalled();
    });

    /**
     * #187 — course lecture/annulation : le voyageur termine son 3DS entre la lecture du paiement par
     * le balayeur et sa demande d'annulation. Le PMS relit l'intent sous le verrou de ligne et refuse
     * l'abandon (409) : le hold est traité comme un paiement engagé, sans nouvelle tentative.
     */
    it('#187 AC-1 : l’annulation demandée est « abandon seulement »', async () => {
      deps.read.mockResolvedValue(issuedHold(WINDOW_MS + 1_000));
      routePms(deps, { payment: payment({ intentStatus: 'requires_action' }) });

      await sweeper.sweep();

      const [path] = deps.post.mock.calls[0] as unknown as [string];
      expect(path).toBe(
        `/roomreservations/${RESERVATION_ID}/cancel?abandonOnly=true`,
      );
    });

    it('#187 AC-2 : abandon refusé (paiement engagé depuis la lecture) → hold oublié, aucune nouvelle tentative', async () => {
      deps.read.mockResolvedValue(issuedHold(WINDOW_MS + 1_000));
      routePms(deps, { payment: payment({ intentStatus: 'requires_action' }) });
      deps.post.mockRejectedValue(abandonRefused());

      await sweeper.sweep();

      expect(deps.post).toHaveBeenCalledTimes(1);
      expect(deps.forget).toHaveBeenCalledWith(RESERVATION_ID);
      // Ni libération (la réservation vit), ni report, ni attente : le hold sort de l'index.
      expect(deps.release).not.toHaveBeenCalled();
      expect(deps.reschedule).not.toHaveBeenCalled();
      expect(deps.defer).not.toHaveBeenCalled();
    });

    it('#187 AC-2 : la passe suivante ne redemande pas l’annulation d’un hold oublié', async () => {
      deps.read.mockResolvedValue(issuedHold(WINDOW_MS + 1_000));
      routePms(deps, { payment: payment({ intentStatus: 'requires_action' }) });
      deps.post.mockRejectedValue(abandonRefused());
      // L'index ne rend le hold que tant qu'il n'a pas été oublié : un report (au lieu de l'oubli)
      // le laisserait dû, et la passe suivante redemanderait l'annulation.
      deps.dueHolds.mockImplementation(() =>
        Promise.resolve(
          deps.forget.mock.calls.length === 0 ? [RESERVATION_ID] : [],
        ),
      );

      await sweeper.sweep();
      await sweeper.sweep();

      expect(deps.forget).toHaveBeenCalledWith(RESERVATION_ID);
      expect(deps.post).toHaveBeenCalledTimes(1);
    });

    it('#187 : un autre 409 du PMS n’est pas un paiement engagé → report compté', async () => {
      deps.read.mockResolvedValue(issuedHold(WINDOW_MS + 1_000));
      routePms(deps, { payment: payment({ intentStatus: 'requires_action' }) });
      deps.post.mockRejectedValue(abandonRefused('Some other conflict'));

      await sweeper.sweep();

      expect(deps.forget).not.toHaveBeenCalled();
      expect(deps.reschedule).toHaveBeenCalledWith(
        RESERVATION_ID,
        expect.any(Number),
      );
    });

    it('AC-4 : annulation refusée par le PMS (libération Stripe en échec) → report, hold conservé', async () => {
      deps.read.mockResolvedValue(issuedHold(WINDOW_MS + 1_000));
      routePms(deps, { payment: payment() });
      deps.post.mockRejectedValue(
        new PmsUnavailableError('502', undefined, {
          status: 502,
          body: {
            success: false,
            errors: ['The payment of this reservation could not be released'],
          },
        }),
      );

      await sweeper.sweep();

      expect(deps.release).not.toHaveBeenCalled();
      expect(deps.reschedule).toHaveBeenCalledWith(
        RESERVATION_ID,
        expect.any(Number),
      );
    });
  });

  describe('robustesse (AC-7)', () => {
    it('ne perd pas l’entrée quand l’annulation échoue : elle est reportée', async () => {
      deps.post.mockRejectedValue(new PmsUnavailableError('annulation KO'));

      await sweeper.sweep();

      expect(deps.reschedule).toHaveBeenCalledWith(
        RESERVATION_ID,
        expect.any(Number),
      );
      expect(deps.release).not.toHaveBeenCalled();
    });

    /**
     * Chemin réel d'une session disparue : `withCustomerAuth` lève **avant** d'exécuter
     * l'opération — le PMS n'est jamais appelé. L'ancien test injectait l'erreur sur `pms.get`,
     * ce qui modélisait un PMS en panne, pas une session perdue.
     */
    it('reporte quand la session du propriétaire a disparu (le PMS n’est même pas appelé)', async () => {
      deps.withCustomerAuth.mockRejectedValue(
        new UnauthorizedException('Session expirée.'),
      );

      await sweeper.sweep();

      expect(deps.get).not.toHaveBeenCalled();
      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.reschedule).toHaveBeenCalledWith(
        RESERVATION_ID,
        expect.any(Number),
      );
    });

    it('abandonne BRUYAMMENT au-delà du plafond de tentatives', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.read.mockResolvedValue(holdRecord({ attempts: 3 }));

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.forget).toHaveBeenCalledWith(RESERVATION_ID);
      // Une chambre reste immobilisée : le silence serait la pire des issues.
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('Intervention manuelle requise'),
      );
    });

    it('nettoie une entrée d’index orpheline (enregistrement expiré)', async () => {
      deps.read.mockResolvedValue(null);

      await sweeper.sweep();

      expect(deps.forget).toHaveBeenCalledWith(RESERVATION_ID);
      expect(deps.post).not.toHaveBeenCalled();
    });

    it('retire un membre d’index inexploitable sans jamais l’interpoler dans un chemin PMS', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.dueHolds.mockResolvedValue(['res-a/confirm']);

      await sweeper.sweep();

      expect(deps.read).not.toHaveBeenCalled();
      expect(deps.get).not.toHaveBeenCalled();
      expect(deps.forget).toHaveBeenCalledWith('res-a/confirm');
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('inexploitable'),
      );
    });

    it('poursuit le lot malgré l’échec d’un élément', async () => {
      deps.dueHolds.mockResolvedValue([RESERVATION_ID, OTHER_RESERVATION_ID]);
      deps.read
        .mockRejectedValueOnce(new Error('lecture KO'))
        .mockResolvedValue(holdRecord({ reservationId: OTHER_RESERVATION_ID }));

      await sweeper.sweep();

      expect(deps.reschedule).toHaveBeenCalledWith(
        RESERVATION_ID,
        expect.any(Number),
      );
      expect(deps.post).toHaveBeenCalledWith(
        `/roomreservations/${OTHER_RESERVATION_ID}/cancel?abandonOnly=true`,
        undefined,
        expect.anything(),
      );
    });

    it('ne rejette jamais, même si le magasin d’état est en panne', async () => {
      // Un rejet non capturé dans une tâche planifiée devient un `unhandledRejection`.
      deps.dueHolds.mockRejectedValue(new Error('Redis KO'));
      await expect(sweeper.sweep()).resolves.toBeUndefined();
    });

    /**
     * Le compteur `attempts` vit dans Redis. Quand c'est **l'écriture Redis** qui échoue
     * (`maxmemory` + `noeviction`), il reste bloqué à 0 : le plafond n'est jamais atteint et le
     * PMS serait martelé à chaque passe, indéfiniment. Un compteur in-process prend le relais.
     */
    it('abandonne l’entrée après N reports impossibles (jamais de martèlement sans fin)', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.get.mockRejectedValue(new PmsUnavailableError('panne'));
      deps.reschedule.mockRejectedValue(new Error('OOM command not allowed'));

      for (let pass = 0; pass < options.sweeperMaxAttempts; pass++) {
        await sweeper.sweep();
      }

      expect(deps.forget).toHaveBeenCalledWith(RESERVATION_ID);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('reports impossibles'),
      );
    });

    it('ne compte pas les reports qui aboutissent (le compteur de repli est remis à zéro)', async () => {
      deps.get.mockRejectedValue(new PmsUnavailableError('panne'));
      deps.reschedule
        .mockRejectedValueOnce(new Error('OOM'))
        .mockResolvedValueOnce(1)
        .mockRejectedValue(new Error('OOM'));

      for (let pass = 0; pass < options.sweeperMaxAttempts; pass++) {
        await sweeper.sweep();
      }

      // 3 passes, dont un report réussi au milieu : le plafond de 3 échecs CONSÉCUTIFS n'est pas
      // atteint, l'entrée reste suivie.
      expect(deps.forget).not.toHaveBeenCalled();
    });
  });

  describe('réconciliation des intentions de création (correctif D1)', () => {
    beforeEach(() => {
      deps.dueHolds.mockResolvedValue([INTENT_MEMBER]);
    });

    it('annule la `Pending` orpheline retrouvée dans les réservations du compte', async () => {
      await sweeper.sweep();

      expect(deps.getList).toHaveBeenCalledWith(
        '/roomreservations/my-reservations?Status=1&PageSize=100',
        expect.objectContaining({ bearerToken: 'jeton' }),
      );
      expect(deps.post).toHaveBeenCalledWith(
        `/roomreservations/${RESERVATION_ID}/cancel?abandonOnly=true`,
        undefined,
        expect.anything(),
      );
      expect(deps.dropIntent).toHaveBeenCalledWith(INTENT_ID);
    });

    it('purge la clé d’idempotence en compare-and-delete sur la réservation annulée', async () => {
      await sweeper.sweep();

      expect(deps.clearIdempotentKey).toHaveBeenCalledWith(
        'booking:idem:v1:abc',
        RESERVATION_ID,
      );
    });

    it('#187 AC-2 : abandon refusé (paiement engagé) → intention retirée, idempotence conservée, sans report', async () => {
      deps.post.mockRejectedValue(abandonRefused());

      await sweeper.sweep();

      expect(deps.post).toHaveBeenCalledWith(
        `/roomreservations/${RESERVATION_ID}/cancel?abandonOnly=true`,
        undefined,
        expect.anything(),
      );
      expect(deps.dropIntent).toHaveBeenCalledWith(INTENT_ID);
      // La réservation vit (paiement engagé) : sa mémoire d'idempotence doit rester.
      expect(deps.clearIdempotentKey).not.toHaveBeenCalled();
      expect(deps.rescheduleIntent).not.toHaveBeenCalled();
    });

    it('retire l’intention SANS rien annuler quand le PMS n’a jamais écrit', async () => {
      deps.getList.mockResolvedValue(myReservations([]));

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.clearIdempotentKey).not.toHaveBeenCalled();
      expect(deps.dropIntent).toHaveBeenCalledWith(INTENT_ID);
    });

    it.each([
      ['une autre chambre', { roomId: 'une-autre-chambre' }],
      ['d’autres dates', { checkInDate: '2026-12-24T00:00:00Z' }],
      ['un statut déjà confirmé', { status: 2 }],
    ])('n’annule pas une réservation qui diffère par %s', async (_l, diff) => {
      deps.getList.mockResolvedValue(myReservations([orphanReservation(diff)]));

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.dropIntent).toHaveBeenCalledWith(INTENT_ID);
    });

    it('reporte plutôt que de conclure à tort quand la liste du compte est tronquée', async () => {
      // Conclure « rien n'a été écrit » sur une page incomplète laisserait une vraie chambre gelée.
      deps.getList.mockResolvedValue(myReservations([], true));

      await sweeper.sweep();

      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.dropIntent).not.toHaveBeenCalled();
      expect(deps.rescheduleIntent).toHaveBeenCalledWith(
        INTENT_ID,
        expect.any(Number),
      );
    });

    it('reporte quand la recherche de la réservation orpheline échoue', async () => {
      deps.getList.mockRejectedValue(new PmsUnavailableError('panne'));

      await sweeper.sweep();

      expect(deps.dropIntent).not.toHaveBeenCalled();
      expect(deps.rescheduleIntent).toHaveBeenCalledWith(
        INTENT_ID,
        expect.any(Number),
      );
    });

    it('nettoie l’index d’une intention dont l’enregistrement a expiré', async () => {
      deps.readIntent.mockResolvedValue(null);

      await sweeper.sweep();

      expect(deps.getList).not.toHaveBeenCalled();
      expect(deps.dropIntent).toHaveBeenCalledWith(INTENT_ID);
    });

    it('abandonne BRUYAMMENT une intention au-delà du plafond de tentatives', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      deps.readIntent.mockResolvedValue(intentRecord({ attempts: 3 }));

      await sweeper.sweep();

      expect(deps.getList).not.toHaveBeenCalled();
      expect(deps.dropIntent).toHaveBeenCalledWith(INTENT_ID);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('Intervention manuelle requise'),
      );
    });

    it('traite holds et intentions dans la même passe (un seul index, un seul verrou)', async () => {
      deps.dueHolds.mockResolvedValue([RESERVATION_ID, INTENT_MEMBER]);
      deps.getList.mockResolvedValue(
        myReservations([orphanReservation({ id: OTHER_RESERVATION_ID })]),
      );

      await sweeper.sweep();

      expect(deps.acquireSweeperLock).toHaveBeenCalledTimes(1);
      expect(deps.release).toHaveBeenCalledWith(RESERVATION_ID);
      expect(deps.dropIntent).toHaveBeenCalledWith(INTENT_ID);
    });
  });

  describe('exclusion mutuelle', () => {
    it('ne balaie pas si une autre instance détient le verrou de passe', async () => {
      deps.acquireSweeperLock.mockResolvedValue(null);

      await sweeper.sweep();

      expect(deps.dueHolds).not.toHaveBeenCalled();
      expect(deps.releaseSweeperLock).not.toHaveBeenCalled();
    });

    it('libère toujours le verrou de passe, même en cas d’erreur', async () => {
      deps.dueHolds.mockRejectedValue(new Error('boom'));
      await sweeper.sweep();
      expect(deps.releaseSweeperLock).toHaveBeenCalledWith('sweep-token');
    });

    it('ne se chevauche pas avec lui-même (passe lente)', async () => {
      let resolveDue: (v: string[]) => void = () => {};
      deps.dueHolds.mockReturnValue(
        new Promise<string[]>((resolve) => {
          resolveDue = resolve;
        }),
      );

      const first = sweeper.sweep();
      await sweeper.sweep(); // seconde passe pendant la première
      resolveDue([]);
      await first;

      expect(deps.acquireSweeperLock).toHaveBeenCalledTimes(1);
    });

    /**
     * `max(60 s, intervalle × 2)` ne couvrait pas un lot plein à deux appels PMS par élément : la
     * passe survivait à son propre verrou et une seconde instance annulait en parallèle les
     * réservations encore en cours de traitement.
     */
    it('dimensionne le verrou de passe sur le budget réel d’un lot plein', async () => {
      await sweeper.sweep();

      const [ttl] = deps.acquireSweeperLock.mock.calls[0] as unknown as [
        number,
      ];
      expect(ttl).toBeGreaterThanOrEqual(options.sweeperIntervalMs * 2);
      expect(ttl).toBeGreaterThanOrEqual(60_000);
      // Lot plein × 2 appels PMS × budget d'un appel : très au-delà de « intervalle × 2 ».
      expect(ttl).toBeGreaterThan(options.sweeperIntervalMs * 2);
      // Plafonné : un processus mort ne doit pas priver la plateforme de balayage trop longtemps.
      expect(ttl).toBeLessThanOrEqual(300_000);
    });

    it('n’entame aucun élément une fois l’échéance du verrou approchée', async () => {
      deps.dueHolds.mockResolvedValue([RESERVATION_ID, OTHER_RESERVATION_ID]);
      let clock = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      // Le premier élément consomme toute la fenêtre : le second doit repartir à la passe suivante.
      deps.read.mockImplementation(() => {
        clock += 10_000_000;
        return Promise.resolve(holdRecord());
      });

      await sweeper.sweep();

      expect(deps.post).toHaveBeenCalledTimes(1);
      expect(deps.post).toHaveBeenCalledWith(
        `/roomreservations/${RESERVATION_ID}/cancel?abandonOnly=true`,
        undefined,
        expect.anything(),
      );
    });
  });

  describe('cycle de vie', () => {
    it('n’enregistre aucun intervalle quand le balayeur est désactivé', () => {
      buildSweeper(deps, { sweeperEnabled: false }).onModuleInit();
      expect(deps.addInterval).not.toHaveBeenCalled();
    });

    it('enregistre un intervalle quand il est activé, et le retire à l’arrêt', () => {
      const active = buildSweeper(deps, { sweeperEnabled: true });
      active.onModuleInit();
      expect(deps.addInterval).toHaveBeenCalledTimes(1);

      // Sans ce retrait, le timer survit : les suites Jest resteraient ouvertes.
      active.onModuleDestroy();
      expect(deps.deleteInterval).toHaveBeenCalledWith(
        'booking-checkout-hold-sweeper',
      );
      const registered = deps.addInterval.mock.calls[0] as unknown as [
        string,
        NodeJS.Timeout,
      ];
      clearInterval(registered[1]);
    });
  });
});
