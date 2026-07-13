/**
 * Chambre exposée sur la page hôtel (story 1.9). Réexpose la `RoomDto` du PMS en **camelCase**,
 * montants en **unités mineures entières** de la devise de l'Hôtel (le PMS renvoie du décimal →
 * conversion côté BFF avec l'**exposant réel** de la devise — cf. `common/money/minor-units.ts` :
 * ×100 pour EUR/USD, ×1 pour MGA/JPY, ×1000 pour KWD), `null` (jamais `undefined`).
 *
 * `totalPrice`/`nights` sont `null` quand la page est ouverte **sans dates** (lien « nu ») : on
 * n'affiche alors que le prix par nuit (repli documenté, story 1.9 Décision 4).
 */
export interface HotelRoomDto {
  id: string;
  hotelId: string;
  number: string | null;
  /** Catégorie/type de chambre (texte libre PMS). */
  category: string | null;
  /** Capacité, ou `null` si le PMS ne la renseigne pas (ne jamais afficher « 0 voyageur »). */
  capacity: number | null;
  /** Équipements de chambre (texte libre CSV PMS, `null` si aucun). */
  amenities: string | null;
  floor: number | null;
  /** Prix par nuit (unités mineures), dans la devise de l'Hôtel. */
  pricePerNight: number;
  /**
   * Total du séjour (unités mineures) ; `null` si aucune date en contexte.
   * **Dérivé de `pricePerNight × nights`** (et non re-arrondi depuis le décimal) : le total affiché
   * est toujours cohérent avec le prix/nuit affiché.
   */
  totalPrice: number | null;
  /** Devise de l'Hôtel (jamais convertie). */
  currency: string;
  /** Nombre de nuits du séjour en contexte ; `null` si aucune date. */
  nights: number | null;
}
