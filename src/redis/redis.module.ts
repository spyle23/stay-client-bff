import { Global, Logger, Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

/**
 * Socle Redis global (AR-6) : Redis est l'**unique magasin d'état** du BFF.
 *
 * Le client `ioredis` reconnecte en tâche de fond et **ne fait pas crasher le boot** si Redis
 * est momentanément indisponible (les erreurs sont loguées, la readiness `/health` reflète l'état
 * réel). `@Global` → `RedisService`/`REDIS_CLIENT` injectables partout sans réimport.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis => {
        const logger = new Logger('RedisClient');
        const client = new Redis(
          process.env.REDIS_URL ?? 'redis://localhost:6379',
          {
            // Reconnexion progressive plafonnée ; une panne de connexion ne bloque pas le boot
            // (les erreurs de connexion sont async ; une REDIS_URL syntaxiquement invalide, elle,
            //  échoue vite — fail-fast sur config). Le /health borne son ping par timeout (2 s),
            //  ce qui évite tout blocage même si une commande reste en file offline.
            retryStrategy: (times) => Math.min(times * 200, 2000),
            maxRetriesPerRequest: 2,
          },
        );
        // Sans handler 'error', une panne Redis émettrait une erreur non capturée (crash).
        client.on('error', (err: Error) =>
          logger.warn(`Redis indisponible: ${err.message}`),
        );
        client.on('connect', () => logger.log('Redis connecté'));
        return client;
      },
    },
    RedisService,
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}
