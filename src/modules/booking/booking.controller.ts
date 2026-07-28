import { Controller, Get, Query } from '@nestjs/common';
import type { ApiResponse } from '../../integration/pms/api-response.types';
import { BookingService } from './booking.service';
import type { BookingQuoteDto } from './dto/booking-quote.dto';
import { BookingQuoteQueryDto } from './dto/booking-quote.query.dto';

/**
 * Frontière HTTP du domaine `booking` (tunnel de réservation) :
 * - `GET /api/v1/booking/quote?hotelId&roomId&checkInDate&checkOutDate&guests` — devis du
 *   récapitulatif avant paiement (story 2.2, FR-7).
 *
 * **Route publique, volontairement non gardée.** L'identification est l'étape suivante (story 2.3)
 * et l'inscription n'est **jamais** forcée avant de réserver (UX-DR-9.6, UX-DR-3.12) : exiger une
 * session ici transformerait le récapitulatif en mur de connexion. Aucune donnée personnelle n'est
 * exposée — uniquement des informations publiques d'hôtel/chambre déjà servies par `catalog`.
 *
 * Réexpose l'enveloppe `ApiResponse<T>` **à l'identique** (l'`api-client` du front la lit tel quel).
 * Hôtel/chambre introuvable → **404** ; dates inexploitables → **400** ; panne PMS → **503** (via
 * le filtre d'exceptions global).
 */
@Controller('booking')
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Get('quote')
  async getQuote(
    @Query() query: BookingQuoteQueryDto,
  ): Promise<ApiResponse<BookingQuoteDto>> {
    return {
      success: true,
      data: await this.bookingService.getQuote(query),
    };
  }
}
