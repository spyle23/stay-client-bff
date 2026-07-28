import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { BOOKING_OPTIONS, resolveBookingOptions } from './booking.constants';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

/**
 * Module `booking` (story 2.2, FR-7) — tunnel de réservation, étape « récapitulatif ».
 *
 * Importe `CatalogModule` (qui **exporte** `CatalogService`) plutôt que `PmsModule` : le devis est
 * une composition du détail chambre, pas un second chemin d'accès au PMS. `RedisService` et
 * `CorrelationService` sont globaux (injectés sans réimport).
 */
@Module({
  imports: [CatalogModule],
  controllers: [BookingController],
  providers: [
    { provide: BOOKING_OPTIONS, useFactory: () => resolveBookingOptions() },
    BookingService,
  ],
})
export class BookingModule {}
