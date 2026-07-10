import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CorrelationModule } from './common/correlation/correlation.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { buildValidationPipe } from './common/pipes/validation.pipe';
import { pinoHttpOptions } from './common/logging/logger.config';
import { RedisModule } from './redis/redis.module';
import { PmsModule } from './integration/pms/pms.module';
import { AuthModule } from './modules/auth/auth.module';
import { SearchModule } from './modules/search/search.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { BookingModule } from './modules/booking/booking.module';
import { PaymentModule } from './modules/payment/payment.module';
import { AccountModule } from './modules/account/account.module';
import { ConsentModule } from './modules/consent/consent.module';
import { HealthModule } from './modules/health/health.module';

// Socle transverse (story 1.3) : logs pino + redaction, corrélation-id, Redis (magasin d'état),
// health check. PmsModule (1.2) = frontière PMS. SearchModule (1.6) = 1ʳᵉ route métier ; la
// story pose aussi la frontière HTTP globale (ValidationPipe + filtre d'exceptions), enregistrée
// via APP_PIPE/APP_FILTER pour s'appliquer partout, y compris dans les tests e2e.
@Module({
  imports: [
    LoggerModule.forRoot({ pinoHttp: pinoHttpOptions }),
    CorrelationModule,
    RedisModule,
    PmsModule,
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
  providers: [
    AppService,
    { provide: APP_PIPE, useValue: buildValidationPipe() },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
