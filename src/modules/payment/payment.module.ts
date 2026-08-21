import { Module } from '@nestjs/common';
import { PmsModule } from '../../integration/pms/pms.module';
import { AuthModule } from '../auth/auth.module';
import { BookingModule } from '../booking/booking.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

/**
 * Module `payment` — autorisation carte du tunnel (story 3.1, FR-12 / D8).
 *
 * - `BookingModule` : fournit `BookingService` (relecture de la réservation qui fait foi sur le
 *   total et le statut) et `CheckoutHoldService` (le gel `paymentStarted` de FR-14). Les importer
 *   plutôt que de les réinstancier est essentiel : deux `CheckoutHoldService` liraient le même Redis
 *   mais chacun avec ses propres options, et un désaccord sur le TTL laisserait des holds orphelins.
 * - `AuthModule` : `SessionService` (custody des jetons — seul chemin d'appel PMS authentifié) et
 *   `SessionGuard`.
 * - `PmsModule` : le client résilient (timeouts, breaker, correlation-id, `Idempotency-Key`).
 *
 * ⚠️ **Aucune dépendance vers le paquet `stripe`.** Le BFF ne parle jamais à Stripe : il passe par
 * le PMS, qui seul détient les clés secrètes (AR-14, PCI SAQ-A). Le paquet reste installé depuis le
 * scaffold de la story 1.1 — ne pas l'utiliser.
 *
 * `RedisService` et `CorrelationService` sont globaux (injectés sans réimport).
 */
@Module({
  imports: [BookingModule, AuthModule, PmsModule],
  controllers: [PaymentController],
  providers: [PaymentService],
})
export class PaymentModule {}
