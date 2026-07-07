import { Global, Module } from '@nestjs/common';
import { CorrelationService } from './correlation.service';

/**
 * Expose `CorrelationService` globalement. Le middleware d'entrée (`correlationMiddleware`)
 * est appliqué au niveau applicatif dans `main.ts` (avant `pino`), pas via ce module,
 * pour garantir l'ordre d'exécution.
 */
@Global()
@Module({
  providers: [CorrelationService],
  exports: [CorrelationService],
})
export class CorrelationModule {}
