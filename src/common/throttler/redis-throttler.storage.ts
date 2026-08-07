import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
// `ThrottlerStorageRecord` n'est pas réexporté par l'index du paquet (v6) : import direct du
// sous-chemin, aligné sur la structure réelle de `node_modules/@nestjs/throttler/dist/`.
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from '../../redis/redis.service';

/**
 * Stockage **Redis** des compteurs de limitation de débit (story 2.4 — NFR-7, AR-6).
 *
 * Pourquoi maison plutôt qu'un paquet : le BFF est **stateless** et scale horizontalement, donc le
 * stockage mémoire par défaut de `@nestjs/throttler` ne limite rien au-delà d'une instance. Redis
 * est déjà l'unique magasin d'état du BFF (AR-6) et `RedisService` est déjà injectable partout —
 * une cinquantaine de lignes suffisent, contre une dépendance supplémentaire à maintenir.
 *
 * ⚠️ **Unités (v6, vérifiées dans `node_modules/@nestjs/throttler`)** : `ttl` et `blockDuration`
 * arrivent en **millisecondes**, tandis que `timeToExpire` et `timeToBlockExpire` doivent repartir
 * en **secondes** (le guard les pose tels quels dans `X-RateLimit-Reset` / `Retry-After`). Se
 * tromper d'unité rend la limite soit inopérante, soit quasi permanente.
 *
 * ⚠️ **Sémantique attendue par `ThrottlerGuard`** : il ne lève que si `isBlocked` est vrai. C'est
 * donc au stockage de décider du blocage — `totalHits > limit`, exactement comme l'implémentation
 * mémoire de référence.
 *
 * ⚠️ **Un blocage expiré repart d'un compteur VIERGE** (revue 2.4). L'implémentation mémoire de
 * référence appelle `resetBlockdRequest` (`totalHits.set(name, 0)`) dès que le blocage échoit,
 * puis recompte la frappe courante. Sans cela, avec une fenêtre longue et un blocage court
 * (`THROTTLE_WINDOW_MS=3600000`, `THROTTLE_BLOCK_MS=60000`), la frappe suivant la levée du blocage
 * incrémenterait un compteur resté à `limit + 1` et **re-bloquerait immédiatement** : une sanction
 * de 60 s configurée deviendrait une exclusion d'une heure. La remise à zéro se fait ici **par les
 * TTL** : au moment du blocage, l'expiration du compteur est réalignée sur celle du blocage, si
 * bien que les deux clés disparaissent ensemble et que la frappe suivante repart à 1.
 *
 * **Fail-closed** : une panne Redis remonte en 503 plutôt que de laisser passer. Sur une route qui
 * crée des réservations et des comptes PMS, « limiteur en panne = tout passe » serait la pire des
 * options — et de toute façon la session, elle aussi en Redis, serait déjà indisponible.
 */

const COUNTER_PREFIX = 'throttle:hits:v1:';
const BLOCK_PREFIX = 'throttle:block:v1:';

/**
 * Incrément **atomique** du compteur + pose du TTL, en **un seul aller-retour** (revue 2.4).
 *
 * Enchaîner `INCR`, `PTTL` puis `PEXPIRE` côté client laissait deux failles :
 * - deux instances pouvaient s'intercaler entre les commandes (compteur faux) ;
 * - une panne réseau **après** l'`INCR` mais **avant** le `PEXPIRE` laissait une clé **sans
 *   expiration**, donc un tracker bloqué définitivement (la réparation n'arrivait qu'à la frappe
 *   suivante, qui pouvait ne jamais venir pour un compte donné).
 *
 * Le TTL n'est posé que si la clé n'en a pas (`PTTL < 0`) : la fenêtre est **fixe** — elle ne se
 * prolonge pas à chaque frappe, sinon un martèlement continu la rendrait infinie. Cette pose
 * conditionnelle assure aussi l'auto-guérison d'un compteur trouvé sans expiration.
 *
 * Renvoie `[totalHits, ttlRestantMs]`. Même patron que le compare-and-delete du verrou de séjour
 * (`checkout-hold.service.ts`) : script court, sans état, rejouable.
 */
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const counterKey = `${COUNTER_PREFIX}${throttlerName}:${key}`;
    const blockKey = `${BLOCK_PREFIX}${throttlerName}:${key}`;

    try {
      // Déjà bloqué : ne pas compter davantage — un martèlement ne doit pas prolonger la sanction.
      const blockTtlMs = await this.redis.raw.pttl(blockKey);
      if (blockTtlMs > 0) {
        const hits = Number((await this.redis.get(counterKey)) ?? 0);
        return {
          totalHits: Number.isFinite(hits) ? hits : 0,
          // Compteur et blocage expirent **ensemble** (voir plus bas) : une seule échéance à
          // exposer, et `X-RateLimit-Reset` annonce donc l'instant où le quota repart vraiment.
          timeToExpire: toSeconds(blockTtlMs),
          isBlocked: true,
          timeToBlockExpire: toSeconds(blockTtlMs),
        };
      }

      const [totalHits, ttlMs] = (await this.redis.raw.eval(
        INCREMENT_SCRIPT,
        1,
        counterKey,
        ttl,
      )) as [number, number];

      if (totalHits > limit) {
        await this.redis.raw.set(blockKey, '1', 'PX', blockDuration);
        // Remise à zéro du compteur **à la levée du blocage** : en alignant son expiration sur
        // celle du blocage, les deux clés meurent ensemble et la frappe suivante repart à 1.
        // ⚠️ Ordre volontaire (blocage d'abord) : une panne entre les deux commandes laisse un
        // tracker sur-puni au pire une fenêtre, jamais un tracker non bloqué — ce fichier est
        // fail-closed. Les deux appels ne sont pas fusionnés dans le script Lua pour que la
        // décision de blocage reste testable ligne à ligne contre un vrai double de Redis.
        await this.redis.raw.pexpire(counterKey, blockDuration);
        return {
          totalHits,
          timeToExpire: toSeconds(blockDuration),
          isBlocked: true,
          timeToBlockExpire: toSeconds(blockDuration),
        };
      }

      return {
        totalHits,
        timeToExpire: toSeconds(ttlMs),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    } catch (err) {
      this.logger.error(
        `Compteurs anti-abus indisponibles : ${err instanceof Error ? err.message : 'erreur inconnue'}`,
      );
      throw new ServiceUnavailableException(
        'Service momentanément indisponible.',
      );
    }
  }
}

/** Millisecondes → secondes entières (jamais négatif : une clé absente vaut 0). */
function toSeconds(ms: number): number {
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}
