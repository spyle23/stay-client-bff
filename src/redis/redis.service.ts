import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Accès de base au magasin d'état Redis (AR-6). Enveloppe le client `ioredis` injecté
 * pour offrir une surface simple aux futures features (cache, idempotence, compteurs,
 * sessions, jetons `jti`, état de tunnel). Le BFF n'a **aucune** base relationnelle.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  /** Client brut pour les besoins avancés (pipelines, scripts) des futures features. */
  get raw(): Redis {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /** Écrit une valeur, avec TTL optionnel en secondes (un TTL ≤ 0 écrit sans expiration). */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    // Redis rejette `EX <= 0` ; on n'applique l'expiration que pour un TTL strictement positif.
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  /** Renvoie « PONG » si Redis répond (utilisé par le health check). */
  async ping(): Promise<string> {
    return this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    // Fermeture propre bornée : `quit()` peut rejeter/pendre si Redis n'a jamais été connecté ;
    // on borne l'attente puis on force la fermeture du socket (`disconnect`), sans jamais throw.
    try {
      await Promise.race([
        this.client.quit(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // connexion jamais établie / déjà fermée — ignoré
    } finally {
      this.client.disconnect();
    }
  }
}
