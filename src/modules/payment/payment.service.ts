import {
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { RequestSession } from '../../common/decorators/current-session.decorator';
import { CorrelationService } from '../../common/correlation/correlation.service';
import type { PmsRequestContext } from '../../integration/pms/pms-client.service';
import { PmsClientService } from '../../integration/pms/pms-client.service';
import type { components } from '../../types/generated/pms';
import { SessionService } from '../auth/session.service';
import { BookingService } from '../booking/booking.service';
import { CheckoutHoldService } from '../booking/checkout-hold.service';
import type { PaymentIntentDto } from './dto/payment-intent.dto';
import {
  classifyPaymentFailure,
  PAYMENT_REASON_KEY,
  PMS_PAYMENT_ENDPOINTS,
  toPaymentException,
} from './payment-errors';

type PmsPaymentIntent = components['schemas']['PaymentIntentResultDto'];

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
  ) {}

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

    return {
      clientSecret,
      publishableKey,
      paymentIntentId,
      amount,
      currency: currency.toUpperCase(),

      // Rapporté par le PMS, jamais supposé ici : le jour où la capture manuelle disparaîtrait, le
      // front cesserait d'afficher « aucun débit ferme » au lieu de mentir (même règle que
      // `taxState` en 2.2 et `communicationLocaleState` en 2.5).
      captureMethod: intent.captureMethod === 'manual' ? 'manual' : 'automatic',
    };
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
