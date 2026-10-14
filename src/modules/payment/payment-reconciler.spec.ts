import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { PmsClientService } from '../../integration/pms/pms-client.service';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import { ServiceKeyProvider } from '../../integration/pms/service-key.provider';
import type { CheckoutHoldService } from '../booking/checkout-hold.service';
import { confirmIdempotencyKey } from './confirm-errors';
import type { ConfirmationLockService } from './confirmation-lock.service';
import { PaymentReconciler } from './payment-reconciler';
import type { ReconcileOptions } from './reconcile.constants';
import type {
  PaymentReconcileStore,
  ReconcileEntry,
  ReconcileRecord,
} from './reconcile.store';

const ID = '3f2b8c1e-6d4a-4b7e-9a10-5c2d1e0f9a88';
const OTHER = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
const PAYMENT_ID = '9c8b7a6d-5e4f-4321-8abc-def012345678';
const SERVICE_KEY = 'svc-key-reconcile';
const NOW = 10_000_000_000;

const options: ReconcileOptions = {
  enabled: false,
  intervalMs: 60_000,
  batchSize: 50,
  alertAfterSeconds: 900,
  alertRepeatSeconds: 3_600,
  maxAgeSeconds: 691_200,
  pmsCallBudgetMs: 24_750,
};

function record(overrides: Partial<ReconcileRecord> = {}): ReconcileRecord {
  return {
    reservationId: ID,
    issuedAt: NOW - 120_000,
    attempts: 0,
    failures: 0,
    paymentId: null,
    lastIntentStatus: null,
    refusal: null,
    lastAlertAt: null,
    ...overrides,
  };
}

/** Réponse `GET /reservations/{id}` (#153 AC-4) : statut numérique du PMS, aucune PII. */
function state(status: number) {
  return {
    success: true,
    data: {
      id: ID,
      reservationCode: 'RES-20261014-A1B2C',
      status,
      hotelId: '22222222-2222-4222-8222-222222222222',
      checkInDate: '2026-11-01T00:00:00Z',
      checkOutDate: '2026-11-03T00:00:00Z',
      grandTotal: 168,
      currency: 'EUR',
      createdAt: '2026-10-14T10:00:00Z',
    },
  };
}

/** Réponse `GET /reservations/{id}/payment` (#153 AC-5). */
function payment(
  intentStatus: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    success: true,
    data: {
      reservationId: ID,
      payment: {
        paymentId: PAYMENT_ID,
        status: 1,
        amount: 168,
        currency: 'EUR',
        intentStatus,
        amountCapturable: intentStatus === 'requires_capture' ? 16_800 : 0,
        amountReceived: intentStatus === 'succeeded' ? 16_800 : 0,
        stripeReadable: true,
        createdAt: '2026-10-14T10:00:00Z',
        paidAt: null,
        ...overrides,
      },
    },
  };
}

const noPayment = { success: true, data: { reservationId: ID, payment: null } };

function makeDeps() {
  let reservationStatus = 1;
  let paymentBody: unknown = payment('requires_capture');
  const entries = new Map<string, ReconcileEntry>([
    [ID, { record: record(), issuedAt: NOW - 120_000 }],
  ]);
  const deps = {
    setStatus: (s: number) => {
      reservationStatus = s;
    },
    setPayment: (body: unknown) => {
      paymentBody = body;
    },
    entries,
    store: {
      acquirePassLock: jest.fn().mockResolvedValue('pass-token'),
      releasePassLock: jest.fn().mockResolvedValue(undefined),
      olderThan: jest.fn().mockResolvedValue([]),
      due: jest.fn().mockResolvedValue([ID]),
      read: jest.fn((id: string) =>
        Promise.resolve(entries.get(id) ?? { record: null, issuedAt: null }),
      ),
      update: jest.fn().mockResolvedValue(true),
      remove: jest.fn().mockResolvedValue(undefined),
    },
    pms: {
      get: jest.fn((path: string) =>
        Promise.resolve(
          path.endsWith('/payment') ? paymentBody : state(reservationStatus),
        ),
      ),
      post: jest.fn(() =>
        Promise.resolve({
          success: true,
          data: { reservationId: ID, alreadyConfirmed: false },
        }),
      ),
    },
    lock: {
      acquire: jest.fn().mockResolvedValue('confirm-token'),
      release: jest.fn().mockResolvedValue(undefined),
    },
    holds: { forget: jest.fn().mockResolvedValue(undefined) },
    scheduler: {
      addInterval: jest.fn(),
      deleteInterval: jest.fn(),
      doesExist: jest.fn().mockReturnValue(true),
    },
  };
  return deps;
}

