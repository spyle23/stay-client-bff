import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { ApiResponse } from '../../integration/pms/api-response.types';
import { CatalogService } from './catalog.service';
import type { HotelDetailDto } from './dto/hotel-detail.dto';
import { HotelDetailQueryDto } from './dto/hotel-detail.query.dto';

/**
 * Frontière HTTP du domaine `catalog` (story 1.9, FR-5) :
 * - `GET /api/v1/catalog/hotels/:id?checkInDate&checkOutDate&guests` — détail hôtel public
 *   (identité + galerie composée + chambres pour les dates en contexte).
 *
 * Réexpose l'enveloppe `ApiResponse<T>` **à l'identique** (l'`api-client` du front la lit tel quel).
 * Un hôtel introuvable remonte en **404** (via `PmsRequestError` → filtre d'exceptions global) ;
 * une panne PMS du détail remonte en **503**.
 *
 * ⚠️ `id` est **validé en GUID** (`ParseUUIDPipe`) : il est interpolé dans les chemins PMS, et
 * Express décode les paramètres de route — sans cette garde, un appelant pourrait injecter une
 * query (`?x=1`) ou une traversée (`..%2F..%2F`) et **choisir l'endpoint PMS** atteint depuis le
 * BFF. Le front n'émet de toute façon que des GUID (`extractHotelId`).
 */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('hotels/:id')
  async getHotel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: HotelDetailQueryDto,
  ): Promise<ApiResponse<HotelDetailDto>> {
    return {
      success: true,
      data: await this.catalogService.getHotelDetail(id, query),
    };
  }
}
