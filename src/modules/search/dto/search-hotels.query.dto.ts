import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  IsAfterDateProperty,
  IsDateOnly,
  IsNotPastDate,
} from './date-validators';

export const WORKING_CURRENCIES = ['EUR', 'USD'] as const;
export type WorkingCurrency = (typeof WORKING_CURRENCIES)[number];

/**
 * Query de recherche multi-hôtels (FR-1). Contrat **stable** aligné sur le futur endpoint
 * agrégé D1 : `destination + checkInDate + checkOutDate + guests + currency + page + pageSize`.
 *
 * La validation métier (départ > arrivée, arrivée non passée UTC, voyageurs ≥ 1) est portée
 * par les décorateurs → **rejet 400 sans aucun appel PMS** (AC-2).
 */
export class SearchHotelsQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  destination!: string;

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
