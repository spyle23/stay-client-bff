import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  IsAfterDateProperty,
  IsDateOnly,
  IsNotPastDate,
} from '../../search/dto/date-validators';
import {
  COMMUNICATION_LOCALES,
  normalizeSpecialRequests,
  SPECIAL_REQUESTS_MAX_LENGTH,
  type CommunicationLocale,
} from '../special-requests';
import {
  ReservationServiceLineRequestDto,
  UPSELL_BASKET_MAX_LINES,
} from './upsell-service.dto';

/**
 * Corps de création d'une Réservation `Pending` (story 2.4, FR-9 ; story 2.5, FR-10).
 *
 * `hotelId`/`roomId` sont validés **GUID** : ils sont interpolés dans les chemins PMS — sans cette
 * garde, un appelant pourrait injecter une query ou une traversée et choisir l'endpoint atteint.
 *
 * ⚠️ Tout champ **non déclaré** ici est rejeté en 400 par le `ValidationPipe` global
 * (`forbidNonWhitelisted`) — cf. bug de la Phase 3 de la story 1.7.
 */
export class CreateReservationRequestDto {
  @IsUUID()
  hotelId!: string;

  @IsUUID()
  roomId!: string;

  @IsDateOnly()
  @IsNotPastDate()
  checkInDate!: string;

  @IsDateOnly()
  @IsAfterDateProperty('checkInDate')
  checkOutDate!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  guests!: number;

  /**
   * Total **affiché au voyageur**, en unités mineures entières de `expectedCurrency`.
   *
   * Obligatoire : c'est l'opposant du contrôle « total au centime » (AC-2). Sans lui, on ne
   * pourrait pas garantir que le montant débité est celui qui a été annoncé (UX-DR-9.2).
   *
   * Borné à 10^12 unités mineures : au-delà, l'arithmétique de totaux quitte le domaine des
   * entiers sûrs et perd de la précision en silence (dette relevée à la revue de la story 2.2).
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000_000)
  expectedTotal!: number;

  /**
   * Devise du total affiché (code à 3 lettres). Comparée à la devise réelle de l'Hôtel : une
   * divergence signifie que l'écran n'affichait pas la même monnaie que celle qui sera débitée.
   *
   * Volontairement **pas** validée contre une liste ISO figée : le PMS porte `Hotel.Currency` en
   * texte libre et l'ICU sait dériver l'exposant de devises que class-validator ignore.
   */
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/, {
    message: 'expectedCurrency doit être un code devise de 3 lettres.',
  })
  expectedCurrency!: string;

  /**
   * Demandes spéciales du voyageur — **texte libre facultatif** (story 2.5, FR-10).
   *
   * Normalisé **avant** validation : la longueur est donc mesurée sur ce qui partira réellement au
   * PMS, et non sur la saisie brute (des blancs de bord ne doivent pas faire refuser un texte qui
   * tient dans la borne).
   *
   * ⚠️ La borne est ici parce qu'elle n'existe **nulle part ailleurs** : `Stay-api` n'a aucun
   * validateur pour ce corps, et la colonne `varchar(2000)` transformerait un dépassement en
   * erreur Npgsql — un **500** sur la requête qui immobilise une vraie chambre.
   *
   * Une saisie vide devient `null` (jamais `''`) : `@IsOptional` la laisse alors passer sans
   * validation, et `buildPmsCreateBody` **omet** la clé du corps PMS.
   */
  @Transform(({ value }: { value: unknown }): unknown =>
    normalizeSpecialRequests(value),
  )
  @IsOptional()
  @IsString()
  @MaxLength(SPECIAL_REQUESTS_MAX_LENGTH, {
    message: `Les demandes spéciales ne peuvent pas dépasser ${SPECIAL_REQUESTS_MAX_LENGTH} caractères.`,
  })
  specialRequests?: string | null;

  /**
   * Langue souhaitée pour les communications (email/PDF) — facultative (story 2.5, FR-10).
   *
   * ⚠️ **N'est pas transmise au PMS aujourd'hui** : `RoomReservation` ne porte aucun champ de
   * langue et le moteur d'emails la résout depuis les réglages de l'hôtel
   * (`EmailOutboxProcessor.cs:229`). Elle est mémorisée côté BFF (enregistrement de hold) en
   * attendant la dépendance **D10**. Voir `booking.service.ts#buildPmsCreateBody`.
   *
   * Liste close et **sensible à la casse** : le PMS compare en `StringComparer.Ordinal`.
   */
  @IsOptional()
  @IsIn(COMMUNICATION_LOCALES, {
    message: `La langue de communication doit être l'une de : ${COMMUNICATION_LOCALES.join(', ')}.`,
  })
  communicationLocale?: CommunicationLocale;

  /**
   * Panier de services ajoutés au moment de la réservation — facultatif (story 2.6, FR-11).
   *
   * ⚠️ **Absent ou vide, la clé est OMISE du corps PMS** (jamais envoyée à `[]`) : une réservation
   * sans upsell doit produire exactement la même requête qu'avant D6.
   *
   * Les prix ne transitent pas : ils sont relus du catalogue par le BFF (contrôle du total annoncé)
   * puis par le PMS (montant persisté).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(UPSELL_BASKET_MAX_LINES, {
    message: `Le panier ne peut pas dépasser ${UPSELL_BASKET_MAX_LINES} lignes.`,
  })
  @ValidateNested({ each: true })
  @Type(() => ReservationServiceLineRequestDto)
  services?: ReservationServiceLineRequestDto[];
}
