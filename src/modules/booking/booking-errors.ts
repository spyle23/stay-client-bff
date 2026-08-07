import {
  BadRequestException,
  ConflictException,
  type HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PmsRequestError } from '../../integration/pms/pms-errors';

/**
 * Frontière d'erreur du domaine `booking` — **création de la Réservation `Pending`**
 * (story 2.4, FR-9 / AR-12 / NFR-10).
 *
 * Le PMS n'expose **aucun code d'erreur structuré** : `RoomReservationService.CreateAsync`
 * renvoie un `Result.Failure("…")` que le contrôleur sérialise en **400 texte**
 * (`ApiBadRequest<T>` → `ApiResponse<T>.Fail`). La classification par motif textuel est donc
 * inévitable — mais elle vit **en un seul endroit**, testée sur le corps réel.
 *
 * ⚠️ **Piège vérifié en conditions réelles (Phase 3 de la story 2.3)** : `ApiResponse.Fail`
 * produit `{"success":false,"data":null,"message":null,"errors":["…"]}`. Le motif vit dans
 * **`errors`**, pas dans `message` — lequel vaut alors « Le PMS a renvoyé le statut 400 »
 * (libellé par défaut de `PmsClientService.toRequestError`). Une reconnaissance limitée à
 * `err.message` ne classerait **jamais rien** : c'est exactement le défaut qui avait rendu la
 * détection de collision d'email inopérante en 2.3. On balaie donc les deux, sous les deux
 * formes d'`errors` (tableau ou dictionnaire par champ).
 *
 * Le texte du PMS **ne sort jamais** d'ici : chaque motif est traduit en message BFF générique,
 * accompagné d'un **code machine** que le front interprète pour proposer la bonne issue.
 */

/** `ReservationStatus.Pending` côté PMS — seul statut que le tunnel crée et réconcilie. */
export const PMS_STATUS_PENDING = 1;

/** Forme d'un GUID PMS (mêmes 8-4-4-4-12 que `ParseUUIDPipe` sur la route publique). */
const PMS_GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `true` si la valeur peut être interpolée sans risque dans un chemin PMS. */
export function isPmsGuid(value: unknown): value is string {
  return typeof value === 'string' && PMS_GUID.test(value);
}

/**
 * Refuse tout identifiant qui n'est pas un GUID **avant** de l'interpoler dans un chemin PMS.
 *
 * ⚠️ La route publique est déjà protégée par `ParseUUIDPipe`, mais ce n'est pas la seule source
 * d'identifiants : le rejeu idempotent et le balayeur en lisent dans **Redis**, et une valeur
 * corrompue ou forgée (`…/confirm`, `../`, `?x=`) y changerait l'endpoint réellement atteint —
 * jusqu'à viser `/confirm`, réservé au `X-Service-Key` (AR-8). La garde vit donc là où le chemin
 * est composé, pas seulement à l'entrée HTTP.
 */
export function assertPmsGuid(value: unknown, label: string): string {
  if (!isPmsGuid(value)) {
    throw new Error(
      `${label} n'est pas un GUID exploitable dans un chemin PMS.`,
    );
  }
  return value;
}

/** Chemins PMS des réservations de chambre. Jamais `/confirm` (réservé au `X-Service-Key`, AR-8). */
export const PMS_RESERVATION_ENDPOINTS = {
  create: (hotelId: string) =>
    `/roomreservations/hotels/${assertPmsGuid(hotelId, 'hotelId')}/reservations`,
  byId: (reservationId: string) =>
    `/roomreservations/${assertPmsGuid(reservationId, 'reservationId')}`,
  cancel: (reservationId: string) =>
    `/roomreservations/${assertPmsGuid(reservationId, 'reservationId')}/cancel`,
  /**
   * Réservations du **compte courant** (`[RequireRole(Customer)]`, réponse paginée). Seul moyen,
   * pour le balayeur, de retrouver une `Pending` dont l'identifiant s'est perdu avec la réponse de
   * création (réconciliation des intentions — correctif D1).
   *
   * Les paramètres passent par `URLSearchParams` : ce sont des nombres, mais les composer par
   * interpolation ouvrirait la même porte que les identifiants ci-dessus.
   */
  myReservations: (status: number, pageSize: number) =>
    `/roomreservations/my-reservations?${new URLSearchParams({
      Status: String(Math.trunc(status)),
      PageSize: String(Math.trunc(pageSize)),
    }).toString()}`,
} as const;

/**
 * Motif machine transmis au front dans `errors.reason`.
 *
 * Chaque valeur commande une **issue différente** côté navigateur (voir `booking-payment.tsx`) :
 * une indisponibilité renvoie vers les autres chambres, des dates invalides vers le récapitulatif.
 * Les confondre produirait un cul-de-sac ou un « Réessayez » condamné d'avance.
 */
export type BookingFailureReason =
  | 'room-unavailable'
  | 'over-capacity'
  | 'invalid-dates'
  | 'room-not-found'
  | 'session-invalid'
  | 'price-changed'
  | 'rejected';

/** Clé du dictionnaire d'erreurs portant le motif machine (`errors.reason`). */
export const BOOKING_REASON_KEY = 'reason';

/**
 * Motifs textuels du PMS (`RoomReservationService.CreateAsync`, l.115-178), dans l'ordre de
 * spécificité. Insensibles à la casse et volontairement **partiels** : le PMS interpole la
 * capacité réelle dans son message (« exceeds room capacity of 2 »).
 */
const PMS_FAILURE_PATTERNS: ReadonlyArray<
  readonly [RegExp, BookingFailureReason]
