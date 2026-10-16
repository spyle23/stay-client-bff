import { createHash } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  type HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import { assertPmsGuid, flattenPmsErrors } from '../booking/booking-errors';

/**
 * Frontière d'erreur de la **confirmation ferme** (story 3.2, B5) — patron **repris** de
 * `payment-errors.ts` (mêmes conventions : `errors.reason`, message BFF générique, texte PMS jamais
 * réexposé).
 *
 * ⚠️ **Cinquième story consécutive à classer des refus PMS par motif TEXTUEL** : le PMS n'expose
 * toujours aucun code d'erreur stable. Les textes reconnus ici sont ceux des constantes
 * `ReservationErrors` livrées par #152 (`ConfirmPaymentNotAuthorized`, `ConfirmAmountMismatch`,
 * `ConfirmCaptureFailed`, `ConfirmAuthorisationExpired`) ; toute reformulation côté `Stay-api` DOIT
 * être répercutée ici, sinon le refus retombe en « rejeté » générique.
 *
 * Particularité de cette route : la capture échouée et l'autorisation expirée sont des **502**
 * (l'échec vient de Stripe). Le client PMS les rejoue (la confirmation est idempotente par contrat)
 * puis lève une `PmsUnavailableError` qui conserve le **corps du dernier 5xx** : c'est là que le
 * motif se lit.
 */

/**
 * Routes PMS de service, les SEULES autorisées à porter `X-Service-Key` (AR-8, liste blanche de
 * `service-key-routes.ts`) : la confirmation, et les deux lectures de service de #153 qu'utilise la
 * réconciliation (#5) sans session voyageur.
 */
export const PMS_CONFIRMATION_ENDPOINTS = {
  confirm: (reservationId: string) =>
    `/reservations/${assertPmsGuid(reservationId, 'reservationId')}/confirm`,
  state: (reservationId: string) =>
    `/reservations/${assertPmsGuid(reservationId, 'reservationId')}`,
  payment: (reservationId: string) =>
    `/reservations/${assertPmsGuid(reservationId, 'reservationId')}/payment`,
} as const;

/**
 * Clé d'idempotence de la confirmation, **stable par réservation** et hachée (aucun identifiant en
 * clair sur le fil). Partagée par le navigateur (#3) et la réconciliation (#5) : les deux chemins
 * présentent au PMS la MÊME clé pour la même confirmation.
 */
export function confirmIdempotencyKey(reservationId: string): string {
  return createHash('sha1')
    .update(`reservation-confirm|${reservationId}`)
    .digest('hex');
}

/**
 * Motif machine transmis au front dans `errors.reason`. Chaque valeur commande une **issue
 * différente** à l'écran ; « Réessayer » n'est proposé que pour `capture-failed`,
 * `payment-verification-pending` (#183) et les pannes.
 */
export type ConfirmFailureReason =
  | 'payment-not-authorized'
  | 'amount-mismatch'
  | 'capture-failed'
  | 'authorisation-expired'
  | 'reservation-not-found'
  | 'reservation-cancelled'
  | 'room-unavailable'
  | 'not-owner'
  | 'session-invalid'
  | 'rejected'
  | 'payment-verification-pending';

/** Clé du dictionnaire d'erreurs portant le motif machine (identique à `booking` et `payment`). */
export const CONFIRM_REASON_KEY = 'reason';

/**
 * Clé du dictionnaire d'erreurs portant le **statut de débit** (#4, AC-8), lu au PMS :
 * - `none` : aucun débit conservé (autorisation annulée, jamais capturée, ou aucun paiement) ;
 * - `refunded` : remboursement intégral émis (AC-5) ;
 * - `captured` : argent encaissé sans réservation confirmée ni remboursement (réservation annulée,
 *   ou remboursement refusé par Stripe ; cas que la réconciliation signale en `integrity.alert`) :
 *   l'écran ne doit surtout pas dire « aucun débit » ;
 * - `held` : autorisation encore posée sur la carte, non encaissée (annulation refusée par Stripe).
 * Absente quand le BFF ne l'a pas établi (lecture en échec, intent en cours) : l'écran n'en déduit
 * JAMAIS « aucun débit » (revue #4, ronde 1), sauf pour un motif qui l'établit par construction.
 */
export const CONFIRM_DEBIT_KEY = 'debit';

