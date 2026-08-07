import { Module } from '@nestjs/common';
import { AppThrottlerModule } from '../../common/throttler/throttler.module';
import { PmsModule } from '../../integration/pms/pms.module';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { BOOKING_OPTIONS, resolveBookingOptions } from './booking.constants';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { CheckoutHoldService } from './checkout-hold.service';
import { CheckoutHoldSweeper } from './checkout-hold.sweeper';

/**
 * Module `booking` — tunnel de réservation (stories 2.2 et 2.4).
 *
 * - `CatalogModule` (qui **exporte** `CatalogService`) : le devis et le pré-contrôle de création
 *   sont une composition du détail chambre, pas un second chemin d'accès au PMS.
 * - `AuthModule` : `SessionService` (custody des jetons — **seul** chemin d'appel PMS authentifié)
 *   et `SessionGuard`. Le module exporte déjà les deux « pour `booking` (2.4) ».
 * - `PmsModule` : les **écritures** (création, annulation) passent par le client résilient.
 * - `AppThrottlerModule` : fournit `ThrottlerGuard` et ses options ; le guard n'est **pas** global,
 *   il est appliqué route par route dans le contrôleur.
 *
 * `RedisService`, `CorrelationService` et `SchedulerRegistry` sont globaux (injectés sans réimport).
 */
@Module({
  imports: [CatalogModule, AuthModule, PmsModule, AppThrottlerModule],
  controllers: [BookingController],
  providers: [
    { provide: BOOKING_OPTIONS, useFactory: () => resolveBookingOptions() },
    BookingService,
    CheckoutHoldService,
    CheckoutHoldSweeper,
  ],
  exports: [CheckoutHoldService],
})
export class BookingModule {}
