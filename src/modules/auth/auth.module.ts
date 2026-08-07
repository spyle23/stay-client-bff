import { Module } from '@nestjs/common';
import { SessionGuard } from '../../common/guards/session.guard';
import { AppThrottlerModule } from '../../common/throttler/throttler.module';
import { PmsModule } from '../../integration/pms/pms.module';
import { AUTH_OPTIONS, resolveAuthOptions } from './auth.constants';
import { AuthController } from './auth.controller';
import { SessionService } from './session.service';

/**
 * Domaine `auth` — **custody des jetons** `Customer` (story 2.1 : AR-9, AR-11, NFR-8, FR-19).
 *
 * `PmsModule` doit être importé explicitement (il n'est pas `@Global()`), contrairement à
 * `RedisModule` et `CorrelationModule`.
 *
 * `resolveAuthOptions()` est appelé **au démarrage** : un `SESSION_SECRET` absent ou trop court
 * fait échouer le boot (fail-fast — AC-8) plutôt que d'exposer des cookies de session forgeables.
 *
 * `SessionService` et `SessionGuard` sont exportés : les modules `booking` (2.4), `account` et
 * `payment` (Epic 3/4) s'en serviront pour tout appel PMS authentifié — **jamais** en manipulant
 * un jeton eux-mêmes.
 */
@Module({
  // `AppThrottlerModule` (story 2.4) fournit `ThrottlerGuard` : seule `POST /auth/guest` s'en sert,
  // le guard n'étant volontairement pas global (cf. `throttler.module.ts`).
  imports: [PmsModule, AppThrottlerModule],
  controllers: [AuthController],
  providers: [
    { provide: AUTH_OPTIONS, useFactory: () => resolveAuthOptions() },
    SessionService,
    SessionGuard,
  ],
  exports: [SessionService, SessionGuard, AUTH_OPTIONS],
})
export class AuthModule {}