/** Statut de débit d'un échec de confirmation (#4, AC-8). */
export type ConfirmDebitStatus = 'none' | 'refunded' | 'captured' | 'held';

/**
 * `ReservationErrors.PaymentReleaseFailed` (#4, 502) : la confirmation n'a pas abouti (chambre
 * prise, réservation à annuler) et Stripe n'a pu ni annuler l'autorisation ni rembourser. Le PMS
 * laisse la réservation telle quelle : le rejeu est sûr, ce n'est donc pas un refus définitif.
 */
const PAYMENT_RELEASE_FAILED =
  /payment\s+of\s+this\s+reservation\s+could\s+not\s+be\s+released/i;

/** Message BFF d'un paiement non libéré : générique, jamais le texte du PMS. */
const RELEASE_FAILED_MESSAGE =
  "La réservation n'a pas pu être finalisée et le paiement n'a pas encore été libéré : " +
  'réessayez dans un instant.';

/** Motifs textuels du PMS, dans l'ordre de spécificité. */
const PMS_FAILURE_PATTERNS: ReadonlyArray<
  readonly [RegExp, ConfirmFailureReason]
> = [
  [
    /reservation\s+payment\s+is\s+not\s+authori[sz]ed/i,
    'payment-not-authorized',
  ],
  [/does\s+not\s+match\s+the\s+amount\s+due/i, 'amount-mismatch'],
  [/payment\s+capture\s+failed/i, 'capture-failed'],
  [/authori[sz]ation\s+has\s+expired/i, 'authorisation-expired'],
  [
    /cannot\s+confirm\s+a\s+reservation\s+in\s+status\s+cancelled/i,
    'reservation-cancelled',
  ],
  // #4 AC-7 — `ReservationErrors.ConfirmRoomUnavailable` (409) : rien capturé, paiement libéré.
  [
    /room\s+is\s+no\s+longer\s+available\s+for\s+this\s+reservation/i,
    'room-unavailable',
  ],
  [/not\s+authori[sz]ed\s+to\b/i, 'not-owner'],
  [/reservation\s+not\s+found/i, 'reservation-not-found'],
];

/** Message BFF par motif — générique, en français, **jamais** le texte du PMS. */
const REASON_MESSAGES: Record<ConfirmFailureReason, string> = {
  'payment-not-authorized':
    "Le paiement de cette réservation n'est pas autorisé. Aucun débit n'a été conservé.",
  'amount-mismatch':
    "Le montant autorisé ne correspond pas au total dû. Aucun débit n'a été conservé.",
  'capture-failed':
    "L'encaissement n'a pas pu aboutir. Aucun débit n'a été conservé : réessayez dans un instant.",
  'authorisation-expired':
    "L'autorisation de paiement a expiré. Aucun débit n'a été conservé.",
  'reservation-not-found': 'Réservation introuvable.',
  'reservation-cancelled': 'Cette réservation a été annulée.',
  'room-unavailable':
    "Cette chambre n'est plus disponible pour vos dates : la réservation n'a pas pu être confirmée.",
  'not-owner': 'Réservation introuvable.',
  'session-invalid': 'Session expirée. Identifiez-vous à nouveau.',
  rejected:
    "La confirmation n'a pas été acceptée. Aucun débit n'a été conservé.",
  'payment-verification-pending':
    'Le paiement de cette réservation est en cours de vérification. Réessayez dans un instant.',
};

/** 4xx d'indisponibilité temporaire (proxy, limiteur) : même traitement qu'une panne. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * Classe un échec de confirmation en motif métier, ou `null` s'il n'en est pas un.
 *
 * `null` signifie **« laisse remonter »** : une panne devient un 503 (le front propose de
 * réessayer), jamais un refus — qui ferait croire au voyageur que sa réservation est perdue.
 */
export function classifyConfirmFailure(
  err: unknown,
): ConfirmFailureReason | null {
  if (err instanceof PmsUnavailableError) {
    // Seul un 502 RÉPONDU par le PMS porte un motif (#152) ; un 502 de proxy sans motif reconnu,
    // une panne réseau ou un circuit ouvert restent des pannes.
    if (err.status !== 502) {
      return null;
    }
    const reason = matchPattern(textsOf(err.responseBody));
    return reason === 'capture-failed' || reason === 'authorisation-expired'
      ? reason
      : null;
  }

  if (!(err instanceof PmsRequestError)) {
    return null;
  }
  if (err.status >= 500 || RETRYABLE_STATUSES.has(err.status)) {
    return null;
  }
  // ⚠️ La confirmation est authentifiée par `X-Service-Key`, pas par la session du voyageur : un
  // 401/403 signale une clé de service refusée (configuration du BFF). Renvoyer le voyageur à
  // l'identification ne corrigerait rien — c'est une indisponibilité.
  if (err.status === 401 || err.status === 403) {
    return null;
  }
  if (err.status === 404) {
    return 'reservation-not-found';
  }

  return (
    matchPattern([err.message, ...flattenPmsErrors(err.errors)]) ?? 'rejected'
  );
}