type Deps = ReturnType<typeof makeDeps>;

function build(
  deps: Deps,
  overrides: Partial<ReconcileOptions> = {},
): PaymentReconciler {
  return new PaymentReconciler(
    deps.store as unknown as PaymentReconcileStore,
    deps.pms as unknown as PmsClientService,
    new ServiceKeyProvider(SERVICE_KEY),
    deps.lock as unknown as ConfirmationLockService,
    deps.holds as unknown as CheckoutHoldService,
    deps.scheduler as unknown as SchedulerRegistry,
    { ...options, ...overrides },
  );
}

/** Dernière mise à jour de l'état : enregistrement réécrit et prochaine échéance. */
function lastUpdate(deps: Deps): { rec: ReconcileRecord; nextAt: number } {
  const calls = deps.store.update.mock.calls as [ReconcileRecord, number][];
  const [rec, nextAt] = calls[calls.length - 1];
  return { rec, nextAt };
}

describe('PaymentReconciler (#5)', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  /** Charges utiles `integrity.alert` émises (log structuré de niveau `error`). */
  const alerts = (): Record<string, unknown>[] =>
    errorSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .filter(
        (arg): arg is Record<string, unknown> =>
          typeof arg === 'object' &&
          arg !== null &&
          (arg as Record<string, unknown>).event === 'integrity.alert',
      );

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('rejeu de la confirmation (AC-2)', () => {
    it.each(['requires_capture', 'succeeded'])(
      'Pending + %s : confirme sous X-Service-Key, sans cookie ni JWT, puis sort de l’index',
      async (intentStatus) => {
        const deps = makeDeps();
        deps.setPayment(payment(intentStatus));

        await build(deps).reconcile();

        expect(deps.pms.post).toHaveBeenCalledTimes(1);
        const [path, body, ctx] = deps.pms.post.mock.calls[0] as unknown as [
          string,
          unknown,
          Record<string, unknown> & { headers: Record<string, string> },
        ];
        expect(path).toBe(`/reservations/${ID}/confirm`);
        expect(body).toBeUndefined();
        expect(ctx.headers['X-Service-Key']).toBe(SERVICE_KEY);
        expect(ctx.bearerToken).toBeUndefined();
        expect(ctx.headers.Authorization).toBeUndefined();
        expect(ctx.headers.Cookie).toBeUndefined();
        // La MÊME clé d'idempotence que la confirmation du navigateur (#3).
        expect(ctx.idempotencyKey).toBe(confirmIdempotencyKey(ID));
        expect(ctx.correlationId).toMatch(/^reconcile-[0-9a-f]{8}$/);

        expect(deps.store.remove).toHaveBeenCalledWith(ID);
        expect(deps.holds.forget).toHaveBeenCalledWith(ID);
      },
    );

    it('lit la réservation puis le paiement par les routes de service, sans JWT', async () => {
      const deps = makeDeps();
      await build(deps).reconcile();

      const paths = deps.pms.get.mock.calls.map((c) => c[0]);
      expect(paths).toEqual([
        `/reservations/${ID}`,
        `/reservations/${ID}/payment`,
      ]);
      for (const call of deps.pms.get.mock.calls as unknown as [
        string,
        Record<string, unknown> & { headers: Record<string, string> },
      ][]) {
        expect(call[1].headers['X-Service-Key']).toBe(SERVICE_KEY);
        expect(call[1].bearerToken).toBeUndefined();
      }
    });

    it('propage le même X-Correlation-ID de passe à tous les appels PMS', async () => {
      const deps = makeDeps();
      await build(deps).reconcile();
      const ids = [
        ...deps.pms.get.mock.calls.map(
          (c) =>
            (c as unknown as [string, { correlationId: string }])[1]
              .correlationId,
        ),
        (
          deps.pms.post.mock.calls[0] as unknown as [
            string,
            unknown,
            { correlationId: string },
          ]
        )[2].correlationId,
      ];
      expect(new Set(ids).size).toBe(1);
    });

    it('déjà Confirmed (ou au-delà) : sort de l’index sans relire le paiement ni confirmer', async () => {
      for (const status of [2, 3, 4]) {
        const deps = makeDeps();
        deps.setStatus(status);
        await build(deps).reconcile();
        expect(deps.pms.get).toHaveBeenCalledTimes(1);
        expect(deps.pms.post).not.toHaveBeenCalled();
        expect(deps.store.remove).toHaveBeenCalledWith(ID);
        expect(deps.holds.forget).toHaveBeenCalledWith(ID);
      }
    });

    it('une panne Redis sur holds.forget ne remet pas en cause la confirmation', async () => {
      const deps = makeDeps();
      deps.holds.forget.mockRejectedValueOnce(
        new ServiceUnavailableException(),
      );
      await build(deps).reconcile();
      expect(deps.store.remove).toHaveBeenCalledWith(ID);
    });
  });

  describe('aucune action sans argent engagé (AC-3)', () => {
    it.each([
      'requires_payment_method',
      'requires_confirmation',
      'requires_action',
      'processing',
      'canceled',
    ])(
      'intentStatus %s : aucun appel de confirmation',
      async (intentStatus) => {
        const deps = makeDeps();
        deps.setPayment(payment(intentStatus));
        await build(deps).reconcile();
        expect(deps.pms.post).not.toHaveBeenCalled();
        expect(deps.lock.acquire).not.toHaveBeenCalled();
        expect(deps.store.remove).not.toHaveBeenCalled();
        // Toujours candidat : la passe suivante relira, au rythme de l'intervalle.
        const { rec, nextAt } = lastUpdate(deps);
        expect(nextAt).toBe(NOW + options.intervalMs);
        expect(rec.failures).toBe(0);
        expect(rec.lastIntentStatus).toBe(intentStatus);
      },
    );

    it('payment = null : aucun appel de confirmation', async () => {
      const deps = makeDeps();
      deps.setPayment(noPayment);
      await build(deps).reconcile();
      expect(deps.pms.post).not.toHaveBeenCalled();
      expect(deps.store.remove).not.toHaveBeenCalled();
    });

    it('Cancelled sans argent engagé : sort de l’index, sans confirmation', async () => {
      for (const body of [noPayment, payment('canceled')]) {
        const deps = makeDeps();
        deps.setStatus(5);
        deps.setPayment(body);
        await build(deps).reconcile();
        expect(deps.pms.post).not.toHaveBeenCalled();
        expect(deps.store.remove).toHaveBeenCalledWith(ID);
      }
    });

    it('Stripe illisible : doute, le candidat est reporté, jamais retiré ni confirmé', async () => {
      const deps = makeDeps();
      deps.setPayment(
        payment(null, { stripeReadable: false, amountCapturable: null }),
      );
      await build(deps).reconcile();
      expect(deps.pms.post).not.toHaveBeenCalled();
      expect(deps.store.remove).not.toHaveBeenCalled();
      expect(lastUpdate(deps).rec.failures).toBe(1);
    });
  });

  describe('idempotence et exclusivité (AC-4)', () => {
    it('prend le verrou single-flight partagé avec le navigateur, et le rend', async () => {
      const deps = makeDeps();
      await build(deps).reconcile();
      expect(deps.lock.acquire).toHaveBeenCalledWith(ID);
      expect(deps.lock.release).toHaveBeenCalledWith(ID, 'confirm-token');
    });

    it('confirmation déjà en vol (navigateur ou autre passe) : aucun POST, nouvel essai plus tard', async () => {
      const deps = makeDeps();
      deps.lock.acquire.mockResolvedValueOnce(null);
      await build(deps).reconcile();
      expect(deps.pms.post).not.toHaveBeenCalled();
      expect(deps.lock.release).not.toHaveBeenCalled();
      expect(deps.store.remove).not.toHaveBeenCalled();
      expect(lastUpdate(deps).nextAt).toBe(NOW + options.intervalMs);
    });

    it('rend le verrou même si la confirmation échoue', async () => {
      const deps = makeDeps();
      deps.pms.post.mockRejectedValueOnce(new PmsUnavailableError('down'));
      await build(deps).reconcile();
      expect(deps.lock.release).toHaveBeenCalledWith(ID, 'confirm-token');
    });

    it('verrou de passe détenu par une autre instance : rien n’est traité', async () => {
      const deps = makeDeps();
      deps.store.acquirePassLock.mockResolvedValueOnce(null);
      await build(deps).reconcile();
      expect(deps.store.due).not.toHaveBeenCalled();
      expect(deps.pms.get).not.toHaveBeenCalled();
    });

    it('verrou de passe à TTL, rendu en fin de passe', async () => {
      const deps = makeDeps();
      await build(deps).reconcile();
      const ttl = (deps.store.acquirePassLock.mock.calls as number[][])[0][0];
      expect(ttl).toBeGreaterThanOrEqual(60_000);
      expect(ttl).toBeLessThanOrEqual(300_000);
      expect(deps.store.releasePassLock).toHaveBeenCalledWith('pass-token');
    });

    it('Redis indisponible : passe sautée avec un warn, sans lever', async () => {
      const deps = makeDeps();
      deps.store.acquirePassLock.mockRejectedValueOnce(
        new Error('ECONNREFUSED'),
      );
      await expect(build(deps).reconcile()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Redis indisponible.*sautée/),
      );
      expect(deps.pms.get).not.toHaveBeenCalled();
    });

    it('une passe lente ne se chevauche pas elle-même dans le processus', async () => {
      const deps = makeDeps();
      let releaseGet!: () => void;
      deps.pms.get.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseGet = () => resolve(state(2));
          }),
      );
      const reconciler = build(deps);
      const first = reconciler.reconcile();
      await reconciler.reconcile();
      expect(deps.store.acquirePassLock).toHaveBeenCalledTimes(1);
      await new Promise((r) => setImmediate(r));
      releaseGet();
      await first;
    });
  });

  describe('rejeu jusqu’à cohérence (AC-5)', () => {
    it.each([
      ['PMS injoignable', new PmsUnavailableError('down')],
      [
        '5xx après retries',
        new PmsUnavailableError('5xx', undefined, { status: 503, body: {} }),
      ],
      [
        'capture échouée (502)',
        new PmsUnavailableError('502', undefined, {
          status: 502,
          body: { message: 'Payment capture failed.' },
        }),
      ],
      ['429 limiteur', new PmsRequestError('Too many', 429)],
      ['clé de service refusée', new PmsRequestError('Unauthorized', 401)],
      [
        'paiement non libéré chez Stripe (502, #4 AC-5)',
        new PmsUnavailableError('502', undefined, {
          status: 502,
          body: {
            errors: ['The payment of this reservation could not be released'],
          },
        }),
      ],
    ])(
      'échec transitoire (%s) : retenté avec backoff, jamais retiré',
      async (_label, err) => {
        const deps = makeDeps();
        deps.pms.post.mockRejectedValueOnce(err);
        await build(deps).reconcile();
        expect(deps.store.remove).not.toHaveBeenCalled();
        const { rec, nextAt } = lastUpdate(deps);
        expect(rec.failures).toBe(1);
        expect(rec.attempts).toBe(1);
        expect(rec.refusal).toBeNull();
        expect(nextAt).toBe(NOW + options.intervalMs);
      },
    );

    /**
     * #4 AC-5 : capturé mais non confirmable (chambre prise), et Stripe refuse le remboursement. Le
     * PMS laisse la réservation en l'état (502) ; la réconciliation la retente et l'alerte de #5 le
     * signale une fois le seuil dépassé.
     */
    it('#4 AC-5 : remboursement en échec au-delà du seuil → integrity.alert payment-not-confirmed', async () => {
      const deps = makeDeps();
      deps.setPayment(payment('succeeded'));
      deps.entries.set(ID, {
        record: record({
          issuedAt: NOW - (options.alertAfterSeconds + 60) * 1000,
          lastIntentStatus: 'succeeded',
        }),
        issuedAt: NOW - (options.alertAfterSeconds + 60) * 1000,
      });
      deps.pms.post.mockRejectedValueOnce(
        new PmsUnavailableError('502', undefined, {
          status: 502,
          body: {
            errors: ['The payment of this reservation could not be released'],
          },
        }),
      );

      await build(deps).reconcile();

      expect(deps.store.remove).not.toHaveBeenCalled();
      expect(alerts()).toEqual([
        expect.objectContaining({
          kind: 'payment-not-confirmed',
          reservationId: ID,
          intentStatus: 'succeeded',
        }),
      ]);
    });

    /**
     * #4 AC-7 : le PMS a libéré le paiement et annulé la `Pending`. Ce n'est ni une panne (aucun
     * backoff) ni un refus à mémoriser : la passe suivante relit `Cancelled` sans argent engagé et
     * sort le candidat.
     */
    it('#4 AC-7 : chambre indisponible (409) → repassé à l’intervalle, puis sorti à la relecture', async () => {
      const deps = makeDeps();
      deps.pms.post.mockRejectedValueOnce(
        new PmsRequestError('Conflict', 409, {
          errors: ['Room is no longer available for this reservation'],
        }),
      );
      const reconciler = build(deps);

      await reconciler.reconcile();

      const { rec, nextAt } = lastUpdate(deps);
      expect(rec.failures).toBe(0);
      expect(rec.refusal).toBeNull();
      expect(nextAt).toBe(NOW + options.intervalMs);
      expect(alerts()).toHaveLength(0);
      expect(deps.store.remove).not.toHaveBeenCalled();

      deps.entries.set(ID, { record: rec, issuedAt: NOW - 120_000 });
      deps.setStatus(5);
      deps.setPayment(payment('canceled'));
      await reconciler.reconcile();

      expect(deps.store.remove).toHaveBeenCalledWith(ID);
      expect(deps.pms.post).toHaveBeenCalledTimes(1);
    });

    it('échec de lecture transitoire : reporté, jamais retiré', async () => {
      const deps = makeDeps();
      deps.pms.get.mockRejectedValueOnce(new PmsUnavailableError('down'));
      await build(deps).reconcile();
      expect(deps.pms.post).not.toHaveBeenCalled();
      expect(deps.store.remove).not.toHaveBeenCalled();
      expect(lastUpdate(deps).rec.failures).toBe(1);
    });

    it('backoff exponentiel borné', async () => {
      const delays: number[] = [];
      for (const failures of [0, 1, 2, 3, 4, 5, 10, 40]) {
        const deps = makeDeps();
        deps.entries.set(ID, {
          record: record({ failures }),
          issuedAt: NOW - 120_000,
        });
        deps.pms.post.mockRejectedValueOnce(new PmsUnavailableError('down'));
        await build(deps).reconcile();
        delays.push(lastUpdate(deps).nextAt - NOW);
      }
      expect(delays.slice(0, 5)).toEqual([
        60_000, 120_000, 240_000, 480_000, 960_000,
      ]);
      // Plafond : jamais plus d'une heure entre deux essais (ni moins d'un intervalle).
      expect(delays[5]).toBe(960_000);
      expect(delays[7]).toBe(960_000);
    });

    it.each([
      [
        'amount-mismatch',
        new PmsRequestError(
          'The authorised amount does not match the amount due.',
          409,
        ),
      ],
      [
        'payment-not-authorized',
        new PmsRequestError('Reservation payment is not authorized.', 409),
      ],
    ])(
      'refus déterministe %s : alerte immédiate, plus jamais rejoué',
      async (reason, err) => {
        const deps = makeDeps();
        // Candidat jeune : seule la nature du refus déclenche l'alerte, pas l'âge.
        deps.entries.set(ID, {
          record: record({ issuedAt: NOW - 70_000 }),
          issuedAt: NOW - 70_000,
        });
        deps.pms.post.mockRejectedValueOnce(err);
        const reconciler = build(deps);
        await reconciler.reconcile();

        const { rec } = lastUpdate(deps);
        expect(rec.refusal).toBe(reason);
        expect(deps.store.remove).not.toHaveBeenCalled();
        expect(alerts()).toHaveLength(1);
        expect(alerts()[0]).toMatchObject({
          event: 'integrity.alert',
          kind: 'deterministic-refusal',
          reservationId: ID,
        });

        // Passe suivante : le refus est mémorisé, la confirmation n'est pas rejouée.
        deps.entries.set(ID, { record: rec, issuedAt: NOW - 70_000 });
        deps.pms.post.mockClear();
        await reconciler.reconcile();
        expect(deps.pms.post).not.toHaveBeenCalled();
        expect(deps.lock.acquire).toHaveBeenCalledTimes(1);
        // Réémission bornée par la fenêtre de répétition.
        expect(alerts()).toHaveLength(1);
      },
    );
  });

  describe('alerte opérationnelle integrity.alert (AC-6)', () => {
    it('argent engagé non confirmé au-delà du seuil : payment-not-confirmed, champs exacts, sans PII', async () => {
      const deps = makeDeps();
      deps.entries.set(ID, {
        record: record({ issuedAt: NOW - 901_000, attempts: 2 }),
        issuedAt: NOW - 901_000,
      });
      deps.pms.post.mockRejectedValueOnce(new PmsUnavailableError('down'));
      await build(deps).reconcile();

      expect(alerts()).toHaveLength(1);
      const alert = alerts()[0];
      expect(alert).toEqual({
        event: 'integrity.alert',
        kind: 'payment-not-confirmed',
        reservationId: ID,
        paymentId: PAYMENT_ID,
        intentStatus: 'requires_capture',
        ageSeconds: 901,
        attempts: 3,
        correlationId: expect.stringMatching(/^reconcile-/) as string,
        msg: expect.any(String) as string,
      });
      expect(JSON.stringify(alert)).not.toMatch(
        /svc-key|@|customer|token|secret/i,
      );
      expect(lastUpdate(deps).rec.lastAlertAt).toBe(NOW);
    });

    it('sous le seuil : aucune alerte', async () => {
      const deps = makeDeps();
      deps.pms.post.mockRejectedValueOnce(new PmsUnavailableError('down'));
      await build(deps).reconcile();
      expect(alerts()).toHaveLength(0);
    });

    it('réémise au plus une fois par fenêtre de répétition et par réservation', async () => {
      const issuedAt = NOW - 2_000_000;
      const withAlertAt = (lastAlertAt: number) => {
        const deps = makeDeps();
        deps.entries.set(ID, {
          record: record({ issuedAt, lastAlertAt }),
          issuedAt,
        });
        deps.pms.post.mockRejectedValueOnce(new PmsUnavailableError('down'));
        return deps;
      };

      await build(withAlertAt(NOW - 3_599_000)).reconcile();
      expect(alerts()).toHaveLength(0);

      await build(withAlertAt(NOW - 3_600_000)).reconcile();
      expect(alerts()).toHaveLength(1);
    });

    it('Cancelled dont l’intent est succeeded : captured-not-confirmable, le candidat reste', async () => {
      const deps = makeDeps();
      deps.setStatus(5);
      deps.setPayment(payment('succeeded'));
      deps.entries.set(ID, {
        record: record({ issuedAt: NOW - 70_000 }),
        issuedAt: NOW - 70_000,
      });
      await build(deps).reconcile();
      expect(deps.pms.post).not.toHaveBeenCalled();
      expect(deps.store.remove).not.toHaveBeenCalled();
      expect(alerts()).toEqual([
        expect.objectContaining({
          kind: 'captured-not-confirmable',
          intentStatus: 'succeeded',
          paymentId: PAYMENT_ID,
        }),
      ]);
    });

    it('captured-not-confirmable n’est pas réémise à chaque passe', async () => {
      const deps = makeDeps();
      deps.setStatus(5);
      deps.setPayment(payment('succeeded'));
      const reconciler = build(deps);
      await reconciler.reconcile();
      const { rec } = lastUpdate(deps);
      deps.entries.set(ID, { record: rec, issuedAt: rec.issuedAt });
      await reconciler.reconcile();
      expect(alerts()).toHaveLength(1);
    });

    it('Cancelled avec une autorisation encore retenue : reste candidat, alerte passé le seuil', async () => {
      const deps = makeDeps();
      deps.setStatus(5);
      deps.setPayment(payment('requires_capture'));
      deps.entries.set(ID, {
        record: record({ issuedAt: NOW - 1_000_000 }),
        issuedAt: NOW - 1_000_000,
      });
      await build(deps).reconcile();
      expect(deps.pms.post).not.toHaveBeenCalled();
      expect(deps.store.remove).not.toHaveBeenCalled();
      expect(alerts()).toEqual([
        expect.objectContaining({ kind: 'payment-not-confirmed' }),
      ]);
    });
  });

  describe('index de réconciliation (AC-1)', () => {
    it('au-delà de l’âge maximal : sort de l’index, sans appel PMS, bruyamment', async () => {
      const deps = makeDeps();
      deps.store.olderThan.mockResolvedValueOnce([OTHER]);
      deps.store.due.mockResolvedValueOnce([]);
      await build(deps).reconcile();
      expect(deps.store.olderThan).toHaveBeenCalledWith(
        NOW - options.maxAgeSeconds * 1000,
        options.batchSize,
      );
      expect(deps.store.remove).toHaveBeenCalledWith(OTHER);
      expect(deps.pms.get).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(OTHER));
    });

    it('lit les échéances bornées au lot', async () => {
      const deps = makeDeps();
      await build(deps, { batchSize: 7 }).reconcile();
      expect(deps.store.due).toHaveBeenCalledWith(NOW, 7);
    });

    it('état perdu mais candidat indexé : reconstitué depuis l’instant d’émission, jamais abandonné', async () => {
      const deps = makeDeps();
      deps.entries.set(ID, { record: null, issuedAt: NOW - 120_000 });
      await build(deps).reconcile();
      expect(deps.pms.post).toHaveBeenCalledTimes(1);
      expect(deps.store.remove).toHaveBeenCalledWith(ID);
    });

    it('échéance sans entrée d’index : nettoyée, sans appel PMS', async () => {
      const deps = makeDeps();
      deps.entries.delete(ID);
      await build(deps).reconcile();
      expect(deps.store.remove).toHaveBeenCalledWith(ID);
      expect(deps.pms.get).not.toHaveBeenCalled();
    });

    it('membre qui n’est pas un GUID : retiré sans jamais être interpolé dans un chemin PMS', async () => {
      const deps = makeDeps();
      deps.store.due.mockResolvedValueOnce(['../payments/x']);
      await build(deps).reconcile();
      expect(deps.store.remove).toHaveBeenCalledWith('../payments/x');
      expect(deps.pms.get).not.toHaveBeenCalled();
    });
  });

  describe('robustesse', () => {
    it('un élément en échec n’interrompt pas le lot', async () => {
      const deps = makeDeps();
      deps.store.due.mockResolvedValueOnce([ID, OTHER]);
      deps.entries.set(OTHER, {
        record: record({ reservationId: OTHER }),
        issuedAt: NOW - 120_000,
      });
      deps.store.read.mockRejectedValueOnce(new Error('boom'));
      await build(deps).reconcile();
      expect(deps.pms.post).toHaveBeenCalledWith(
        `/reservations/${OTHER}/confirm`,
        undefined,
        expect.anything(),
      );
    });

    it('ne s’exécute pas planifié quand il est désactivé', () => {
      const deps = makeDeps();
      build(deps, { enabled: false }).onModuleInit();
      expect(deps.scheduler.addInterval).not.toHaveBeenCalled();
    });

    it('planifie une passe par intervalle quand il est actif, et la retire à l’arrêt', () => {
      jest.useFakeTimers();
      try {
        const deps = makeDeps();
        const reconciler = build(deps, { enabled: true, intervalMs: 10_000 });
        reconciler.onModuleInit();
        expect(deps.scheduler.addInterval).toHaveBeenCalledWith(
          'payment-reconciler',
          expect.anything(),
        );
        reconciler.onModuleDestroy();
        expect(deps.scheduler.deleteInterval).toHaveBeenCalledWith(
          'payment-reconciler',
        );
        clearInterval(
          (deps.scheduler.addInterval.mock.calls as NodeJS.Timeout[][])[0][1],
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
