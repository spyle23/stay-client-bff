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
import { SessionService } from '../auth/session.service';
import type { components } from '../../types/generated/pms';
import {
  isPmsGuid,
  PMS_RESERVATION_ENDPOINTS,
  PMS_STATUS_PENDING,
} from './booking-errors';
import { BOOKING_OPTIONS, type BookingOptions } from './booking.constants';
import {
  CheckoutHoldService,
  type CheckoutHoldRecord,
  type CreateIntentRecord,
  INTENT_MEMBER_PREFIX,
} from './checkout-hold.service';

type PmsReservation = components['schemas']['RoomReservationDto'];

/** `ReservationStatus` côté PMS (Pending=1, Confirmed=2, CheckedIn=3, CheckedOut=4, Cancelled=5, NoShow=6). */
const STATUS_PENDING = PMS_STATUS_PENDING;
const STATUS_CANCELLED = 5;
const STATUS_NO_SHOW = 6;

/**
 * Codes de statut que le BFF sait **interpréter**. Tout ce qui n'y figure pas — `undefined`,
 * `null`, corps illisible, code ajouté un jour côté PMS — est un **doute**, jamais une permission.
 */
const KNOWN_STATUSES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6]);

const INTERVAL_NAME = 'booking-checkout-hold-sweeper';

/** Appels PMS au pire par élément traité : la relecture puis l'annulation. */
const PMS_CALLS_PER_ITEM = 2;

/**
 * Plafond du TTL du verrou de passe (ms). Au-delà, un processus mort priverait la plateforme de
 * tout balayage pendant trop longtemps — l'inventaire resterait gelé faute de balayeur.
 */
const SWEEPER_LOCK_TTL_CAP_MS = 300_000;

/** Taille de page demandée à `/my-reservations` lors d'une réconciliation d'intention. */
const MY_RESERVATIONS_PAGE_SIZE = 100;

/**
 * **Balayeur de Holds de checkout** (story 2.4 — FR-9 / FR-14 / AR-18-D3).
 *
 * Le PMS n'a **aucun job d'expiration** des réservations `Pending` (le seul récurrent est la
 * rétention RGPD du journal d'emails) et ne sait pas « tenir » une chambre : c'est la `Pending`
 * elle-même qui l'immobilise. Sans ce balayeur, chaque tunnel abandonné gèlerait une vraie chambre
 * d'un vrai hôtel **indéfiniment**. C'est le repli client explicitement prévu par la dépendance D3
 * — il disparaîtra le jour où le PMS portera l'expiration.
 *
 * ## Invariant non négociable (FR-14)
 *
 * **Annuler une réservation payée est un incident de production ; garder une chambre gelée
 * quelques minutes de trop est une gêne.** En cas de doute, le balayeur **ne libère pas**. Quatre
 * gardes, dans cet ordre :
 * 1. un hold marqué `paymentStarted` (posé par la story 3.1) n'est **jamais** balayé ;
 * 2. la réservation est **relue au PMS** et n'est annulée que si son statut est `Pending` ;
 * 3. un statut **non reconnu** (`undefined`, `null`, code hors table, corps illisible) est un
 *    doute : report, jamais annulation — seul un statut *reconnu* et non-`Pending` autorise à
 *    retirer le hold sans annuler ;
 * 4. l'enregistrement est **relu juste avant l'annulation** : un paiement a pu démarrer pendant
 *    l'aller-retour PMS de l'étape 2, et la décision serait alors prise sur un état périmé.
 *
 * ## Deux types d'entrées dans un même index
 *
 * L'index trié mêle des **holds** (membre = identifiant de réservation) et des **intentions de
 * création** (membre préfixé `intent:`, correctif D1) : une réservation dont la réponse de création
 * s'est perdue n'a pas d'identifiant connu et ne peut donc pas être suivie par un hold. Elle est
 * retrouvée via `/roomreservations/my-reservations` puis annulée. Une seule passe, un seul verrou
 * et un seul lot couvrent les deux.
 *
 * ## Robustesse
 *
 * Chaque élément est traité isolément : un rejet non capturé dans une tâche planifiée remonte en
 * `unhandledRejection` et peut abattre le processus. Un échec reporte l'entrée (tentatives
 * bornées) plutôt que de la perdre — un hold oublié est une chambre gelée pour toujours.
 *
 * Le balayeur tourne **hors requête HTTP** : `CorrelationService` n'a rien à fournir, d'où
 * l'identifiant de passe généré ici, joint à chaque log **et propagé au PMS** en
 * `X-Correlation-ID` (sans lui, une annulation automatique serait intraçable côté Stay-api, là où
 * elle laisse pourtant une trace en base).
 */
