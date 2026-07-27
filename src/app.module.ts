import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
//
// `ConfigModule.forRoot` (story 2.1) charge `.env` dans `process.env` **au chargement du module**,
// donc avant toute `useFactory` (dont `resolveAuthOptions`, fail-fast sur `SESSION_SECRET`).
// Il ne remplace PAS le pattern « fonction pure + process.env » déjà en place (`resolvePmsClientOptions`,
// `resolveCatalogOptions`…) : il rend simplement le fichier `.env` — jusqu'ici jamais lu — effectif.
// Les variables déjà présentes dans l'environnement gardent la priorité (ex. `CORS_ORIGIN` injecté
// par `scripts/client-stack-up.ps1`, valeurs posées par les tests e2e).
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // En test, le `.env` local (gitignoré, propre à la machine) ne doit PAS être chargé :
      // il coupleraient les 9 suites e2e qui bootent AppModule à un fichier non versionné.
      // Les valeurs de test sont posées par `test/setup-env.ts`.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
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
