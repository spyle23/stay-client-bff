import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { PmsRequestContext } from '../../integration/pms/pms-client.service';
import { PmsClientService } from '../../integration/pms/pms-client.service';
import { ServiceKeyProvider } from '../../integration/pms/service-key.provider';
import type { components } from '../../types/generated/pms';
import { isPmsGuid } from '../booking/booking-errors';
import { CheckoutHoldService } from '../booking/checkout-hold.service';
import {
  classifyConfirmFailure,
  confirmIdempotencyKey,
  PMS_CONFIRMATION_ENDPOINTS,
} from './confirm-errors';
import { ConfirmationLockService } from './confirmation-lock.service';
import {
  RECONCILE_OPTIONS,
  type ReconcileOptions,
} from './reconcile.constants';
import {
  type DeterministicRefusal,
  PaymentReconcileStore,
  type ReconcileRecord,
} from './reconcile.store';

type PmsReservationState = components['schemas']['ReservationStateDto'];
type PmsReservationPayment =
  components['schemas']['ReservationPaymentStateDto'];
type PmsPaymentState = components['schemas']['PaymentStateDto'];

/** `ReservationStatus` du PMS (Pending=1, Confirmed=2, CheckedIn=3, CheckedOut=4, Cancelled=5, NoShow=6). */
const STATUS_PENDING = 1;
const STATUS_CANCELLED = 5;
const STATUS_NO_SHOW = 6;
/** Statuts au-delà de la confirmation : la réservation est aboutie, le candidat sort de l'index. */
const PAST_CONFIRMATION: ReadonlySet<number> = new Set([2, 3, 4]);

/**
 * `intentStatus` qui signifient de l'**argent engagé** : retenu sur la carte (capture manuelle, D8)
 * ou déjà encaissé. Tout autre statut, ou l'absence de paiement, n'autorise aucune confirmation
 * (AC-3 : ces cas relèvent de #4 et #34).
 */
const MONEY_ENGAGED: ReadonlySet<string> = new Set([
  'requires_capture',
  'succeeded',
]);

/** Refus du PMS qu'un rejeu ne changera pas : jamais rejoués, alerte immédiate (AC-5). */
const DETERMINISTIC_REFUSALS: ReadonlySet<string> =
  new Set<DeterministicRefusal>([
    'amount-mismatch',
    'payment-not-authorized',
    'rejected',
  ]);

export type IntegrityAlertKind =
  | 'payment-not-confirmed'
  | 'deterministic-refusal'
  | 'captured-not-confirmable';

const INTERVAL_NAME = 'payment-reconciler';

/** Appels PMS au pire par candidat : deux lectures de service, puis la confirmation. */
const PMS_CALLS_PER_ITEM = 3;

/** Plafond du verrou de passe (ms) : un processus mort ne prive pas la plateforme de filet trop longtemps. */
const PASS_LOCK_TTL_CAP_MS = 300_000;

/** Plafond du backoff : 16 intervalles, jamais plus d'une heure (ni moins d'un intervalle). */
const BACKOFF_MAX_FACTOR = 16;
const BACKOFF_CAP_MS = 3_600_000;

/** Contexte d'un candidat pendant une passe. */
interface Candidate {
  record: ReconcileRecord;
  passId: string;
  now: number;
}

/**
 * **Réconciliation paiement → confirmation** (#5, story 3.4, FR-23, SM-3) — le filet d'intégrité.
 *
 * La confirmation ferme est déclenchée par le navigateur (#3). Si l'onglet se ferme, si le réseau
 * coupe ou si le BFF tombe entre l'autorisation carte et la confirmation, le voyageur a payé (ou vu
 * sa carte débitée d'une retenue) sans obtenir de confirmation. Ce job rattrape ces cas **sans
 * session voyageur** : il lit l'état de la réservation et de son paiement par les routes de service
 * de #153, puis rejoue `POST /reservations/{id}/confirm` sous `X-Service-Key`.
 *
 * ## Invariants
 *
 * 1. **Aucune confirmation sans argent engagé** (`requires_capture` ou `succeeded`, AC-3).
 * 2. **Jamais deux confirmations concurrentes** : le même verrou single-flight que le navigateur
 *    (`payment:confirm:v1:{id}`), et une seule instance par passe (verrou de passe, AC-4).
 * 3. **Jamais retiré tant que de l'argent est engagé** : seules la confirmation constatée, une
 *    annulation sans argent engagé ou l'âge maximal font sortir un candidat (AC-1, AC-5).
 * 4. **Aucune boucle aveugle** : backoff borné sur les pannes, aucun rejeu après un refus
 *    déterministe, alerte `integrity.alert` dès qu'un humain doit intervenir (AC-5, AC-6).
 *
 * Patron du balayeur (`checkout-hold.sweeper.ts`) : verrou de passe, échéance de passe, isolement de
 * chaque élément, `X-Correlation-ID` de passe propagé au PMS.
 */
