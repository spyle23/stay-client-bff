import { Injectable } from '@nestjs/common';
import {
  type HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { RedisService } from '../../redis/redis.service';

/** Indicateur de santé Redis : `ping` borné → up ; toute erreur → down. */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly redis: RedisService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      // Ping borné : garantit que /health ne pend jamais même si le client est dans un état bloqué.
      const pong = await this.withTimeout(this.redis.ping(), 2000);
      if (pong !== 'PONG') {
        return indicator.down({ message: `ping inattendu: ${pong}` });
      }
      return indicator.up();
    } catch (err) {
      return indicator.down({
        message: err instanceof Error ? err.message : 'Redis injoignable',
      });
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms),
      ),
    ]);
  }
}
