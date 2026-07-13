import type { HotelRoomDto } from './hotel-room.dto';

/**
 * Une image de la galerie hôtel. **Aucun texte alternatif n'est composé ici** : le BFF n'a pas de
 * locale (un `alt` en dur serait servi tel quel aux utilisateurs `en`). Il expose la **donnée**
 * (l'image vient-elle d'une chambre, et laquelle) et le front compose l'`alt` via i18n.
 */
export interface HotelGalleryImage {
  url: string;
  /** Numéro de la chambre d'origine, ou `null` si l'image est celle de l'hôtel (logo). */
  roomNumber: string | null;
}

/**
 * Détail d'un hôtel pour la page publique (story 1.9, FR-5) — **contrat de sortie**.
 *
 * Réexpose la `HotelDto` du PMS en **camelCase**, `null` (jamais `undefined`). Les identifiants
 * fiscaux (`rcs`/`nif`/`stat`) du PMS **ne sont PAS exposés** (données back-office, non publiques).
 *
 * Le PMS n'ayant **aucune galerie au niveau hôtel**, `gallery` est **composée côté BFF** (logo +
 * images primaires des chambres). Elle est **indépendante des dates** (revue 1.9) : l'identité
 * visuelle d'un hôtel ne varie pas avec la disponibilité. `rooms` = chambres disponibles pour les
 * dates en contexte (ou chambres `Available` si aucune date). `roomsUnavailable` distingue « aucune
 * chambre » (état vide) d'une **panne PMS** (dégradation gracieuse, NFR-10) tout en gardant l'hôtel
 * affichable.
 */
export interface HotelDetailDto {
  id: string;
  name: string | null;
  /** Note de catégorie (texte libre PMS, ex. « 4-star ») — pas d'étoiles numériques. */
  category: string | null;
  description: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  email: string | null;
  /**
   * Devise **résolue** de l'Hôtel (jamais convertie) — la **même** que celle portée par les
   * chambres. Un hôtel sans devise au PMS retombe sur le défaut Stay-api (EUR) : le DTO ne peut pas
   * annoncer `null` ici et une devise ailleurs (montant affiché avec une devise fabriquée).
   */
  currency: string;
  locale: string | null;
  logoUrl: string | null;
  roomCount: number;
  gallery: HotelGalleryImage[];
  rooms: HotelRoomDto[];
  /**
   * Nombre de nuits du **contexte de séjour effectivement retenu** par le BFF (dates présentes,
   * valides, non passées et bornées), sinon `null`. Porté au niveau **hôtel** — et non déduit de
   * `rooms[0]` — car une liste de chambres vide masquerait l'information (l'utilisateur lirait
   * « aucune chambre pour ces dates » alors qu'il n'a saisi aucune date).
   */
  stayNights: number | null;
  /** `true` si la disponibilité des chambres est momentanément injoignable (panne PMS). */
  roomsUnavailable: boolean;
}
