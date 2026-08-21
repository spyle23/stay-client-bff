import {
  BadRequestException,
  ConflictException,
  type HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PmsRequestError } from '../../integration/pms/pms-errors';
import { assertPmsGuid, flattenPmsErrors } from '../booking/booking-errors';

/**
 * Frontière d'erreur du domaine `payment` — **demande de PaymentIntent** (story 3.1, FR-12).
 *
 * ⚠️ **Quatrième story consécutive à classer des échecs PMS par motif TEXTUEL** (après 2.3, 2.4 et
 * 2.6). Le PMS n'expose toujours aucun code d'erreur d'application stable : `PaymentService` renvoie
 * un `Result.Failure("…")` que le contrôleur sérialise en **400 texte**. Une reformulation, une
 * localisation ou un simple changement de casse côté `Stay-api` reclasserait silencieusement ces
 * refus en `rejected` générique. La demande de codes stables est consignée dans `deferred-work.md`.
 *
 * Le patron est celui de `booking-errors.ts`, délibérément **repris et non réinventé** : mêmes
 * conventions (`errors.reason`, message BFF générique, texte PMS jamais réexposé), mais un jeu de
 * motifs distinct — les issues côté navigateur ne sont pas les mêmes qu'à la création.
 */

/** Chemins PMS du domaine paiement. */
export const PMS_PAYMENT_ENDPOINTS = {
  /** `[RequireRole(Customer)]` — crée (ou réutilise) le PaymentIntent de la réservation. */
  roomReservationIntent: '/payments/room-reservation/intent',
  /** `[RequireRole(Customer, Manager)]` — relecture d'un paiement (réconciliation, story 3.4). */
  byId: (paymentId: string) =>
    `/payments/${assertPmsGuid(paymentId, 'paymentId')}`,
} as const;

/**
 * Motif machine transmis au front dans `errors.reason`.
 *
 * Chaque valeur commande une **issue différente** à l'écran : `already-authorized` affiche l'état
 * « paiement autorisé » (et surtout **pas** un bouton Payer), `amount-mismatch` renvoie recharger le
 * récapitulatif, `reservation-not-pending` propose de relire la réservation. Les confondre
 * produirait soit un cul-de-sac, soit — pour le premier — une invitation à payer une seconde fois.
 */
export type PaymentFailureReason =
  | 'already-authorized'
  | 'amount-mismatch'
  | 'currency-unsupported'
  | 'reservation-not-found'
  | 'reservation-not-pending'
  | 'not-owner'
  | 'session-invalid'
  | 'rejected';

/** Clé du dictionnaire d'erreurs portant le motif machine (identique à `booking`). */
export const PAYMENT_REASON_KEY = 'reason';

/**
 * Motifs textuels du PMS, dans l'ordre de spécificité. Les trois premiers sont des **constantes**
 * de `ReservationErrors` côté .NET (`PaymentAlreadySettled`, `PaymentCurrencyUnsupported`,
 * `PaymentAmountNotChargeable`) : elles ne dérivent pas au fil des reformulations, contrairement aux
 * messages libres de `PaymentService`.
 */
const PMS_FAILURE_PATTERNS: ReadonlyArray<
  readonly [RegExp, PaymentFailureReason]
> = [
  // ⚠️ Le libellé PMS a changé en revue 3.1 (« settled » était faux : rien n'est encaissé sous
  // capture manuelle). Les DEUX formes sont reconnues — l'ancienne peut encore venir d'une
  // instance PMS non redéployée, et retomber en « rejected » proposerait un « Réessayer » à un
  // voyageur dont la carte porte déjà une retenue.
  [
    /payment\s+is\s+already\s+engaged\s+for\s+this\s+reservation/i,
    'already-authorized',
  ],
  [/payment\s+has\s+already\s+been\s+settled/i, 'already-authorized'],
  [/no\s+longer\s+awaiting\s+payment/i, 'reservation-not-pending'],
  [/already\s+under\s+way\s+for\s+a\s+different\s+amount/i, 'amount-mismatch'],
  [/currency\s+is\s+not\s+supported/i, 'currency-unsupported'],
  [/cannot\s+be\s+charged\s+exactly/i, 'currency-unsupported'],
  [/not\s+authorized\s+to\s+pay/i, 'not-owner'],
  [/room\s+reservation\s+not\s+found/i, 'reservation-not-found'],
  [/hotel\s+not\s+found/i, 'reservation-not-found'],
];

