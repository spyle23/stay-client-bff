import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { RequestSession } from '../../common/decorators/current-session.decorator';
import { CorrelationService } from '../../common/correlation/correlation.service';
import { toMinorUnits } from '../../common/money/minor-units';
import type { PmsRequestContext } from '../../integration/pms/pms-client.service';
import { PmsClientService } from '../../integration/pms/pms-client.service';
import { PmsRequestError } from '../../integration/pms/pms-errors';
import { ServiceKeyProvider } from '../../integration/pms/service-key.provider';
import type { components } from '../../types/generated/pms';
import { SessionService } from '../auth/session.service';
import { BookingService } from '../booking/booking.service';
import { CheckoutHoldService } from '../booking/checkout-hold.service';
import type {
  BookingReservationDto,
  ReservationStatusName,
} from '../booking/dto/reservation.dto';
import {
  classifyConfirmFailure,
  PMS_CONFIRMATION_ENDPOINTS,
  toConfirmException,
} from './confirm-errors';
import { ConfirmationLockService } from './confirmation-lock.service';
import type { ConfirmationProofDto } from './dto/confirmation-proof.dto';
import type { PaymentIntentDto } from './dto/payment-intent.dto';
import {
  classifyPaymentFailure,
  PAYMENT_REASON_KEY,
  PMS_PAYMENT_ENDPOINTS,
  toPaymentException,
} from './payment-errors';
import { PAYMENT_OPTIONS, type PaymentOptions } from './payment.constants';

type PmsPaymentIntent = components['schemas']['PaymentIntentResultDto'];
type PmsConfirmation = components['schemas']['ConfirmationResultDto'];

/**
 * Statuts déjà au-delà de la confirmation : la preuve se construit depuis la relecture, sans
 * appeler le PMS (chemin idempotent rapide, AC-2). Un séjour commencé ou terminé a forcément été
 * confirmé.
 */
const PAST_CONFIRMATION: ReadonlySet<ReservationStatusName> = new Set([
  'Confirmed',
  'CheckedIn',
  'CheckedOut',
]);

/** Message des confirmations encore en vol au-delà de l'attente du perdant — rejouable. */
const CONFIRMATION_IN_FLIGHT_MESSAGE =
  'Votre confirmation est en cours de traitement. Réessayez dans un instant.';

/** Message unique des ruptures de contrat PMS — jamais de détail technique côté navigateur. */
const BROKEN_CONTRACT_MESSAGE = 'Réponse inattendue du service de paiement.';

