import type { CommunicationLocale } from '../special-requests';

/**
 * Réservation exposée au front (story 2.4, FR-9 / AR-12 ; story 2.5, FR-10).
 *
 * Projection **volontairement réduite** de `RoomReservationDto` du PMS :
 * - `customerName` / `customerEmail` sont **écartés** — le navigateur connaît déjà son identité
 *   (`GET /auth/session`) et le BFF n'a aucune raison de rediffuser de la PII (NFR-5) ;
 * - `paymentMethod`, `notes`, `taxAmount` sont écartés (respectivement interne, back-office, et
 *   jamais alimenté par le PMS — dépendance D7) ;
 * - les montants sont convertis en **unités mineures entières** et accompagnés de leur devise,
 *   que le DTO du PMS ne porte pas (elle vit sur `Hotel.Currency`).
 *
 * `specialRequests` fait exception à la réduction : c'est une donnée **du voyageur lui-même**, et
 * la lui rendre est ce qui rend le rejeu honnête (il voit ce qui est *réellement* attaché à sa
 * réservation, pas ce qu'il vient de taper — story 2.5, AC-6).
 */

/** Statuts PMS (`ReservationStatus`: Pending=1, Confirmed=2, CheckedIn=3, CheckedOut=4, Cancelled=5, NoShow=6). */
export type ReservationStatusName =
  | 'Pending'
  | 'Confirmed'
  | 'CheckedIn'
  | 'CheckedOut'
  | 'Cancelled'
  | 'NoShow'
  | 'Unknown';

export interface BookingReservationDto {
  reservationId: string;
  /** Code lisible généré par le PMS (`RES-AAAAMMJJ-XXXXX`) — jamais recomposé par le BFF. */
  reservationCode: string;
  status: ReservationStatusName;

  hotelId: string;
  hotelName: string | null;
  roomId: string;
  roomNumber: string | null;
  roomCategory: string | null;

  /** Date-only `AAAA-MM-JJ` (le PMS renvoie un datetime ; on le normalise pour l'affichage). */
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  guests: number;

  /** Devise de l'**Hôtel** (jamais convertie, toujours transportée avec les montants — AR-12). */
  currency: string;
  /** Unités mineures entières de `currency`. */
  pricePerNight: number;
  total: number;

  /**
   * Sous-total **chambre seule** en unités mineures (story 2.6 / D6). C'est le `totalPrice` du PMS,
   * dont la sémantique n'a pas changé : il alimente encore l'e-mail, le PDF et les KPI hôtel.
   */
  roomTotal: number;

  /** Sous-total des services non annulés, en unités mineures. `0` sans upsell. */
  servicesTotal: number;

  /**
   * Services réellement attachés à la Réservation, relus du PMS — jamais l'écho du panier envoyé.
   * Sur un rejeu, ce sont ceux de la première soumission qui font foi.
   */
  services: ReservationServiceDto[];

  /**
   * Échéance du Hold de checkout (ISO 8601 UTC), ou `null` si le hold a expiré / n'existe plus.
   * Information **factuelle** destinée à l'écran — jamais un levier d'urgence (UX-DR-9.5).
   */
  holdExpiresAt: string | null;

  /**
   * Demandes spéciales **réellement attachées** à la réservation, relues du PMS (story 2.5, AC-1).
   *
   * ⚠️ Jamais l'écho de ce que l'appel vient d'envoyer : sur un rejeu idempotent, la réservation
   * porte le texte de la **première** soumission, et c'est celui-là qui compte.
   */
  specialRequests: string | null;

  /**
   * Langue de communication choisie par le voyageur, mémorisée côté BFF le temps du tunnel.
   *
   * `null` quand elle n'est pas connue : aucun choix exprimé, ou hold expiré/absent (le PMS ne la
   * porte pas — dépendance D10). Ne **jamais** y substituer une valeur par défaut : le front doit
   * pouvoir distinguer « pas de choix » de « choix = fr ».
   */
  communicationLocale: CommunicationLocale | null;

  /**
   * Ce que le système fera **réellement** de la langue choisie.
   *
   * - `applied` — le PMS porte la langue et l'utilisera (nécessite **D10**) ;
   * - `hotel_default_fallback` — l'hôtel écrira dans sa langue par défaut (**état actuel**).
   *
   * Porté par le BFF, jamais déduit côté navigateur : le front n'a pas à connaître l'état des
   * dépendances PMS. Même patron que `taxState` (D7) et `cancellationPolicy.source` (D2).
   */
  communicationLocaleState: 'applied' | 'hotel_default_fallback';

  /** `true` si cet appel a réellement créé la réservation ; `false` sur rejeu idempotent. */
  created: boolean;
}

/**
 * Une ligne de service attachée à une Réservation (story 2.6, FR-11), telle que relue du PMS.
 */
export interface ReservationServiceDto {
  /** Identifiant de la LIGNE côté PMS. Non stable entre deux éditions du panier (replace). */
  lineId: string;
  serviceId: string;
  name: string;
  /** Prix unitaire capté au catalogue lors de la réservation, en unités mineures. */
  unitPrice: number;
  quantity: number;
  /** Total de la ligne, en unités mineures. */
  lineTotal: number;
  /** Date de consommation, `AAAA-MM-JJ`. */
  serviceDate: string;
  /** `pending` tant que la Réservation ne l'est pas ; `cancelled` si le service a été retiré. */
  status: ReservationStatusName;
}
