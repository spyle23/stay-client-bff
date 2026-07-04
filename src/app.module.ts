import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { SearchModule } from './modules/search/search.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { BookingModule } from './modules/booking/booking.module';
import { PaymentModule } from './modules/payment/payment.module';
import { AccountModule } from './modules/account/account.module';
import { ConsentModule } from './modules/consent/consent.module';
import { HealthModule } from './modules/health/health.module';

// Modules de domaine enregistrés dès le scaffold (Story 1.1) — coquilles vides.
// La logique métier est ajoutée dans les stories 1.2+.
@Module({
  imports: [
    AuthModule,
    SearchModule,
    CatalogModule,
    BookingModule,
    PaymentModule,
    AccountModule,
    ConsentModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