/**
 * Vrai pour le 502 « paiement non libéré » du PMS (#4). `classifyConfirmFailure` le laisse en panne
 * (`null`) ; ce prédicat permet au service d'y joindre le statut de débit réel avant le 503.
 */
export function isPaymentReleaseFailure(err: unknown): boolean {
  return (
    err instanceof PmsUnavailableError &&
    err.status === 502 &&
    textsOf(err.responseBody).some((text) => PAYMENT_RELEASE_FAILED.test(text))
  );
}

/**
 * Paiement non libéré (#4, AC-8) : **503 rejouable** sans motif métier (l'écran propose
 * « Réessayer »), avec le statut de débit lu au PMS quand il est établi (autorisation encore posée,
 * montant encaissé…) pour que l'écran ne dise jamais « aucun débit » à tort.
 */
export function toReleaseFailedException(
  debit?: ConfirmDebitStatus,
): HttpException {
  return new ServiceUnavailableException(
    debit === undefined
      ? { message: RELEASE_FAILED_MESSAGE }
      : {
          message: RELEASE_FAILED_MESSAGE,
          errors: { [CONFIRM_DEBIT_KEY]: [debit] },
        },
  );
}

/** Traduit un motif en exception HTTP, motif machine inclus. */
export function toConfirmException(
  reason: ConfirmFailureReason,
  debit?: ConfirmDebitStatus,
): HttpException {
  const errors: Record<string, string[]> = { [CONFIRM_REASON_KEY]: [reason] };
  if (debit !== undefined) {
    errors[CONFIRM_DEBIT_KEY] = [debit];
  }
  const body = { message: REASON_MESSAGES[reason], errors };

  switch (reason) {
    // États serveur qui interdisent la confirmation : déterministes, réessayer ne changerait rien.
    case 'payment-not-authorized':
    case 'amount-mismatch':
    case 'authorisation-expired':
    case 'reservation-cancelled':
    case 'room-unavailable':
      return new ConflictException(body);
    // L'échec vient de Stripe : rejouer la confirmation (idempotente) peut aboutir.
    case 'capture-failed':
      return new BadGatewayException(body);
    // Introuvable ou d'un autre compte : indiscernables, aucun oracle d'existence (AC-2).
    case 'reservation-not-found':
    case 'not-owner':
      return new NotFoundException(body);
    case 'session-invalid':
      return new UnauthorizedException(body);
    case 'rejected':
      return new BadRequestException(body);
    // #183 AC-2 : hold expiré et paiement illisible pour l'instant (PMS, Stripe, intent en cours).
    // Rien n'est établi, ni débit ni absence de débit : rejouable, jamais « non autorisé ».
    case 'payment-verification-pending':
      return new ServiceUnavailableException(body);
  }
}

function matchPattern(texts: string[]): ConfirmFailureReason | null {
  for (const [pattern, reason] of PMS_FAILURE_PATTERNS) {
    if (texts.some((text) => pattern.test(text))) {
      return reason;
    }
  }
  return null;
}

/** Textes d'une enveloppe `ApiResponse.Fail` relue dans un corps de 5xx (`message` et `errors`). */
function textsOf(body: unknown): string[] {
  if (typeof body === 'string') {
    return [body];
  }
  if (body === null || typeof body !== 'object') {
    return [];
  }
  const record = body as Record<string, unknown>;
  const texts: string[] = [];
  if (typeof record.message === 'string') {
    texts.push(record.message);
  }
  const errors = record.errors;
  if (Array.isArray(errors)) {
    texts.push(...errors.filter((e): e is string => typeof e === 'string'));
  } else if (errors !== null && typeof errors === 'object') {
    for (const value of Object.values(errors as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        texts.push(...value.filter((e): e is string => typeof e === 'string'));
      }
    }
  }
  return texts;
}