@Injectable()
export class PaymentReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentReconciler.name);
  /** Contexte dédié : les alertes d'intégrité se filtrent sans ambiguïté dans les logs. */
  private readonly alertLogger = new Logger('IntegrityAlert');
  private running = false;

  constructor(
    private readonly store: PaymentReconcileStore,
    private readonly pms: PmsClientService,
    private readonly serviceKey: ServiceKeyProvider,
    private readonly confirmLock: ConfirmationLockService,
    private readonly holds: CheckoutHoldService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(RECONCILE_OPTIONS) private readonly options: ReconcileOptions,
  ) {}

  onModuleInit(): void {
    if (!this.options.enabled) {
      this.logger.log(
        'Réconciliation des paiements désactivée par configuration.',
      );
      return;
    }
    const interval = setInterval(() => {
      void this.reconcile();
    }, this.options.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.logger.log(
      `Réconciliation des paiements active (toutes les ${this.options.intervalMs} ms, lot ${this.options.batchSize}).`,
    );
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /**
   * Une passe. Publique : les tests l'appellent directement, sans planificateur.
   *
   * Ne lève jamais : une passe ratée n'est pas fatale, la suivante reprend le même index (un rejet
   * non capturé dans une tâche planifiée pourrait abattre le processus).
   */
  async reconcile(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const passId = randomUUID().slice(0, 8);
    let lock: string | null = null;
    try {
      const lockTtlMs = this.passLockTtlMs();
      try {
        lock = await this.store.acquirePassLock(lockTtlMs);
      } catch (err) {
        // AC-4 : Redis indisponible → passe sautée, jamais d'arrêt du processus.
        this.logger.warn(
          `[réconciliation ${passId}] Redis indisponible, passe sautée : ${message(err)}`,
        );
        return;
      }
      if (lock === null) {
        return; // une autre instance réconcilie déjà
      }

      const deadline = Date.now() + this.passWindowMs(lockTtlMs);
      await this.purgeTooOld(passId);

      const due = await this.store.due(Date.now(), this.options.batchSize);
      let processed = 0;
      for (const reservationId of due) {
        if (Date.now() >= deadline) {
          this.logger.warn(
            `[réconciliation ${passId}] Interrompue à l'approche de l'échéance du verrou ` +
              `(${processed}/${due.length} traité(s)) — le reliquat repart à la passe suivante.`,
          );
          break;
        }
        await this.processOne(reservationId, passId);
        processed++;
      }
    } catch (err) {
      this.logger.error(
        `[réconciliation ${passId}] Passe interrompue : ${message(err)}`,
      );
    } finally {
      if (lock !== null) {
        await this.store.releasePassLock(lock);
      }
      this.running = false;
    }
  }

  /**
   * Sort de l'index les candidats émis il y a plus de `maxAgeSeconds` (AC-1). Au-delà d'environ
   * 7 jours, une autorisation carte a expiré chez Stripe : il n'y a plus rien à capturer, et un
   * paiement encaissé non confirmé a été signalé à chaque fenêtre d'alerte depuis des jours.
   */
  private async purgeTooOld(passId: string): Promise<void> {
    const before = Date.now() - this.options.maxAgeSeconds * 1000;
    const stale = await this.store.olderThan(before, this.options.batchSize);
    for (const reservationId of stale) {
      try {
        const { record } = await this.store.read(reservationId);
        await this.store.remove(reservationId);
        this.logger.error(
          `[réconciliation ${passId}] Réservation ${reservationId} retirée de l'index après ` +
            `${this.options.maxAgeSeconds} s (dernier intentStatus : ${record?.lastIntentStatus ?? 'inconnu'}, ` +
            `${record?.attempts ?? 0} confirmation(s) tentée(s)). Vérification manuelle requise si un paiement a été encaissé.`,
        );
      } catch (err) {
        this.logger.error(
          `[réconciliation ${passId}] Purge de la réservation ${reservationId} impossible : ${message(err)}`,
        );
      }
    }
  }

  /** Traite un candidat, isolé : son échec n'interrompt jamais le lot. */
  private async processOne(
    reservationId: string,
    passId: string,
  ): Promise<void> {
    try {
      if (!isPmsGuid(reservationId)) {
        // Membre corrompu : l'interpoler changerait l'endpoint atteint. On nettoie et on alerte.
        this.logger.error(
          `[réconciliation ${passId}] Membre d'index « ${String(reservationId)} » inexploitable ` +
            '(pas un GUID de réservation) — retiré.',
        );
        await this.store.remove(reservationId);
        return;
      }

      const entry = await this.store.read(reservationId);
      if (entry.issuedAt === null) {
        // Échéance sans entrée d'index : le candidat est déjà sorti, il ne reste qu'à nettoyer.
        await this.store.remove(reservationId);
        return;
      }
      // État perdu (expiré, illisible) mais candidat indexé : reconstitué, jamais abandonné.
      const record = entry.record ?? freshRecord(reservationId, entry.issuedAt);
      await this.handle({ record: { ...record }, passId, now: Date.now() });
    } catch (err) {
      this.logger.error(
        `[réconciliation ${passId}] Réservation ${reservationId} : traitement impossible (${message(err)}) — repris à la passe suivante.`,
      );
    }
  }

  private async handle(candidate: Candidate): Promise<void> {
    const { record } = candidate;
    const id = record.reservationId;

    let state: PmsReservationState | undefined;
    try {
      state = await this.readState(id, candidate.passId);
    } catch (err) {
      await this.retryLater(
        candidate,
        `lecture de la réservation : ${describe(err)}`,
      );
      return;
    }

    const status = state?.status;
    if (typeof status === 'number' && PAST_CONFIRMATION.has(status)) {
      await this.settle(candidate, 'confirmée');
      return;
    }
    if (status === STATUS_NO_SHOW) {
      // Un NoShow suit une confirmation : rien à rattraper.
      await this.settle(candidate, 'non présentée (NoShow)');
      return;
    }
    if (status !== STATUS_PENDING && status !== STATUS_CANCELLED) {
      await this.retryLater(
        candidate,
        `statut de réservation non interprétable (${String(status)})`,
      );
      return;
    }

    let payment: PmsPaymentState | null;
    try {
      payment = await this.readPayment(id, candidate.passId);
    } catch (err) {
      await this.retryLater(
        candidate,
        `lecture du paiement : ${describe(err)}`,
      );
      return;
    }
    if (payment !== null) {
      record.paymentId = payment.paymentId ?? record.paymentId;
      if (payment.stripeReadable !== true) {
        // Stripe injoignable : doute. Ni confirmation, ni sortie de l'index.
        await this.retryLater(candidate, 'paiement illisible chez Stripe');
        return;
      }
      record.lastIntentStatus = payment.intentStatus ?? null;
    } else {
      record.lastIntentStatus = null;
    }
    const engaged =
      payment !== null &&
      typeof payment.intentStatus === 'string' &&
      MONEY_ENGAGED.has(payment.intentStatus);

    if (status === STATUS_CANCELLED) {
      if (!engaged) {
        await this.store.remove(id);
        this.logger.log(
          `[réconciliation ${candidate.passId}] Réservation ${id} annulée sans argent engagé — retirée de l'index.`,
        );
        return;
      }
      // Annulée mais payée : aucune confirmation possible, un humain doit rembourser.
      this.alert(
        candidate,
        payment?.intentStatus === 'succeeded'
          ? 'captured-not-confirmable'
          : 'payment-not-confirmed',
        false,
      );
      await this.waitAgain(candidate);
      return;
    }

    if (!engaged) {
      // Pending, aucun argent engagé (paiement pas encore autorisé) : rien à faire, on repasse.
      await this.waitAgain(candidate);
      return;
    }

    if (record.refusal !== null) {
      // Refus déterministe déjà reçu : jamais rejoué (AC-5), l'alerte suit sa fenêtre de répétition.
      this.alert(candidate, 'deterministic-refusal', false);
      await this.waitAgain(candidate);
      return;
    }

    await this.replayConfirmation(candidate);
  }

  /**
   * Rejoue la confirmation sous le **même** verrou single-flight que le navigateur (AC-4) et la
   * **même** clé d'idempotence : le PMS voit une seule confirmation, quel que soit son déclencheur.
   */
  private async replayConfirmation(candidate: Candidate): Promise<void> {
    const { record, passId } = candidate;
    const id = record.reservationId;

    let token: string | null;
    try {
      token = await this.confirmLock.acquire(id);
    } catch (err) {
      await this.retryLater(
        candidate,
        `verrou de confirmation : ${describe(err)}`,
      );
      return;
    }
    if (token === null) {
      // Le navigateur (ou une passe précédente) confirme en ce moment : on relira plus tard.
      this.logger.log(
        `[réconciliation ${passId}] Réservation ${id} : confirmation déjà en cours, nouvel essai à la passe suivante.`,
      );
      this.alertIfAged(candidate);
      await this.waitAgain(candidate);
      return;
    }

    try {
      record.attempts += 1;
      const path = PMS_CONFIRMATION_ENDPOINTS.confirm(id);
      await this.pms.post(
        path,
        undefined,
        this.serviceKey.confirmationContext(path, {
          correlationId: correlationOf(passId),
          idempotencyKey: confirmIdempotencyKey(id),
        }),
      );
    } catch (err) {
      const reason = classifyConfirmFailure(err);
      if (reason !== null && DETERMINISTIC_REFUSALS.has(reason)) {
        record.refusal = reason as DeterministicRefusal;
        this.alert(candidate, 'deterministic-refusal', true);
        await this.waitAgain(candidate);
        return;
      }
      await this.retryLater(
        candidate,
        `confirmation : ${reason ?? describe(err)}`,
      );
      return;
    } finally {
      await this.confirmLock.release(id, token);
    }

    await this.settle(candidate, 'confirmée par la réconciliation');
  }

  /** Sort le candidat de l'index (réservation aboutie) et retire le hold de l'index du balayeur. */
  private async settle(candidate: Candidate, outcome: string): Promise<void> {
    const id = candidate.record.reservationId;
    await this.store.remove(id);
    try {
      // `forget`, jamais `release` (D-7) : la clé d'idempotence de création doit survivre.
      await this.holds.forget(id);
    } catch {
      this.logger.warn(
        `[réconciliation ${candidate.passId}] Hold de la réservation ${id} non retiré de l'index du balayeur (il ignorera la Confirmed).`,
      );
    }
    this.logger.log(
      `[réconciliation ${candidate.passId}] Réservation ${id} ${outcome} — retirée de l'index.`,
    );
  }

  /** Repasse à l'intervalle normal, sans compter d'échec (attente du paiement, refus mémorisé…). */
  private async waitAgain(candidate: Candidate): Promise<void> {
    candidate.record.failures = 0;
    await this.store.update(
      candidate.record,
      candidate.now + this.options.intervalMs,
    );
  }

  /** Échec transitoire : backoff exponentiel borné, jamais de retrait (AC-5). */
  private async retryLater(
    candidate: Candidate,
    reason: string,
  ): Promise<void> {
    const { record } = candidate;
    record.failures += 1;
    const delayMs = this.backoffMs(record.failures);
    this.logger.warn(
      `[réconciliation ${candidate.passId}] Réservation ${record.reservationId} : ${reason} — ` +
        `nouvel essai dans ${Math.round(delayMs / 1000)} s (échec ${record.failures}).`,
    );
    this.alertIfAged(candidate);
    await this.store.update(record, candidate.now + delayMs);
  }

  /** `payment-not-confirmed` si de l'argent est (ou était, dernière lecture) engagé au-delà du seuil. */
  private alertIfAged(candidate: Candidate): void {
    const status = candidate.record.lastIntentStatus;
    if (status !== null && MONEY_ENGAGED.has(status)) {
      this.alert(candidate, 'payment-not-confirmed', false);
    }
  }

  /**
   * Émet `integrity.alert` (AC-6) : log structuré de niveau `error`, sans donnée personnelle ni
   * secret, au plus une fois par `alertRepeatSeconds` et par réservation.
   *
   * `payment-not-confirmed` attend le seuil d'âge ; les deux autres partent dès la première
   * constatation. `force` passe outre la fenêtre de répétition, une seule fois par réservation : à la
   * réception du refus déterministe (AC-5, alerte immédiate), qui n'est plus jamais rejoué ensuite.
   */
  private alert(
    candidate: Candidate,
    kind: IntegrityAlertKind,
    force: boolean,
  ): void {
    const { record, now } = candidate;
    const ageSeconds = Math.max(0, Math.floor((now - record.issuedAt) / 1000));
    if (
      kind === 'payment-not-confirmed' &&
      ageSeconds < this.options.alertAfterSeconds
    ) {
      return;
    }
    const repeatMs = this.options.alertRepeatSeconds * 1000;
    if (
      !force &&
      record.lastAlertAt !== null &&
      now - record.lastAlertAt < repeatMs
    ) {
      return;
    }
    record.lastAlertAt = now;
    this.alertLogger.error({
      event: 'integrity.alert',
      kind,
      reservationId: record.reservationId,
      paymentId: record.paymentId,
      intentStatus: record.lastIntentStatus,
      ageSeconds,
      attempts: record.attempts,
      correlationId: correlationOf(candidate.passId),
      msg: `integrity.alert ${kind} : réservation ${record.reservationId}, intervention requise.`,
    });
  }

  private async readState(
    reservationId: string,
    passId: string,
  ): Promise<PmsReservationState | undefined> {
    const path = PMS_CONFIRMATION_ENDPOINTS.state(reservationId);
    const res = await this.pms.get<PmsReservationState>(
      path,
      this.serviceContext('GET', path, passId),
    );
    return res.data;
  }

  /** Paiement Stripe le plus récent de la réservation, ou `null` s'il n'y en a aucun. */
  private async readPayment(
    reservationId: string,
    passId: string,
  ): Promise<PmsPaymentState | null> {
    const path = PMS_CONFIRMATION_ENDPOINTS.payment(reservationId);
    const res = await this.pms.get<PmsReservationPayment>(
      path,
      this.serviceContext('GET', path, passId),
    );
    if (!res.data) {
      throw new Error('réponse de paiement vide');
    }
    return res.data.payment ?? null;
  }

  /** Contexte de service : clé de service et corrélation de passe, **jamais** de JWT ni de cookie. */
  private serviceContext(
    method: 'GET',
    path: string,
    passId: string,
  ): PmsRequestContext {
    return this.serviceKey.serviceContext(method, path, {
      correlationId: correlationOf(passId),
    });
  }

  private backoffMs(failures: number): number {
    const interval = this.options.intervalMs;
    const cap = Math.max(
      interval,
      Math.min(interval * BACKOFF_MAX_FACTOR, BACKOFF_CAP_MS),
    );
    const exponent = Math.min(Math.max(failures - 1, 0), 30);
    return Math.min(interval * Math.pow(2, exponent), cap);
  }

  /** TTL du verrou de passe, dérivé du budget d'une passe pleine, plafonné (patron du balayeur). */
  private passLockTtlMs(): number {
    const batchBudgetMs =
      this.options.batchSize *
      this.options.pmsCallBudgetMs *
      PMS_CALLS_PER_ITEM;
    return Math.min(
      Math.max(60_000, this.options.intervalMs * 2, batchBudgetMs),
      PASS_LOCK_TTL_CAP_MS,
    );
  }

  /** Fenêtre utile de la passe : un candidat entamé doit finir avant l'expiration du verrou. */
  private passWindowMs(lockTtlMs: number): number {
    const margin = PMS_CALLS_PER_ITEM * this.options.pmsCallBudgetMs;
    return Math.max(lockTtlMs / 2, lockTtlMs - margin);
  }
}

function freshRecord(reservationId: string, issuedAt: number): ReconcileRecord {
  return {
    reservationId,
    issuedAt,
    attempts: 0,
    failures: 0,
    paymentId: null,
    lastIntentStatus: null,
    refusal: null,
    lastAlertAt: null,
  };
}

/** `X-Correlation-ID` de passe : une confirmation automatique reste traçable côté Stay-api. */
function correlationOf(passId: string): string {
  return `reconcile-${passId}`;
}

/** Libellé d'erreur pour les logs : statut HTTP s'il existe, jamais de corps ni de secret. */
function describe(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  const base = err instanceof Error ? err.name : 'erreur inconnue';
  return typeof status === 'number' ? `${base} (${status})` : base;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'erreur inconnue';
}
