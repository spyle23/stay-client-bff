import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  type HealthCheckResult,
  HealthCheckService,
} from '@nestjs/terminus';
import { PmsHealthIndicator } from './pms.health';
import { RedisHealthIndicator } from './redis.health';

/**
 * Health check (hors préfixe `/api/v1`) — AR-15 :
 * - `/health/live` : **liveness** locale (l'app répond), SANS dépendance externe. Sonde utilisée
 *   par le healthcheck du conteneur / le gate `depends_on` (ne doit jamais dépendre du PMS externe).
 * - `/health` : **readiness** complète (Redis + joignabilité PMS), pour le monitoring/orchestrateur.
 *
 * Séparer les deux évite qu'un PMS externe down bloque le démarrage du front (deadlock `depends_on`).
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly redis: RedisHealthIndicator,
    private readonly pms: PmsHealthIndicator,
  ) {}

  @Get('live')
  @HealthCheck()
  checkLive(): Promise<HealthCheckResult> {
    // Liveness : aucune dépendance sondée → 200 tant que le process répond.
    return this.health.check([]);
  }

  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.redis.isHealthy('redis'),
      () => this.pms.isHealthy('pms'),
    ]);
  }
}