> = [
  [/exceeds\s+room\s+capacity/i, 'over-capacity'],
  [/room\s+not\s+found/i, 'room-not-found'],
  [/does\s+not\s+belong\s+to\s+this\s+hotel/i, 'room-not-found'],
  [/customer\s+not\s+found/i, 'session-invalid'],
  [/check-?out\s+date\s+must\s+be\s+after/i, 'invalid-dates'],
  [/check-?in\s+date\s+cannot\s+be\s+in\s+the\s+past/i, 'invalid-dates'],
  [/not\s+available\s+for\s+the\s+selected\s+dates/i, 'room-unavailable'],
  [/not\s+available\s+for\s+booking/i, 'room-unavailable'],
];

/** Message BFF par motif — générique, en français, **jamais** le texte du PMS. */
const REASON_MESSAGES: Record<BookingFailureReason, string> = {
  'room-unavailable': "Cette chambre n'est plus disponible pour ces dates.",
  'over-capacity': "Cette chambre n'accueille pas ce nombre de voyageurs.",
  'invalid-dates': 'Les dates de votre séjour ne sont pas valides.',
  'room-not-found': 'Chambre introuvable.',
  'session-invalid': 'Session expirée. Identifiez-vous à nouveau.',
  'price-changed': 'Le tarif de cette chambre a changé.',
  rejected:
    "Votre demande n'a pas été acceptée. Vérifiez les informations de votre séjour.",
};

/**
 * Statuts 4xx qui décrivent une **indisponibilité temporaire**, pas un refus déterministe :
 * 408 (Request Timeout), 425 (Too Early) et 429 (Too Many Requests). Le PMS ne les produit pas
 * aujourd'hui, mais un reverse-proxy, un WAF ou un limiteur d'infrastructure en intercale
 * volontiers — et ils arrivent alors avec un corps que rien ne permet de classer.
 *
 * Les traiter comme un refus métier donnerait « Vérifiez les informations de votre séjour » à un
 * voyageur dont le séjour est parfaitement valide, tout en lui cachant que **réessayer** est
 * exactement ce qu'il faut faire. Ils suivent donc la même règle que les 5xx : `null` ⇒ 503.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * Classe un échec d'écriture PMS en motif métier, ou `null` s'il n'en est pas un.
 *
 * `null` signifie **« ne classe pas, laisse remonter »** : une `PmsUnavailableError` ou un 5xx
 * est une panne (503, dégradation gracieuse NFR-10), pas un refus métier. Les traduire en 4xx
 * ferait croire au voyageur que sa chambre est prise alors que le PMS est simplement injoignable.
 *
 * ⚠️ Ce `null` a un second effet, côté création : un échec **non classé** laisse l'intention de
 * création en place pour le balayeur, là où un refus classé la retire (le PMS n'a rien écrit).
 * Se tromper de côté sur un 408/429 y créerait exactement le doublon que D1 doit empêcher.
 */
export function classifyReservationFailure(
  err: unknown,
): BookingFailureReason | null {
  if (!(err instanceof PmsRequestError)) {
    return null;
  }
  // 5xx : panne, jamais un refus métier (le client PMS les a déjà retryés).
  if (err.status >= 500) {
    return null;
  }
  // 4xx « réessayez » : panne déguisée en 4xx, même traitement que les 5xx.
  if (RETRYABLE_STATUSES.has(err.status)) {
    return null;
  }
  // Le jeton proxifié a été refusé : la session ne vaut plus rien, quel que soit le texte.
  if (err.status === 401 || err.status === 403) {
    return 'session-invalid';
  }
  if (err.status === 404) {
    return 'room-not-found';
  }

  const haystack = [err.message, ...flattenPmsErrors(err.errors)];
  for (const [pattern, reason] of PMS_FAILURE_PATTERNS) {
    if (haystack.some((text) => pattern.test(text))) {
      return reason;
    }
  }
  // Motif inconnu : refus **déterministe** non qualifié. Ne jamais deviner — une chambre
  // annoncée « indisponible » à tort enverrait le voyageur chercher une alternative inexistante.
  return 'rejected';
}

/** Aplatit `errors` du PMS, qu'il soit un tableau de messages ou un dictionnaire par champ. */
function flattenPmsErrors(
  errors: Record<string, string[]> | string[] | undefined,
): string[] {
  if (!errors) {
    return [];
  }
  return Array.isArray(errors) ? errors : Object.values(errors).flat();
}

/**
 * Traduit un motif en exception HTTP, motif machine inclus.
 *
 * Le corps produit (`{ message, errors }`) traverse `AllExceptionsFilter` **intact** : le front
 * lit `errors.reason` via `ApiClientError.errors` — un **dictionnaire**, seule forme conservée
 * par l'`api-client` (`api-client.ts:100`).
 *
 * `details` n'est utilisé que par `price-changed` : le nouveau total doit atteindre l'écran pour
 * être **re-confirmé explicitement** (AC-2). Il passe par `errors` faute d'autre canal — le
 * filtre global ne conserve que `message` et `errors`.
 */
export function toBookingException(
  reason: BookingFailureReason,
  details?: { total: number; currency: string },
): HttpException {
  const errors: Record<string, string[]> = { [BOOKING_REASON_KEY]: [reason] };
  if (details) {
    errors.total = [String(details.total)];
    errors.currency = [details.currency];
  }
  const body = { message: REASON_MESSAGES[reason], errors };

  switch (reason) {
    case 'room-unavailable':
    case 'over-capacity':
    case 'price-changed':
      return new ConflictException(body);
    case 'room-not-found':
      return new NotFoundException(body);
    case 'session-invalid':
      return new UnauthorizedException(body);
    case 'invalid-dates':
    case 'rejected':
      return new BadRequestException(body);
  }
}