@Injectable()
export class CheckoutHoldSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CheckoutHoldSweeper.name);
  private running = false;

  /**
   * Échecs **consécutifs** de report, par membre d'index (correctif de la revue 2.4).
   *
   * Le compteur de tentatives vit dans Redis : quand c'est précisément l'écriture Redis qui échoue
   * (instance en `maxmemory` + `noeviction`, par exemple), il reste bloqué à 0 et le plafond n'est
   * jamais atteint — le balayeur martèlerait alors le PMS à chaque passe, indéfiniment. Ce
   * compteur en mémoire est le repli : au bout du même nombre d'échecs, l'entrée est abandonnée
   * bruyamment. Il est borné et purgé dès qu'un report aboutit.
   */
  private readonly postponeFailures = new Map<string, number>();

  constructor(
    private readonly holds: CheckoutHoldService,
    private readonly sessions: SessionService,
    private readonly pms: PmsClientService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(BOOKING_OPTIONS) private readonly options: BookingOptions,
  ) {}

  onModuleInit(): void {
    if (!this.options.sweeperEnabled) {
      this.logger.log('Balayeur de holds désactivé par configuration.');
      return;
    }
    const interval = setInterval(() => {
      void this.sweep();
    }, this.options.sweeperIntervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.logger.log(
      `Balayeur de holds actif (toutes les ${this.options.sweeperIntervalMs} ms, lot ${this.options.sweeperBatchSize}).`,
    );
  }

  onModuleDestroy(): void {
    // Sans ce retrait, le timer survit à l'arrêt : les suites Jest resteraient ouvertes et un
    // arrêt gracieux ne le serait pas.
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /**
   * Une passe de balayage. Publique : les tests l'appellent directement, sans planificateur.
   *
   * Deux protections contre le recouvrement : un drapeau in-process (une passe lente ne se
   * chevauche pas elle-même) et un verrou Redis (deux instances BFF ne doivent pas annuler les
   * mêmes réservations en parallèle).
   *
   * La boucle s'**interrompt à l'approche de l'échéance du verrou** : le reliquat reste dans
   * l'index et repart à la passe suivante. Sans cela, un lot plein dépasserait le TTL et une
   * seconde instance annulerait en parallèle les réservations que celle-ci traite encore.
   */
  async sweep(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const passId = randomUUID().slice(0, 8);
    let lock: string | null = null;
    try {
      const lockTtlMs = this.sweeperLockTtlMs();
      lock = await this.holds.acquireSweeperLock(lockTtlMs);
      if (lock === null) {
        return; // une autre instance balaie déjà
      }
      const due = await this.holds.dueHolds(
        Date.now(),
        this.options.sweeperBatchSize,
      );
      const deadline = this.passDeadline(lockTtlMs);
      let processed = 0;
      for (const member of due) {
        if (Date.now() >= deadline) {
          this.logger.warn(
            `[passe ${passId}] Interrompue à l'approche de l'échéance du verrou ` +
              `(${processed}/${due.length} traité(s)) — le reliquat repart à la passe suivante.`,
          );
          break;
        }
        await this.processMember(member, passId);
        processed++;
      }
      if (processed > 0) {
        this.logger.log(
          `[passe ${passId}] ${processed} entrée(s) échue(s) traitée(s).`,
        );
      }
    } catch (err) {
      // Une passe ratée n'est jamais fatale : la suivante reprendra le même index.
      this.logger.error(
        `[passe ${passId}] Balayage interrompu : ${message(err)}`,
      );
    } finally {
      if (lock !== null) {
        await this.holds.releaseSweeperLock(lock);
      }
      this.forgetStalePostponeFailures();
      this.running = false;
    }
  }

  /** Aiguille un membre d'index vers le traitement de hold ou de réconciliation d'intention. */
  private async processMember(member: string, passId: string): Promise<void> {
    if (member.startsWith(INTENT_MEMBER_PREFIX)) {
      await this.processIntent(
        member.slice(INTENT_MEMBER_PREFIX.length),
        passId,
      );
      return;
    }
    await this.processOne(member, passId);
  }

  private async processOne(
    reservationId: string,
    passId: string,
  ): Promise<void> {
    try {
      if (!isPmsGuid(reservationId)) {
        // Membre d'index corrompu : aucun appel PMS n'est possible sans identifiant exploitable,
        // et l'interpoler tel quel changerait l'endpoint atteint. On nettoie et on alerte.
        this.logger.error(
          `[passe ${passId}] Membre d'index « ${String(reservationId)} » ` +
            "inexploitable (ni GUID de réservation, ni intention) — retiré de l'index.",
        );
        await this.holds.forget(reservationId);
        return;
      }

      const record = await this.holds.read(reservationId);
      if (!record) {
        // Entrée d'index orpheline (enregistrement expiré) : rien à libérer, on nettoie l'index.
        await this.holds.forget(reservationId);
        return;
      }

      if (record.paymentStarted) {
        // FR-14 : un paiement est engagé. On sort de l'index — le cycle de vie appartient
        // désormais au flux de paiement/confirmation (story 3.1).
        this.logger.log(
          `[passe ${passId}] Réservation ${reservationId} : paiement engagé, hold non libéré.`,
        );
        await this.holds.forget(reservationId);
        return;
      }

      if (record.attempts >= this.options.sweeperMaxAttempts) {
        // Abandon **bruyant** : la chambre reste immobilisée jusqu'au filet 48 h du PMS (D3).
        this.logger.error(
          `[passe ${passId}] Réservation ${reservationId} : libération impossible après ` +
            `${record.attempts} tentatives — chambre ${record.roomId} (hôtel ${record.hotelId}) ` +
            'toujours immobilisée. Intervention manuelle requise.',
        );
        await this.holds.forget(reservationId);
        return;
      }

      const reservation = await this.readReservation(record, passId);
      const status = reservation?.status ?? null;

      if (typeof status !== 'number' || !KNOWN_STATUSES.has(status)) {
        // Statut absent, `null`, ou code que le BFF ne sait pas interpréter : **doute**, donc
        // report. Le laisser tomber en « retrait sans annulation » abandonnerait silencieusement
        // une chambre potentiellement gelée, sans la moindre alerte.
        await this.postponeHold(
          reservationId,
          passId,
          `statut non interprétable (${describeStatus(status)})`,
        );
        return;
      }
      if (status === STATUS_CANCELLED || status === STATUS_NO_SHOW) {
        // Déjà libérée par ailleurs : plus rien à tenir, et la mémoire d'idempotence doit partir
        // (un rejeu de création ne doit pas resservir une réservation morte).
        await this.holds.release(reservationId);
        return;
      }
      if (status !== STATUS_PENDING) {
        // `Confirmed` / `CheckedIn` / `CheckedOut` : réservation aboutie — ne jamais y toucher.
        this.logger.log(
          `[passe ${passId}] Réservation ${reservationId} : statut ${status}, hold retiré sans annulation.`,
        );
        await this.holds.forget(reservationId);
        return;
      }

      // ⚠️ Relecture obligatoire : `record` date d'AVANT l'aller-retour PMS ci-dessus. La story 3.1
      // peut avoir posé `paymentStarted` entre-temps — annuler sur la foi de l'état périmé serait
      // exactement l'incident que FR-14 interdit.
      const fresh = await this.holds.read(reservationId);
      if (!fresh) {
        this.logger.error(
          `[passe ${passId}] Réservation ${reservationId} : enregistrement disparu pendant la ` +
            "passe — annulation abandonnée (doute sur l'état du paiement). La chambre peut " +
            'rester immobilisée. Intervention manuelle requise.',
        );
        await this.holds.forget(reservationId);
        return;
      }
      if (fresh.paymentStarted) {
        this.logger.log(
          `[passe ${passId}] Réservation ${reservationId} : paiement engagé pendant la passe, ` +
            'annulation abandonnée.',
        );
        await this.holds.forget(reservationId);
        return;
      }

      await this.cancelReservation(fresh.sid, reservationId, passId);
      await this.holds.release(reservationId);
      this.logger.log(
        `[passe ${passId}] Réservation ${reservationId} libérée (hold expiré, aucun paiement engagé).`,
      );
    } catch (err) {
      await this.postponeHold(reservationId, passId, message(err));
    }
  }

  /**
   * **Réconciliation d'une intention de création** (correctif D1).
   *
   * L'intention a été écrite avant le POST au PMS ; elle n'a jamais été promue en hold, donc la
   * création n'a pas abouti *de notre point de vue*. Deux mondes possibles, indiscernables sans le
   * PMS : soit la ligne n'a jamais été insérée (rien à faire), soit elle l'a été et gèle une vraie
   * chambre sans que personne ne la suive. On tranche en interrogeant le PMS avec la session du
   * propriétaire, seul chemin autorisé vers `my-reservations`.
   */
  private async processIntent(intentId: string, passId: string): Promise<void> {
    try {
      const record = await this.holds.readIntent(intentId);
      if (!record) {
        // Enregistrement expiré : plus aucune donnée pour chercher — on nettoie l'index.
        await this.holds.dropIntent(intentId);
        return;
      }

      if (record.attempts >= this.options.sweeperMaxAttempts) {
        this.logger.error(
          `[passe ${passId}] Intention ${intentId} : réconciliation impossible après ` +
            `${record.attempts} tentatives — une réservation « Pending » peut immobiliser la ` +
            `chambre ${record.roomId} (hôtel ${record.hotelId}, séjour ${record.checkInDate} → ` +
            `${record.checkOutDate}) sans qu'aucun hold ne la suive. Intervention manuelle requise.`,
        );
        await this.holds.dropIntent(intentId);
        return;
      }

      const orphan = await this.findOrphanReservation(record, passId);
      if (orphan === null) {
        // Le PMS n'a jamais écrit : l'appel a échoué avant l'insertion. Rien à annuler.
        this.logger.log(
          `[passe ${passId}] Intention ${intentId} : aucune réservation « Pending » ` +
            "correspondante — la création n'a jamais abouti côté PMS.",
        );
        await this.holds.dropIntent(intentId);
        return;
      }

      await this.cancelReservation(record.sid, orphan, passId);
      // La clé d'idempotence est purgée en compare-and-delete : si le voyageur a entre-temps
      // recréé une réservation vivante pour le même séjour, sa mémoire ne doit pas sauter.
      await this.holds.clearIdempotentKey(record.stayKey, orphan);
      await this.holds.dropIntent(intentId);
      this.logger.warn(
        `[passe ${passId}] Intention ${intentId} réconciliée : réservation ${orphan} ` +
          `(chambre ${record.roomId}) annulée — sa création avait été perdue en vol.`,
      );
    } catch (err) {
      await this.postponeIntent(intentId, passId, message(err));
    }
  }

  /**
   * Cherche, parmi les réservations `Pending` du compte, celle qu'une création perdue a pu laisser.
   *
   * `GET /roomreservations/my-reservations` est le **seul** endpoint qui permette de retrouver une
   * réservation dont l'identifiant ne nous est jamais parvenu. Il est réservé au `Customer`, d'où
   * la session mémorisée dans l'intention. Le filtre `Status=Pending` est appliqué côté PMS *et*
   * revérifié ici : une chambre + des dates identiques ne suffisent pas à annuler une réservation
   * déjà confirmée.
   */
  private async findOrphanReservation(
    record: CreateIntentRecord,
    passId: string,
  ): Promise<string | null> {
    const res = await this.sessions.withCustomerAuth(record.sid, (token) =>
      this.pms.getList<PmsReservation>(
        PMS_RESERVATION_ENDPOINTS.myReservations(
          STATUS_PENDING,
          MY_RESERVATIONS_PAGE_SIZE,
        ),
        this.context(token, passId),
      ),
    );

    const candidates = res.data ?? [];
    const match = candidates.find(
      (candidate) =>
        candidate.status === STATUS_PENDING &&
        candidate.roomId === record.roomId &&
        dateOnly(candidate.checkInDate) === record.checkInDate &&
        dateOnly(candidate.checkOutDate) === record.checkOutDate,
    );

    if (!match) {
      // Conclure « rien n'a été écrit » alors que la page suivante n'a pas été lue laisserait une
      // vraie chambre gelée en silence. On préfère reporter (puis abandonner bruyamment).
      if (res.pagination?.hasNextPage === true) {
        throw new Error(
          `réservations du compte tronquées à ${MY_RESERVATIONS_PAGE_SIZE} entrées : ` +
            'impossible de conclure à une absence de réservation',
        );
      }
      return null;
    }
    if (!isPmsGuid(match.id)) {
      throw new Error(
        'réservation correspondante trouvée mais sans identifiant exploitable',
      );
    }
    return match.id;
  }

  /** Reporte un hold en comptant la tentative — jamais de perte silencieuse. */
  private async postponeHold(
    reservationId: string,
    passId: string,
    reason: string,
  ): Promise<void> {
    await this.deferRetry(
      reservationId,
      `Réservation ${reservationId}`,
      passId,
      reason,
      (nextAt) => this.holds.reschedule(reservationId, nextAt),
      () => this.holds.forget(reservationId),
    );
  }

  /** Reporte la réconciliation d'une intention, même discipline que pour un hold. */
  private async postponeIntent(
    intentId: string,
    passId: string,
    reason: string,
  ): Promise<void> {
    await this.deferRetry(
      INTENT_MEMBER_PREFIX + intentId,
      `Intention ${intentId}`,
      passId,
      reason,
      (nextAt) => this.holds.rescheduleIntent(intentId, nextAt),
      () => this.holds.dropIntent(intentId),
    );
  }

  /**
   * Report d'une entrée, avec **double** garde-fou contre le martèlement.
   *
   * Le compteur qui fait foi vit dans Redis (`attempts`), mais il ne peut plus être incrémenté
   * quand c'est l'écriture Redis elle-même qui échoue. Le compteur in-process prend alors le
   * relais : au bout du même plafond, l'entrée est retirée de l'index — bruyamment, car une
   * chambre peut rester immobilisée.
   */
  private async deferRetry(
    member: string,
    label: string,
    passId: string,
    reason: string,
    push: (nextAt: number) => Promise<number | null>,
    abandon: () => Promise<void>,
  ): Promise<void> {
    this.logger.warn(
      `[passe ${passId}] ${label} : traitement reporté (${reason}).`,
    );
    try {
      await push(Date.now() + this.options.sweeperRetryDelayMs);
      this.postponeFailures.delete(member);
      return;
    } catch (err) {
      const failures = (this.postponeFailures.get(member) ?? 0) + 1;
      this.postponeFailures.set(member, failures);
      this.logger.error(
        `[passe ${passId}] ${label} : report impossible ` +
          `(${failures}/${this.options.sweeperMaxAttempts}) : ${message(err)}`,
      );
      if (failures < this.options.sweeperMaxAttempts) {
        return;
      }
    }

    try {
      await abandon();
      this.postponeFailures.delete(member);
      this.logger.error(
        `[passe ${passId}] ${label} : abandonnée après ` +
          `${this.options.sweeperMaxAttempts} reports impossibles — le compteur persistant n'a ` +
          'jamais pu être incrémenté. Une chambre peut rester immobilisée. ' +
          'Intervention manuelle requise.',
      );
    } catch (err) {
      // Le compteur in-process reste au plafond : la passe suivante retentera l'abandon.
      this.logger.error(
        `[passe ${passId}] ${label} : retrait de l'index impossible : ${message(err)}`,
      );
    }
  }

  /**
   * Relit la réservation avec le JWT du **propriétaire** : `GET /roomreservations/{id}` est réservé
   * au `Customer` et le PMS refuse la réservation d'autrui. D'où le `sid` mémorisé dans le hold.
   */
  private async readReservation(
    record: CheckoutHoldRecord,
    passId: string,
  ): Promise<PmsReservation | null> {
    const res = await this.sessions.withCustomerAuth(record.sid, (token) =>
      this.pms.get<PmsReservation>(
        PMS_RESERVATION_ENDPOINTS.byId(record.reservationId),
        this.context(token, passId),
      ),
    );
    return res.data ?? null;
  }

  private async cancelReservation(
    sid: string,
    reservationId: string,
    passId: string,
  ): Promise<void> {
    await this.sessions.withCustomerAuth(sid, (token) =>
      this.pms.post(
        PMS_RESERVATION_ENDPOINTS.cancel(reservationId),
        undefined,
        this.context(token, passId),
      ),
    );
  }

  /**
   * Contexte PMS d'une passe : jeton du propriétaire **et** corrélation.
   *
   * L'identifiant de passe doit atteindre Stay-api : une annulation automatique y laisse une trace
   * en base, et sans corrélation elle est indistinguable d'une annulation faite par un humain.
   */
  private context(bearerToken: string, passId: string): PmsRequestContext {
    return { bearerToken, correlationId: `sweeper-${passId}` };
  }

  /**
   * TTL du verrou de passe, **dérivé du budget réel** d'une passe pleine.
   *
   * Arbitrage retenu (revue 2.4) : dimensionner le TTL sur `lot × budget PMS × appels par élément`
   * **et** interrompre la boucle avant l'échéance (`passDeadline`), plutôt que de renouveler le
   * verrou en cours de route — le renouvellement ajouterait un aller-retour Redis par élément et
   * un script de plus, pour une garantie que l'interruption offre déjà sans rien coûter.
   * Le plafond évite qu'un processus mort ne prive la plateforme de balayage trop longtemps.
   */
  private sweeperLockTtlMs(): number {
    const batchBudgetMs =
      this.options.sweeperBatchSize *
      this.options.pmsCallBudgetMs *
      PMS_CALLS_PER_ITEM;
    return Math.min(
      Math.max(60_000, this.options.sweeperIntervalMs * 2, batchBudgetMs),
      SWEEPER_LOCK_TTL_CAP_MS,
    );
  }

  /**
   * Instant au-delà duquel plus aucun élément n'est entamé : il faut qu'un élément déjà commencé
   * puisse finir **avant** l'expiration du verrou. On garde au moins la moitié de la fenêtre
   * exploitable, sinon une configuration extrême produirait des passes qui ne traitent rien.
   */
  private passDeadline(lockTtlMs: number): number {
    const margin = PMS_CALLS_PER_ITEM * this.options.pmsCallBudgetMs;
    return Date.now() + Math.max(lockTtlMs / 2, lockTtlMs - margin);
  }

  /** Borne le compteur in-process : il ne doit pas croître avec le trafic. */
  private forgetStalePostponeFailures(): void {
    const limit = Math.max(100, this.options.sweeperBatchSize * 10);
    if (this.postponeFailures.size > limit) {
      this.logger.warn(
        `Compteur de reports impossibles purgé (${this.postponeFailures.size} entrées) : ` +
          'le magasin d’état refuse durablement les écritures.',
      );
      this.postponeFailures.clear();
    }
  }
}

/** Extrait la date-only d'un datetime PMS ; chaîne vide si le champ manque. */
function dateOnly(value: string | null | undefined): string {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

/** Libellé de journalisation d'un statut non interprétable. */
function describeStatus(status: number | null): string {
  return status === null ? 'absent' : `code ${status}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'erreur inconnue';
}