/** Message BFF par motif — générique, en français, **jamais** le texte du PMS. */
const REASON_MESSAGES: Record<PaymentFailureReason, string> = {
  'already-authorized':
    'Le paiement de cette réservation est déjà engagé. Aucun nouveau débit ne sera effectué.',
  'amount-mismatch':
    'Le montant de votre réservation a changé. Rechargez le récapitulatif avant de payer.',
  'currency-unsupported':
    "Le paiement en ligne n'est pas disponible pour cet établissement. Contactez l'hôtel.",
  'reservation-not-found': 'Réservation introuvable.',
  'reservation-not-pending':
    "Cette réservation n'est plus en attente de paiement.",
  'not-owner': "Cette réservation n'est pas la vôtre.",
  'session-invalid': 'Session expirée. Identifiez-vous à nouveau.',
  rejected:
    "Le paiement n'a pas pu être initialisé. Réessayez dans un instant.",
};

/**
 * Statuts 4xx décrivant une indisponibilité temporaire, pas un refus déterministe. Même règle que
 * dans `booking-errors.ts` : `null` ⇒ 503, pour ne pas dire au voyageur que son paiement est refusé
 * alors qu'un limiteur d'infrastructure s'est simplement intercalé.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * Classe un échec PMS en motif métier, ou `null` s'il n'en est pas un.
 *
 * `null` signifie **« laisse remonter »** : une panne devient un 503 (dégradation gracieuse), jamais
 * un « paiement refusé » — qui ferait croire au voyageur que sa carte a été rejetée.
 */
export function classifyPaymentFailure(
  err: unknown,
): PaymentFailureReason | null {
  if (!(err instanceof PmsRequestError)) {
    return null;
  }
  if (err.status >= 500 || RETRYABLE_STATUSES.has(err.status)) {
    return null;
  }
  if (err.status === 401 || err.status === 403) {
    return 'session-invalid';
  }
  if (err.status === 404) {
    return 'reservation-not-found';
  }

  // ⚠️ `ApiResponse.Fail` place le motif dans **`errors`**, pas dans `message` — lequel vaut alors
  // le libellé par défaut du client PMS. Se limiter à `message` ne classerait jamais rien : c'est
  // exactement le défaut trouvé en Phase 3 de la story 2.3. `flattenPmsErrors` est réutilisé de
  // `booking-errors.ts` (tableau **ou** dictionnaire par champ), pas réécrit.
  const haystack = [err.message, ...flattenPmsErrors(err.errors)];
  for (const [pattern, reason] of PMS_FAILURE_PATTERNS) {
    if (haystack.some((text) => pattern.test(text))) {
      return reason;
    }
  }

  // Motif inconnu : refus déterministe non qualifié. Ne jamais deviner — annoncer « déjà payé » à
  // tort empêcherait un voyageur de payer sa réservation.
  return 'rejected';
}

/** Traduit un motif en exception HTTP — même barème de statuts que `booking`. */
export function toPaymentException(
  reason: PaymentFailureReason,
): HttpException {
  const body = {
    message: REASON_MESSAGES[reason],
    errors: { [PAYMENT_REASON_KEY]: [reason] },
  };

  switch (reason) {
    // Conflits d'état : la demande est cohérente, c'est l'état serveur qui a bougé. Le front les
    // rend comme des ÉTATS d'écran, pas comme des erreurs de saisie.
    case 'already-authorized':
    case 'amount-mismatch':
    case 'reservation-not-pending':
      return new ConflictException(body);
    case 'reservation-not-found':
      return new NotFoundException(body);
    case 'session-invalid':
    case 'not-owner':
      return new UnauthorizedException(body);
    case 'currency-unsupported':
      // Ni la faute du voyageur, ni une panne : l'établissement n'est pas encaissable en ligne.
      return new ServiceUnavailableException(body);
    case 'rejected':
      return new BadRequestException(body);
  }
}
