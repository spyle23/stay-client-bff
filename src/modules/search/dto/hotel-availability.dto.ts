/**
 * Résultat de recherche par hôtel — **contrat de sortie figé** (story 1.6, AC-5).
 *
 * Reflète le futur `HotelAvailabilityDto` de l'endpoint agrégé D1 : à la bascule
 * fan-out → endpoint agrégé, le contrat front reste inchangé.
 *
 * Invariants : montants en **unités mineures entières (cents)** (le PMS renvoie du décimal →
 * conversion côté BFF), devise toujours transportée, `null` (jamais `undefined`).
 */
export interface HotelAvailabilityDto {
  hotelId: string;
  name: string | null;
  city: string | null;
  country: string | null;
  /** Note de catégorie de l'hôtel (texte libre PMS, ex. « 4-star ») — pas d'étoiles numériques. */
  category: string | null;
  currency: string;
  /** Prix « à partir de » par nuit (min des chambres disponibles), en cents. */
  fromPricePerNight: number;
  /** Total « à partir de » du séjour (`prix min × nuits`), en cents. */
  fromTotalPrice: number;
  nights: number;
  availableRoomCount: number;
  /** Photo de la carte = `logoUrl` du PMS (pas de galerie hôtel — story 1.9). */
  thumbnailUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  /**
   * Distance (km) depuis la position du Voyageur — **peuplée uniquement en mode proximité**
   * (`/Hotels/nearby`, story 1.7 ; distance calculée côté PMS). `null` en recherche par
   * destination. Non monétaire → pas de conversion en cents.
   */
  distanceKm: number | null;
  /**
   * Équipements disponibles (union des `RoomDto.amenities` des chambres réellement disponibles
   * de l'hôtel, post-capacité) — story 1.8, repli **D9** (services d'hôtel non publics). Sert de
   * **source de facettes** au front (options du filtre « équipements ») et est peuplé
   * **indépendamment** du filtre `amenities` actif pour ne pas rétrécir les options. `[]` si aucun.
   */
  amenities: string[];
}
