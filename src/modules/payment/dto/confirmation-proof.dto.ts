import type { CommunicationLocale } from '../../booking/special-requests';
import type {
  ReservationServiceDto,
  ReservationStatusName,
} from '../../booking/dto/reservation.dto';

/**
 * Preuve de confirmation renvoyée au navigateur (story 3.2, B4 / AC-4).
 *
 * Projection **réduite**, mêmes règles qu'en 2.4 :
 * - ⚠️ **aucune donnée personnelle** (`customerName`, `customerEmail`, demandes spéciales) : le
 *   navigateur connaît son identité, et la preuve n'a pas à la rediffuser (NFR-5) ;
 * - ⚠️ **aucun `validationToken`** : c'est le jeton de check-in (Epic 8). Il ne quitte jamais le
 *   PMS ; seule son image QR traverse (`GET …/confirmation-qr`).
 *
 * Écart avec la spec : pas de `confirmedAt`, que #152 n'expose pas faute de colonne.
 */
export interface ConfirmationProofDto {
  reservationId: string;
  /** Code lisible généré par le PMS — jamais recomposé par le BFF. */
  reservationCode: string;
  status: ReservationStatusName;

  hotelName: string | null;
  roomNumber: string | null;
  roomCategory: string | null;

  /** Date-only `AAAA-MM-JJ`. */
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  guests: number;

  /** Devise de l'Hôtel, transportée avec chaque montant (AR-12). */
  currency: string;
  /** Total relu du serveur APRÈS confirmation (lignes de service écartées déduites), unités mineures. */
  total: number;
  roomTotal: number;
  servicesTotal: number;
  services: ReservationServiceDto[];

  /**
   * Montant **réellement encaissé** par Stripe, relu du PMS, en unités mineures ; `0` sans paiement
   * en ligne.
   *
   * `null` quand cet appel ne l'a pas relu : chemin idempotent rapide (réservation déjà `Confirmed`,
   * aucun appel au PMS par construction — AC-2), ou devise du PMS divergente de celle de l'hôtel.
   * Le front affiche alors `total`, que le PMS garantit égal au capturé : il refuse de confirmer
   * quand l'autorisé diverge du dû (#152).
   */
  capturedAmount: number | null;

  /** Langue choisie à l'étape 3, relue de Redis ; `null` si aucun choix n'a été exprimé. */
  communicationLocale: CommunicationLocale | null;
  /** `hotel_default_fallback` tant que D10 n'est pas livrée : l'e-mail part dans la langue de l'hôtel. */
  communicationLocaleState: 'applied' | 'hotel_default_fallback';

  /** `true` si la réservation était déjà confirmée avant cet appel (rejeu, autre onglet). */
  alreadyConfirmed: boolean;
}
