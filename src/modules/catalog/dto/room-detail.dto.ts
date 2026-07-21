/**
 * Fiche chambre (story 1.10, FR-6) — détail d'une **seule** chambre pour la page publique
 * `/hotels/{slug}/rooms/{roomId}`. Réexpose les données PMS en **camelCase**, montants en
 * **unités mineures entières** de la devise de l'Hôtel (exposant réel — cf.
 * `common/money/minor-units.ts`), `null` (jamais `undefined`).
 *
 * Composée depuis des endpoints **publics** du PMS (cf. `CatalogService.getRoomDetail`) : la fiche
 * doit être servie **sans authentification** (SSR indexable), et le hotelId de l'URL rend la
 * composition possible.
 */

/** Service **inclus** dans la chambre (niveau chambre, public — ≠ services d'hôtel gated D9). */
export interface RoomIncludedService {
  name: string;
  /** Quantité incluse, ou `null` si le PMS ne la renseigne pas. */
  quantity: number | null;
  notes: string | null;
}

/** Photo de la chambre (déjà triée : primaire d'abord, puis `displayOrder`). */
export interface RoomPhoto {
  url: string;
}

export interface RoomDetailDto {
  id: string;
  hotelId: string;
  /** Nom de l'Hôtel (fil d'Ariane, métadonnées, `alt` de galerie). */
  hotelName: string | null;
  /** Ville de l'Hôtel (métadonnées SEO). */
  hotelCity: string | null;
  number: string | null;
  /** Catégorie/type de chambre (texte libre PMS). */
  category: string | null;
  /** Capacité, ou `null` si le PMS ne la renseigne pas (ne jamais afficher « 0 voyageur »). */
  capacity: number | null;
  /** Équipements de chambre (texte libre CSV PMS, `null` si aucun). */
  amenities: string | null;
  floor: number | null;
  description: string | null;
  /** Services inclus (niveau chambre, publics). */
  includedServices: RoomIncludedService[];
  /** Photos de la chambre (peut être vide — repli placeholder côté front). */
  images: RoomPhoto[];
  /** Prix par nuit (unités mineures), dans la devise de l'Hôtel. */
  pricePerNight: number;
  /**
   * Total du séjour (unités mineures) ; `null` si aucune date en contexte.
   * **Dérivé de `pricePerNight × nights`** (jamais re-arrondi depuis le décimal).
   */
  totalPrice: number | null;
  /** Devise de l'Hôtel (jamais convertie). */
  currency: string;
  /** Nombre de nuits du séjour en contexte ; `null` si aucune date. */
  nights: number | null;
  /**
   * Chambre **sélectionnable** pour les dates en contexte (appartenance au set réellement
   * disponible du PMS). Sans dates : éligibilité statique (`status = Available` + prix > 0).
   */
  available: boolean;
  /**
   * La disponibilité datée n'a **pas pu être déterminée** (panne PMS sur `/available`) : `available`
   * retombe alors sur l'éligibilité statique et le front affiche un avis « disponibilité
   * indéterminée » — **jamais** « indisponible pour ces dates » (AC-6). Une réponse dégradée
   * n'est jamais mise en cache.
   */
  availabilityDegraded: boolean;
}
