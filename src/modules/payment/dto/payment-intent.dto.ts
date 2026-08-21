/**
 * PaymentIntent exposé au navigateur (story 3.1, FR-12 / AR-14 / NFR-4).
 *
 * Projection **volontairement réduite** de `PaymentIntentResultDto` du PMS. Ce qui est écarté l'est
 * pour une raison :
 * - `paymentId` (identifiant PMS du paiement) — le navigateur n'en a aucun usage en 3.1 ; il servira
 *   à la **réconciliation de la story 3.4**, côté serveur. L'exposer élargirait la surface sans
 *   bénéfice ;
 * - toute clé Stripe secrète — le BFF n'en détient aucune (AR-14) et n'en verra jamais.
 *
 * Ce qui reste est le strict nécessaire au montage du Payment Element. `clientSecret` **n'est pas**
 * un secret serveur : c'est un jeton à portée d'un seul PaymentIntent, conçu pour vivre dans le
 * navigateur — c'est précisément ce qui garde les données de carte hors du BFF (PCI SAQ-A).
 */
export interface PaymentIntentDto {
  /** Jeton de confirmation du Payment Element, lié à ce seul PaymentIntent. */
  clientSecret: string;

  /** Clé publique Stripe du compte encaisseur, relayée depuis le PMS (jamais dupliquée en `.env`). */
  publishableKey: string;

  /** Identifiant Stripe (`pi_…`) — permet au front de relire l'état après un rechargement. */
  paymentIntentId: string;

  /**
   * Montant **exact** qui sera autorisé, en unités mineures entières de `currency` (AR-12).
   * Contrôlé côté BFF contre le total de la réservation avant d'être renvoyé (AC-5).
   */
  amount: number;

  /** Devise de l'**Hôtel**, en majuscules. Jamais convertie, toujours transportée avec le montant. */
  currency: string;

  /**
   * Mode de capture réellement demandé au PMS.
   *
   * Toujours `'manual'` tant que la dépendance D8 est en place : les fonds sont **autorisés**, pas
   * encaissés. Le front s'en sert pour tenir sa promesse « aucun débit ferme avant confirmation »
   * (UX-DR-9.9) sans la coder en dur — le jour où le PMS repasserait en capture automatique, le
   * texte affiché cesserait de mentir de lui-même.
   */
  captureMethod: 'manual' | 'automatic';
}
