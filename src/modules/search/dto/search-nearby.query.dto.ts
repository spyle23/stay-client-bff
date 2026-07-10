import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  Max,
  Min,
} from 'class-validator';
import {
  IsAfterDateProperty,
  IsDateOnly,
  IsNotPastDate,
} from './date-validators';
import {
  WORKING_CURRENCIES,
  type WorkingCurrency,
} from './search-hotels.query.dto';

/**
 * Query de recherche « à proximité » (FR-2). Route dédiée `GET /api/v1/search/hotels/nearby` :
 * `destination` est remplacée par des **coordonnées** (latitude/longitude, `radiusKm` optionnel) ;
 * les critères datés (arrivée/départ/voyageurs/devise) sont **hérités à l'identique** de la
 * recherche par destination (availability-first — la proximité passe par le même fan-out daté).
 *
 * Coordonnées/dates invalides → **rejet 400 sans aucun appel PMS** (AC-6). Le `radiusKm` est
 * borné côté service au rayon maximal configuré (`nearbyMaxRadiusKm`).
 */
export class SearchNearbyQueryDto {
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  radiusKm?: number;

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

  @IsIn(WORKING_CURRENCIES)
  currency!: WorkingCurrency;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 12;
}