/**
 * Domaine `payment` — **autorisation carte du tunnel** (story 3.1, FR-12 / FR-14 / AR-14).
 *
 * Trois responsabilités, et rien de plus :
 *
 * 1. **Demander le PaymentIntent au PMS** (jamais à Stripe : le BFF ne détient aucune clé secrète,
 *    AR-14) et n'en réexposer au navigateur que le strict nécessaire au Payment Element.
 * 2. **Geler le balayeur de holds** avant que le `clientSecret` ne parte — sans quoi une
 *    autorisation pourrait aboutir sur une réservation que le balayeur vient d'annuler (FR-14).
 * 3. **Contrôler le montant** contre le total réel de la réservation : c'est le BFF qui oppose au
 *    PMS un montant vérifié, jamais le navigateur (leçon de la boucle `price-changed` de la 2.4).
 *
 * ⚠️ **Hors périmètre, volontairement** : aucune capture, aucune confirmation, aucun job de
 * réconciliation. Sous capture manuelle (D8) les fonds sont seulement **retenus** ; l'encaissement
 * et la transition `Pending → Confirmed` appartiennent à la story 3.2, la réconciliation à la 3.4.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly pms: PmsClientService,
    private readonly sessions: SessionService,
    private readonly booking: BookingService,
    private readonly holds: CheckoutHoldService,
    private readonly correlation: CorrelationService,
    private readonly serviceKey: ServiceKeyProvider,
    private readonly confirmLock: ConfirmationLockService,
    @Inject(PAYMENT_OPTIONS) private readonly options: PaymentOptions,
  ) {}

  // --- Confirmation ferme (story 3.2) -------------------------------------------------------

  /**
   * Confirme la Réservation après autorisation et rend la **preuve** (story 3.2, B3).
   *
   * L'ordre est l'invariant :
   * 1. relire la réservation **sous l'identité du voyageur** (propriété + statut) ;
   * 2. déjà confirmée → preuve depuis cette relecture, `forget`, **aucun** appel PMS ;
   * 3. `Pending` sans intent émis (`intentIssued` du hold) → 409, **aucun** appel PMS ;
   * 4. verrou single-flight Redis (deux onglets → un seul appel) ;
   * 5. `POST /reservations/{id}/confirm` sous `X-Service-Key` (le PMS capture puis confirme) ;
   * 6. succès → `holds.forget` (jamais `release`), preuve relue du serveur.
   *
   * ⚠️ Les remparts 1, 2 et 4 sont du confort et de l'économie d'appels. Les garanties
   * d'idempotence (une capture, une transition, un e-mail) sont celles du PMS (#152). Le rempart 3
   * est une **garantie** côté BFF : le PMS confirme sans capture une réservation sans ligne
   * `Payment`, et `intentIssued` n'est posé qu'après sa création (le PMS ne la crée qu'après le
   * succès de Stripe). Le refus côté PMS d'une telle confirmation est suivi par spyle23/hotelerie#182.
   */
  async confirm(
    session: RequestSession,
    reservationId: string,
  ): Promise<ConfirmationProofDto> {
    return this.confirmOnce(session, reservationId, true);
  }

  private async confirmOnce(
    session: RequestSession,
    reservationId: string,
    mayWait: boolean,
  ): Promise<ConfirmationProofDto> {
    // 1. Relecture sous l'identité du voyageur : le PMS refuse (404) la réservation d'un tiers.
    const reservation = await this.readForConfirmation(session, reservationId);

    // 2. Chemin idempotent rapide : rechargement, retour arrière, second onglet arrivé après coup.
    if (PAST_CONFIRMATION.has(reservation.status)) {
      await this.forgetHold(reservationId);
      return toProof(reservation, {
        capturedAmount: null,
        alreadyConfirmed: true,
      });
    }
    if (reservation.status === 'Cancelled') {
      throw toConfirmException('reservation-cancelled');
    }
    if (reservation.status !== 'Pending') {
      // NoShow ou statut inconnu : ne jamais tenter de confirmer un état qu'on ne comprend pas.
      throw toConfirmException('rejected');
    }

    // 3. ⚠️ Intent émis exigé (revues rondes 1 et 2). Le PMS confirme SANS capture une réservation
    //    qui n'a aucune ligne `Payment` (#152, chemin du back-office) ; or une réservation du tunnel
    //    n'en a qu'une fois l'intent créé chez Stripe. Sans ce rempart, remplacer `/booking/payment`
    //    par `/booking/confirmation` dans l'URL donnait une chambre `Confirmed` sans aucun débit.
    //    `paymentStarted` ne suffit pas : posé AVANT l'appel d'intent, il survit à un intent en échec
    //    (Stripe, circuit ouvert, timeout, 5xx). `intentIssued` n'est posé qu'après le succès du PMS,
    //    juste avant que le `clientSecret` ne parte : une autorisation n'est possible qu'avec lui.
    //    Panne Redis → 503 (aucun appel PMS) ; un hold perdu après autorisation reste rattrapable
    //    par la réconciliation (#5).
    await this.assertIntentIssued(reservationId);

    // 4. Verrou single-flight. Une panne Redis remonte ici en 503 (jamais 500) et interrompt tout :
    //    aucun appel PMS ne part sans le verrou.
    const token = await this.confirmLock.acquire(reservationId);
    if (token === null) {
      if (!mayWait) {
        throw new ServiceUnavailableException(CONFIRMATION_IN_FLIGHT_MESSAGE);
      }
      // Un autre onglet confirme : attendre qu'il ait fini, puis RELIRE. Déjà confirmée → la même
      // preuve ; toujours `Pending` (le gagnant a échoué) → une seule nouvelle tentative.
      await this.waitForConfirmationInFlight(reservationId);
      return this.confirmOnce(session, reservationId, false);
    }

    try {
      // 5. Confirmation PMS (capture comprise, #152).
      const result = await this.requestPmsConfirmation(reservationId);

      // 6. Preuve relue du serveur, puis le hold sort de l'index du balayeur.
      const proof = await this.proofAfterConfirmation(
        session,
        reservation,
        result,
      );
      await this.forgetHold(reservationId);
      return proof;
    } finally {
      await this.confirmLock.release(reservationId, token);
    }
  }

  /**
   * Refuse (409 `payment-not-authorized`) une réservation `Pending` dont le tunnel n'a jamais émis
   * d'intent : hold absent, ou présent sans `intentIssued` (gel posé mais intent en échec compris).
   *
   * `paymentStarted` n'est volontairement pas lu : il peut être vrai sans paiement (intent en échec)
   * et faux avec un paiement (gel relâché par un refus postérieur à l'émission).
   *
   * La lecture passe par `CheckoutHoldService`, dont toute panne Redis remonte en 503 : dans le
   * doute, on ne confirme pas.
   */
  private async assertIntentIssued(reservationId: string): Promise<void> {
    const hold = await this.holds.read(reservationId);
    if (hold?.intentIssued !== true) {
      this.logger.warn(
        `Confirmation refusée pour la réservation ${reservationId} : aucun intent émis.`,
      );
      throw toConfirmException('payment-not-authorized');
    }
  }

  /** Relecture de la réservation, avec le motif de confirmation sur une réservation introuvable. */
  private async readForConfirmation(
    session: RequestSession,
    reservationId: string,
  ): Promise<BookingReservationDto> {
    try {
      return await this.booking.getReservation(session, reservationId);
    } catch (err) {
      // `booking` signale l'introuvable (ou la réservation d'un autre compte) par son propre motif :
      // l'écran de confirmation attend le sien.
      if (
        err instanceof HttpException &&
        err.getStatus() === Number(HttpStatus.NOT_FOUND)
      ) {
        throw toConfirmException('reservation-not-found');
      }
      throw err;
    }
  }

  /**
   * `POST /reservations/{id}/confirm` sous `X-Service-Key` — la SEULE route qui le porte (AR-8).
   *
   * **`maxRetries` par défaut** — contrairement à l'intent : le PMS garantit l'idempotence de cette
   * route (transition sous verrou, capture idempotente), et c'est justement le rejeu qui protège
   * contre une réponse perdue après capture.
   */
  private async requestPmsConfirmation(
    reservationId: string,
  ): Promise<PmsConfirmation> {
    const path = PMS_CONFIRMATION_ENDPOINTS.confirm(reservationId);

    let ctx: PmsRequestContext;
    try {
      ctx = this.serviceKey.confirmationContext(path, {
        ...this.pmsContext(),
        idempotencyKey: this.confirmIdempotencyKey(reservationId),
      });
    } catch (err) {
      // Clé de service absente : configuration du BFF, pas une faute du voyageur → 503.
      this.logger.error(
        `Confirmation impossible : ${err instanceof Error ? err.message : 'clé de service indisponible'}`,
      );
      throw new ServiceUnavailableException(BROKEN_CONTRACT_MESSAGE);
    }

    let data: PmsConfirmation | undefined;
    try {
      data = (await this.pms.post<PmsConfirmation>(path, undefined, ctx)).data;
    } catch (err) {
      const reason = classifyConfirmFailure(err);
      if (reason !== null) {
        this.logger.warn(
          `Confirmation refusée pour la réservation ${reservationId} : « ${reason} ».`,
        );
        throw toConfirmException(reason);
      }
      if (
        err instanceof PmsRequestError &&
        (err.status === 401 || err.status === 403)
      ) {
        this.logger.error(
          `Clé de service refusée par le PMS (statut ${err.status}) sur la confirmation.`,
        );
        throw new ServiceUnavailableException(BROKEN_CONTRACT_MESSAGE);
      }
      throw err; // panne → 503 par le filtre global
    }

    if (!data) {
      this.logger.error(
        `Contrat PMS rompu sur la confirmation de la réservation ${reservationId} : réponse vide.`,
      );
      throw new ServiceUnavailableException(BROKEN_CONTRACT_MESSAGE);
    }
    return data;
  }

  /**
   * Preuve **relue du serveur** après confirmation : les lignes de service écartées au moment de la
   * confirmation (D6) ont changé le total, et c'est l'état persisté qui fait foi.
   *
   * Relecture en échec : la confirmation a pourtant réussi. Plutôt que de faire réessayer au
   * voyageur une opération déjà faite, la preuve est reconstituée depuis la première lecture et le
   * résultat du PMS (statut confirmé, lignes écartées annulées, total du PMS).
   */
  private async proofAfterConfirmation(
    session: RequestSession,
    before: BookingReservationDto,
    result: PmsConfirmation,
  ): Promise<ConfirmationProofDto> {
    const flags = {
      capturedAmount: this.capturedMinorUnits(result, before.currency),
      alreadyConfirmed: result.alreadyConfirmed === true,
    };

    try {
      const after = await this.booking.getReservation(
        session,
        before.reservationId,
      );
      return toProof(after, flags);
    } catch {
      this.logger.warn(
        `Relecture impossible après confirmation de la réservation ${before.reservationId} : ` +
          'preuve reconstituée depuis la réponse du PMS.',
      );
      return toProof(reconstituted(before, result), flags);
    }
  }

  /**
   * Montant encaissé en unités mineures, ou `null` s'il ne peut pas être affiché honnêtement.
   *
   * Le PMS rend des unités MAJEURES dans la devise de l'hôtel. Une devise qui diverge de celle de la
   * réservation relue est une rupture de contrat : afficher ce montant dans la mauvaise devise serait
   * pire que de ne pas l'afficher.
   */
  private capturedMinorUnits(
    result: PmsConfirmation,
    currency: string,
  ): number | null {
    const captured = result.capturedAmount;
    const pmsCurrency = result.currency ?? currency;
    if (typeof captured !== 'number' || !Number.isFinite(captured)) {
      return null;
    }
    if (pmsCurrency.toUpperCase() !== currency.toUpperCase()) {
      this.logger.error(
        `Devise de confirmation divergente : PMS ${pmsCurrency}, réservation ${currency}.`,
      );
      return null;
    }
    return toMinorUnits(captured, currency);
  }

  /**
   * Retire la réservation de l'index du balayeur — **`forget`, jamais `release`** (D-7) : purger la
   * clé d'idempotence rouvrirait la porte à une seconde réservation pour le même séjour.
   *
   * Best-effort : la confirmation est faite, et le balayeur ignore déjà une `Confirmed`. Une panne
   * Redis ici ne doit pas transformer une réussite en erreur.
   */
  private async forgetHold(reservationId: string): Promise<void> {
    try {
      await this.holds.forget(reservationId);
    } catch {
      this.logger.warn(
        `Hold de la réservation ${reservationId} non retiré de l'index (le balayeur ignorera la Confirmed).`,
      );
    }
  }

  /** Attend la fin d'une confirmation en vol (verrou rendu ou expiré), au plus `confirmWaitTimeoutMs`. */
  private async waitForConfirmationInFlight(
    reservationId: string,
  ): Promise<void> {
    const deadline = Date.now() + this.options.confirmWaitTimeoutMs;
    while (Date.now() < deadline) {
      await delay(this.options.confirmPollIntervalMs);
      if (!(await this.confirmLock.isHeld(reservationId))) {
        return;
      }
    }
  }

  /** Clé d'idempotence stable par réservation, hachée (aucun identifiant en clair sur le fil). */
  private confirmIdempotencyKey(reservationId: string): string {
    return createHash('sha1')
      .update(`reservation-confirm|${reservationId}`)
      .digest('hex');
  }

  /**
   * Émet (ou réémet) le PaymentIntent de la réservation et le rend exploitable par le navigateur.
   *
   * L'ordre des étapes est un **invariant de sécurité**, pas une commodité de lecture — voir les
   * commentaires numérotés ci-dessous.
   */
  async createIntent(
    session: RequestSession,
    reservationId: string,
  ): Promise<PaymentIntentDto> {
    // 1. Relire la réservation. Elle donne le total qui fait foi ET le statut : proposer de payer
    //    une réservation annulée en back-office ou déjà confirmée serait un chemin de double débit.
    const reservation = await this.booking.getReservation(
      session,
      reservationId,
    );

    if (reservation.status !== 'Pending') {
      this.logger.warn(
        `Intent refusé pour la réservation ${reservationId} : statut ${reservation.status}.`,
      );
      throw toPaymentException('reservation-not-pending');
    }

    // 2. ⚠️ Poser `paymentStarted` AVANT que le `clientSecret` ne quitte le BFF.
    //
    //    À partir de l'instant où le navigateur détient ce jeton, une autorisation réelle peut
    //    aboutir à tout moment — y compris pendant une passe du balayeur. Marquer après coup
    //    laisserait une fenêtre où le balayeur annulerait une réservation en train d'être payée :
    //    exactement l'incident que FR-14 interdit.
    //
    //    Une panne Redis remonte en 503 depuis `CheckoutHoldService` et interrompt donc la méthode :
    //    c'est voulu. Émettre un intent que le balayeur peut encore annuler serait pire qu'un refus.
    await this.holds.markPaymentStarted(reservationId);

    // 3. Demander l'intent au PMS, sous l'identité du voyageur.
    //
    //    ⚠️ Si le PMS refuse pour un motif **antérieur à tout appel Stripe**, le gel doit être
    //    relâché : sans cela, une réservation structurellement impayable (devise non encaissable,
    //    montant non facturable, réservation plus en attente) immobilisait la chambre POUR TOUJOURS,
    //    le balayeur ne touchant plus jamais un hold marqué. Trouvé en revue de code 3.1.
    let intent: PmsPaymentIntent;
    try {
      intent = await this.requestPmsIntent(session, reservationId);
    } catch (err) {
      await this.releaseIfNoPaymentCanExist(reservationId, err);
      throw err;
    }

    const amount = intent.amountInCents ?? null;
    const currency = intent.currency ?? null;
    const clientSecret = intent.clientSecret ?? null;
    const publishableKey = intent.publishableKey ?? null;
    const paymentIntentId = intent.paymentIntentId ?? null;

    if (
      typeof amount !== 'number' ||
      !currency ||
      !clientSecret ||
      !publishableKey ||
      !paymentIntentId
    ) {
      // Un intent amputé ne pourrait jamais être confirmé par le navigateur : mieux vaut un 503
      // franc qu'un Payment Element qui échoue avec un message Stripe opaque.
      this.logger.error(
        `Contrat PMS rompu sur l'intent de la réservation ${reservationId} : ` +
          `champs manquants (montant, devise, secret ou clé publique).`,
      );
      // ⚠️ 503 et non 500 (revue de code 3.1) : `throw new Error` retombait sur
      // INTERNAL_SERVER_ERROR dans le filtre global, que le front classe en « unknown » — donc
      // assorti d'un bouton « Réessayer » qui regèle un hold à chaque passage, sur une rupture
      // parfaitement déterministe.
      throw new ServiceUnavailableException(BROKEN_CONTRACT_MESSAGE);
    }

    // 4. Le montant autorisé DOIT être celui de la réservation, au centime (AC-5). Le PMS et le BFF
    //    convertissent tous deux en unités mineures, mais depuis des chemins distincts : un écart
    //    signale une divergence réelle (panier modifié entre deux appels, arrondi discordant), et
    //    autoriser malgré tout débiterait un montant que le voyageur n'a jamais vu.
    // ⚠️ La DEVISE fait partie du contrôle (revue de code 3.1). Elle n'apparaissait que dans le
    // message de log : deux devises de même exposant (EUR/CHF/USD/GBP) donnent des unités mineures
    // numériquement identiques, si bien qu'un basculement de `Hotel.Currency` entre la relecture de
    // la réservation et l'appel au PMS faisait autoriser 168 CHF pour un séjour affiché à 168 €.
    const sameAmount = amount === reservation.total;
    const sameCurrency =
      currency.toUpperCase() === reservation.currency.toUpperCase();

    if (!sameAmount || !sameCurrency) {
      this.logger.error(
        `Montant divergent pour la réservation ${reservationId} : ` +
          `PMS ${amount} ${currency}, réservation ${reservation.total} ${reservation.currency}.`,
      );
      throw toPaymentException('amount-mismatch');
    }

    // 5. Seul ce chemin rend un `clientSecret` : l'émission est prouvée sur le hold juste avant.
    return this.releaseIntent(reservationId, {
      clientSecret,
      publishableKey,
      paymentIntentId,
      amount,
      currency: currency.toUpperCase(),

      // Rapporté par le PMS, jamais supposé ici : le jour où la capture manuelle disparaîtrait, le
      // front cesserait d'afficher « aucun débit ferme » au lieu de mentir (même règle que
      // `taxState` en 2.2 et `communicationLocaleState` en 2.5).
      captureMethod: intent.captureMethod === 'manual' ? 'manual' : 'automatic',
    });
  }

  /**
   * Projection rendue au navigateur, après avoir prouvé l'émission sur le hold (revue ronde 2).
   *
   * ⚠️ `markIntentIssued` vient APRÈS tous les contrôles (contrat, montant, devise) : un intent que
   * le BFF refuse de rendre ne peut pas être autorisé, et ne doit pas ouvrir la confirmation. Une
   * panne Redis ici remonte en 503 sans `clientSecret` ; l'intent du PMS reste réutilisable.
   */
  private async releaseIntent(
    reservationId: string,
    dto: PaymentIntentDto,
  ): Promise<PaymentIntentDto> {
    await this.holds.markIntentIssued(reservationId);
    return dto;
  }

  /**
   * `POST /payments/room-reservation/intent` sous le JWT `Customer` en custody.
   *
   * ⚠️ **`maxRetries: 0`** — même raison qu'à la création de réservation (`booking.service.ts`) :
   * le PMS **ignore** l'en-tête `Idempotency-Key`, donc un rejeu automatique d'une réponse perdue
   * pourrait créer un second PaymentIntent chez Stripe. L'idempotence réelle vient de la garde de
   * réutilisation côté PMS ; l'en-tête reste posé pour le jour où le PMS l'honorera.
   */
  private async requestPmsIntent(
    session: RequestSession,
    reservationId: string,
  ): Promise<PmsPaymentIntent> {
    try {
      const response = await this.sessions.withCustomerAuth(
        session.sid,
        (token) =>
          this.pms.post<PmsPaymentIntent>(
            PMS_PAYMENT_ENDPOINTS.roomReservationIntent,
            { roomReservationId: reservationId },
            {
              ...this.pmsContext(),
              bearerToken: token,
              idempotencyKey: this.intentIdempotencyKey(session, reservationId),
              maxRetries: 0,
            },
          ),
      );

      if (!response.data) {
        throw new ServiceUnavailableException(BROKEN_CONTRACT_MESSAGE);
      }

      return response.data;
    } catch (err) {
      const reason = classifyPaymentFailure(err);
      if (reason === null) {
        // Panne, circuit ouvert ou 5xx : 503 par le filtre global. Ne JAMAIS présenter cela comme
        // un paiement refusé — le voyageur croirait sa carte rejetée.
        throw err;
      }
      throw toPaymentException(reason);
    }
  }

  /**
   * Relâche le gel du hold quand le PMS a refusé pour un motif **antérieur à tout appel Stripe**.
   *
   * Seuls ces motifs sont sûrs : le PMS les lève AVANT de créer le moindre PaymentIntent, donc
   * aucun paiement ne peut exister. `already-authorized` en est volontairement exclu — il signifie
   * précisément qu'un paiement EXISTE, et relâcher le hold ferait annuler une réservation payée.
   * Un échec non classé (panne, 5xx) l'est aussi : dans le doute, on garde le gel.
   */
  private async releaseIfNoPaymentCanExist(
    reservationId: string,
    err: unknown,
  ): Promise<void> {
    const provablyBeforeStripe: ReadonlySet<string> = new Set([
      'currency-unsupported',
      'reservation-not-pending',
      'reservation-not-found',
      'not-owner',
    ]);

    // ⚠️ Le motif se lit dans l'exception DÉJÀ traduite : `requestPmsIntent` a converti l'erreur
    // PMS en exception HTTP avant de la propager, si bien que `classifyPaymentFailure` ne la
    // reconnaît plus. On lit donc `errors.reason`, là où `toPaymentException` l'a posé.
    const reason = reasonOf(err);

    if (reason === null || !provablyBeforeStripe.has(reason)) {
      return;
    }

    try {
      await this.holds.clearPaymentStarted(reservationId);
      this.logger.warn(
        `Gel du hold relâché pour la réservation ${reservationId} : refus « ${reason} », ` +
          `aucun paiement ne peut exister.`,
      );
    } catch {
      // Best-effort : échouer ici masquerait le refus d'origine, qui est ce que le voyageur doit
      // voir. Le hold restera gelé, ce qui est le comportement d'avant ce correctif.
      this.logger.error(
        `Impossible de relâcher le gel du hold de la réservation ${reservationId}.`,
      );
    }
  }

  /**
   * Clé d'idempotence **stable par (session, réservation)** : deux clics produisent la même clé,
   * deux réservations distinctes n'en partagent jamais.
   *
   * Hachée : la clé traverse le réseau vers le PMS et n'a aucune raison d'y transporter un
   * identifiant de session en clair.
   */
  private intentIdempotencyKey(
    session: RequestSession,
    reservationId: string,
  ): string {
    return createHash('sha1')
      .update(`payment-intent|${session.sid}|${reservationId}`)
      .digest('hex');
  }

  private pmsContext(): PmsRequestContext | undefined {
    const correlationId = this.correlation.getCorrelationId();
    return correlationId ? { correlationId } : undefined;
  }
}

