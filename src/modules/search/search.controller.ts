import { Controller, Get, Query } from '@nestjs/common';
import type { ApiListResponse } from '../../integration/pms/api-response.types';
import type { HotelAvailabilityDto } from './dto/hotel-availability.dto';
import { SearchHotelsQueryDto } from './dto/search-hotels.query.dto';
import { SearchNearbyQueryDto } from './dto/search-nearby.query.dto';
import { SearchService, type SearchHotelsResult } from './search.service';

/**
 * Frontière HTTP de recherche exposée au front :
 * - `GET /api/v1/search/hotels` — recherche par destination (FR-1).
 * - `GET /api/v1/search/hotels/nearby` — recherche « à proximité » (FR-2, distance + tri distance).
 *
 * Réexpose l'enveloppe `ApiListResponse<T>` **à l'identique** (l'`api-client` du front la lit tel quel).
 */
// NFR-7 : le throttling anti-abus de la recherche est délégué à la story 6.1 (aucun seuil
// défini ici). Le cache Redis + le plafond de fan-out atténuent déjà le déni d'inventaire.
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get('hotels')
  async searchHotels(
    @Query() query: SearchHotelsQueryDto,
  ): Promise<ApiListResponse<HotelAvailabilityDto>> {
    return toListResponse(await this.searchService.searchHotels(query));
  }

  @Get('hotels/nearby')
  async searchNearbyHotels(
    @Query() query: SearchNearbyQueryDto,
  ): Promise<ApiListResponse<HotelAvailabilityDto>> {
    return toListResponse(await this.searchService.searchNearby(query));
  }
}

/** Enveloppe `ApiListResponse` + pagination 6 champs, identique pour les deux modes. */
function toListResponse(
  result: SearchHotelsResult,
): ApiListResponse<HotelAvailabilityDto> {
  const { items, page, pageSize, totalCount } = result;
  const totalPages = pageSize > 0 ? Math.ceil(totalCount / pageSize) : 0;
  return {
    success: true,
    data: items,
    pagination: {
      page,
      pageSize,
      totalCount,
      totalPages,
      hasPreviousPage: page > 1,
      hasNextPage: page < totalPages,
    },
  };
}
