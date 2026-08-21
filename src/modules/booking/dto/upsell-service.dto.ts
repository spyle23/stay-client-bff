import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from '../../search/dto/date-validators';

/**
 * Borne la taille du panier. Sans plafond, un tableau de 10 000 lignes ferait autant de lectures
 * catalogue côté PMS pour une seule requête — un amplificateur de charge offert à l'appelant.
 */
export const UPSELL_BASKET_MAX_LINES = 20;

/**
 * Service proposé à l'ajout au moment de la réservation (story 2.6, FR-11).
 *
 * Composé par le BFF depuis le catalogue de l'Hôtel. Les services **déjà inclus** dans le tarif de
 * la chambre en sont retirés : proposer d'acheter ce qui est compris est une rupture de confiance
 * directe (UX-DR-9.2).
 */
export interface UpsellServiceDto {
  serviceId: string;
  name: string;
  description: string | null;

  /**
   * Prix unitaire en **unités mineures** de la devise de l'Hôtel — même convention que
   * `pricePerNight` du devis, jamais convertie.
   */
  unitPrice: number;

  /** Devise de l'Hôtel (code ISO à 3 lettres). */
  currency: string;

  /**
   * Unité de facturation telle que saisie par l'hôtelier (« par nuit », « par personne »…).
   * Texte **libre** côté PMS : affiché tel quel, jamais interprété comme une règle de calcul.
   */
  unit: string | null;
}

/** Catalogue d'upsell d'un séjour. */
export interface UpsellCatalogDto {
  services: UpsellServiceDto[];

  /**
   * Vrai quand le catalogue n'a pas pu être composé (panne PMS). Le tunnel **reste ouvert** : on
   * ne présente pas « aucun service » comme un fait quand on n'en sait rien (règle héritée de
   * 1.10 — jamais un faux négatif affirmé).
   */
  degraded: boolean;
}

/**
 * Une ligne de panier envoyée par le front (création ou modification).
 *
 * ⚠️ Ne porte **aucun prix** : le montant est lu du catalogue serveur, côté BFF puis côté PMS.
 * Accepter un prix client permettrait de réserver un service à 0.
 */
export class ReservationServiceLineRequestDto {
  @IsUUID()
  serviceId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;

  /** Date de consommation du service — doit tomber dans le séjour (tranché par le PMS). */
  @IsDateOnly()
  serviceDate!: string;
}

/**
 * Corps de remplacement du panier d'une Réservation `Pending` (story 2.6, AC-5).
 *
 * Sémantique **replace** : un tableau vide retire tous les services.
 */
export class ReplaceReservationServicesRequestDto {
  @IsArray()
  @ArrayMaxSize(UPSELL_BASKET_MAX_LINES, {
    message: `Le panier ne peut pas dépasser ${UPSELL_BASKET_MAX_LINES} lignes.`,
  })
  @ValidateNested({ each: true })
  @Type(() => ReservationServiceLineRequestDto)
  services!: ReservationServiceLineRequestDto[];
}
