/**
 * Devis de réservation (story 2.2, FR-7) — contenu du **récapitulatif avant paiement**.
 *
 * Lecture seule : aucune écriture PMS n'est émise à cette étape (la création `Pending` est le
 * périmètre de la story 2.4). Réexpose les données en **camelCase**, montants en **unités mineures
 * entières** de la devise de l'Hôtel (exposant réel — `common/money/minor-units.ts`), dates ISO,
 * `null` jamais `undefined` (AR-12).
 */

/**
 * État de la taxe. Le PMS porte un champ `TaxAmount` mais **ne l'alimente pas** (dépendance D7 /
 * AR-22) : on affiche un état explicite plutôt qu'une ligne de taxe fausse (FR-24, UX-DR-9.2).
 * À la livraison de D7, une valeur `'detailed'` viendra s'ajouter avec `taxAmount` renseigné.
 */
export type TaxState = 'included_undetailed';

/**
 * Politique d'annulation présentée **avant paiement** (FR-7 / FR-22, UX-DR-9.3).
 *
 * `source` distingue la donnée réelle de l'Hôtel du **repli** : le PMS n'expose aujourd'hui
 * **aucune** politique par hôtel (dépendance D2 / AR-17 — `Hotel` n'a ni règle, ni délai, ni taux
 * de remboursement). Tant que D2 n'est pas livré, `source = 'fallback'` et **tous** les champs de
 * détail restent `null` : ne JAMAIS fabriquer une échéance ni un pourcentage de remboursement.
 * À la livraison de D2, seul le contenu change — ni la structure, ni le composant front.
 */
export interface CancellationPolicyDto {
  source: 'hotel' | 'fallback';
  /** `true`/`false` quand l'Hôtel l'expose ; `null` en repli (inconnu, pas « non remboursable »). */
  refundable: boolean | null;
  /** Date/heure limite d'annulation sans frais (ISO 8601 UTC) ; `null` en repli. */
  freeUntil: string | null;
  /** Conditions détaillées telles que détenues par le PMS ; `null` en repli. */
  terms: string | null;
}

export interface BookingQuoteDto {
  hotelId: string;
  hotelName: string | null;
  hotelCity: string | null;
  /** Logo de l'Hôtel (vignette du récapitulatif) ; `null` si l'Hôtel n'en a pas. */
  hotelLogoUrl: string | null;

  roomId: string;
  roomNumber: string | null;
  roomCategory: string | null;
  /** `null` si le PMS ne renseigne pas la capacité (ne jamais afficher « 0 voyageur »). */
  roomCapacity: number | null;
  /** Photo principale de la chambre (déjà triée primaire d'abord par `catalog`) ; `null` si aucune. */
  roomImageUrl: string | null;

  /** Date-only `AAAA-MM-JJ` (validée par le DTO de query). */
  checkInDate: string;
  checkOutDate: string;
  /** Nombre de nuits, **toujours > 0** sur ce contrat (un devis sans dates n'existe pas). */
  nights: number;
  guests: number;

  /** Devise de l'**Hôtel** — jamais la devise de travail du visiteur, jamais convertie. */
  currency: string;
  /** Tarif par nuit (unités mineures). */
  pricePerNight: number;
  /** Sous-total chambre = `pricePerNight × nights` (unités mineures). */
  roomTotal: number;
  /** Toujours `null` tant que D7 n'alimente pas la taxe — jamais un montant inventé (AR-22). */
  taxAmount: null;
  taxState: TaxState;
  /**
   * Total à payer (unités mineures). Égal à `roomTotal` aujourd'hui ; accueillera les services
   * d'upsell quand D6 (panier combiné) sera livré. **Anti drip-pricing** (UX-DR-9.2) : ce montant
   * est celui qui sera débité — aucun frais n'apparaît plus tard dans le tunnel.
   */
  total: number;

  /**
   * Chambre sélectionnable pour ces dates, telle que composée par `catalog` — potentiellement
   * servie depuis son cache court (Décision 2 de la story) : ce n'est **pas** un cross-check
   * rejoué à chaque devis. La disponibilité faisant foi est tranchée à la création (story 2.4).
   */
  available: boolean;
  /**
   * Disponibilité datée **indéterminée** (panne PMS) : le front affiche « à confirmer à l'étape
   * suivante » et laisse le parcours ouvert — **jamais** « indisponible » (règle héritée de 1.10).
   */
  availabilityDegraded: boolean;

  cancellationPolicy: CancellationPolicyDto;

  /**
   * Horodatage de **composition** du devis (ISO 8601 UTC) — traçabilité et corrélation de logs.
   * ⚠️ Ce n'est pas l'âge de la donnée : `catalog` a pu servir une entrée de cache. Ne pas
   * l'afficher comme une garantie de fraîcheur (« prix vérifié à HH:MM »).
   */
  quotedAt: string;
}
