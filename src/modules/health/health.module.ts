import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PmsHealthIndicator } from './pms.health';
import { RedisHealthIndicator } from './redis.health';

/**
 * Health check (story 1.3). Redis via `RedisService` (RedisModule global) ;
 * joignabilité PMS via sonde bornée. Endpoint `/health` (cf. HealthController).
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator, PmsHealthIndicator],
})
export class HealthModule {}
