import { Type } from 'class-transformer';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import {
  IsAfterDateProperty,
  IsDateOnly,
  IsNotPastDate,
} from '../../search/dto/date-validators';

/**
 * Query du devis de réservation (story 2.2, FR-7).
 *
 * **Différence assumée avec `HotelDetailQueryDto`** : ici les dates et les voyageurs sont
 * **obligatoires**. La page hôtel doit toujours se rendre (repli prix/nuit si les dates sont
 * douteuses) ; un **devis** sans dates n'a aucun sens — mieux vaut un 400 explicite qu'un
 * récapitulatif à total `null`. Le front valide de son côté et n'appelle pas le BFF sur une URL
 * invalide (il affiche un état de saisie invalide avec une porte de sortie).
 *
 * `hotelId`/`roomId` sont validés **GUID** : ils sont interpolés dans les chemins PMS — sans cette
 * garde, un appelant pourrait injecter une query ou une traversée et choisir l'endpoint PMS atteint
 * (même raisonnement que le `ParseUUIDPipe` de `catalog.controller.ts`).
 *
 * ⚠️ Tout param **non déclaré** ici est rejeté 400 par le `ValidationPipe` global
 * (`forbidNonWhitelisted`) — cf. bug Phase 3 de 1.7. Le front n'émet que ces cinq paramètres
 * (la devise de travail reste dans l'URL navigateur et n'est jamais envoyée au BFF).
 */
export class BookingQuoteQueryDto {
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
}
