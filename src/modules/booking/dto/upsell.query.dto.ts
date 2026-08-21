import { Type } from 'class-transformer';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import {
  IsAfterDateProperty,
  IsDateOnly,
} from '../../search/dto/date-validators';

/**
 * Query du catalogue d'upsell (story 2.6, AC-1).
 *
 * Le séjour est requis parce que le catalogue en dépend deux fois : pour connaître la devise de
 * l'Hôtel, et surtout pour savoir **ce qui est déjà compris** dans la chambre choisie (AC-2).
 *
 * `hotelId`/`roomId` validés GUID : ils sont interpolés dans les chemins PMS.
 */
export class UpsellQueryDto {
  @IsUUID()
  hotelId!: string;

  @IsUUID()
  roomId!: string;

  @IsDateOnly()
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
