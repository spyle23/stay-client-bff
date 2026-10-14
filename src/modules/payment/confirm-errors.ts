import { createHash } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  type HttpException,
  NotFoundException,
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
 * différente** à l'écran ; « Réessayer » n'est proposé que pour `capture-failed` (et les pannes).
 */
export type ConfirmFailureReason =
  | 'payment-not-authorized'
  | 'amount-mismatch'
  | 'capture-failed'
  | 'authorisation-expired'
  | 'reservation-not-found'
  | 'reservation-cancelled'
  | 'not-owner'
  | 'session-invalid'
  | 'rejected';

/** Clé du dictionnaire d'erreurs portant le motif machine (identique à `booking` et `payment`). */
export const CONFIRM_REASON_KEY = 'reason';

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
  'not-owner': 'Réservation introuvable.',
  'session-invalid': 'Session expirée. Identifiez-vous à nouveau.',
  rejected:
    "La confirmation n'a pas été acceptée. Aucun débit n'a été conservé.",
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

/** Traduit un motif en exception HTTP, motif machine inclus. */
export function toConfirmException(
  reason: ConfirmFailureReason,
): HttpException {
  const body = {
    message: REASON_MESSAGES[reason],
    errors: { [CONFIRM_REASON_KEY]: [reason] },
  };

  switch (reason) {
    // États serveur qui interdisent la confirmation : déterministes, réessayer ne changerait rien.
    case 'payment-not-authorized':
    case 'amount-mismatch':
    case 'authorisation-expired':
    case 'reservation-cancelled':
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