/**
 * Motif machine porté par une exception déjà traduite, ou `null`.
 *
 * `toPaymentException` place systématiquement le motif dans `errors.reason` : c'est la seule forme
 * qui survit à la traversée du filtre d'exceptions, et donc la seule sur laquelle du code peut
 * s'appuyer.
 */
function reasonOf(err: unknown): string | null {
  if (!(err instanceof HttpException)) {
    return null;
  }

  const response: unknown = err.getResponse();
  if (typeof response !== 'object' || response === null) {
    return null;
  }

  const errors: unknown = (response as { errors?: unknown }).errors;
  if (typeof errors !== 'object' || errors === null) {
    return null;
  }

  const reason: unknown = (errors as Record<string, unknown>)[
    PAYMENT_REASON_KEY
  ];
  return Array.isArray(reason) && typeof reason[0] === 'string'
    ? reason[0]
    : null;
}

/** Projection réduite de la preuve (B4) : liste blanche, aucune PII, aucun jeton. */
function toProof(
  reservation: BookingReservationDto,
  flags: { capturedAmount: number | null; alreadyConfirmed: boolean },
): ConfirmationProofDto {
  return {
    reservationId: reservation.reservationId,
    reservationCode: reservation.reservationCode,
    status: reservation.status,
    hotelName: reservation.hotelName,
    roomNumber: reservation.roomNumber,
    roomCategory: reservation.roomCategory,
    checkInDate: reservation.checkInDate,
    checkOutDate: reservation.checkOutDate,
    nights: reservation.nights,
    guests: reservation.guests,
    currency: reservation.currency,
    total: reservation.total,
    roomTotal: reservation.roomTotal,
    servicesTotal: reservation.servicesTotal,
    services: reservation.services,
    capturedAmount: flags.capturedAmount,
    communicationLocale: reservation.communicationLocale,
    // Porté par `BookingService.toReservationDto`, SEUL point de bascule D10 avec
    // `buildPmsCreateBody` : aucun second interrupteur ici.
    communicationLocaleState: reservation.communicationLocaleState,
    alreadyConfirmed: flags.alreadyConfirmed,
  };
}

/** Réservation telle que la confirmation l'a laissée, quand la relecture finale est impossible. */
function reconstituted(
  before: BookingReservationDto,
  result: PmsConfirmation,
): BookingReservationDto {
  const dropped = new Set(
    (result.droppedServices ?? [])
      .map((line) => line.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const services = before.services.map((line) => ({
    ...line,
    status: dropped.has(line.lineId)
      ? ('Cancelled' as const)
      : ('Confirmed' as const),
  }));
  const total =
    typeof result.grandTotal === 'number' && Number.isFinite(result.grandTotal)
      ? toMinorUnits(result.grandTotal, before.currency)
      : before.total;
  return {
    ...before,
    reservationCode: result.reservationCode || before.reservationCode,
    status: 'Confirmed',
    services,
    total,
    servicesTotal: Math.max(0, total - before.roomTotal),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
