import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { ApiResponse } from '../../integration/pms/api-response.types';
import { CatalogService } from './catalog.service';
import type { HotelDetailDto } from './dto/hotel-detail.dto';
import { HotelDetailQueryDto } from './dto/hotel-detail.query.dto';
import type { RoomDetailDto } from './dto/room-detail.dto';

/**
 * Frontière HTTP du domaine `catalog` :
 * - `GET /api/v1/catalog/hotels/:id?checkInDate&checkOutDate&guests` — détail hôtel public
 *   (identité + galerie composée + chambres pour les dates en contexte) — story 1.9, FR-5.
 * - `GET /api/v1/catalog/hotels/:hotelId/rooms/:roomId?checkInDate&checkOutDate&guests` — fiche
 *   chambre publique (photos, catégorie, capacité, équipements, services inclus, prix + dispo)
 *   — story 1.10, FR-6.
 *
 * Réexpose l'enveloppe `ApiResponse<T>` **à l'identique** (l'`api-client` du front la lit tel quel).
 * Un hôtel/une chambre introuvable remonte en **404** (via `PmsRequestError` → filtre d'exceptions
 * global) ; une panne PMS du détail remonte en **503**.
 *
 * ⚠️ Chaque id est **validé en GUID** (`ParseUUIDPipe`) : il est interpolé dans les chemins PMS, et
 * Express décode les paramètres de route — sans cette garde, un appelant pourrait injecter une
 * query (`?x=1`) ou une traversée (`..%2F..%2F`) et **choisir l'endpoint PMS** atteint depuis le
 * BFF. Le front n'émet de toute façon que des GUID (`extractHotelId` / `[roomId]`).
 *
 * La query réutilise `HotelDetailQueryDto` (contrat identique : `checkInDate`/`checkOutDate`/
 * `guests`) — dupliquer un second DTO n'apporterait rien et risquerait la divergence.
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

  @Get('hotels/:hotelId/rooms/:roomId')
  async getRoom(
    @Param('hotelId', new ParseUUIDPipe()) hotelId: string,
    @Param('roomId', new ParseUUIDPipe()) roomId: string,
    @Query() query: HotelDetailQueryDto,
  ): Promise<ApiResponse<RoomDetailDto>> {
    return {
      success: true,
      data: await this.catalogService.getRoomDetail(hotelId, roomId, query),
    };
  }
}
