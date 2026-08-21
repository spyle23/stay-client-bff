import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import {
  resolveThrottlerOptions,
  THROTTLER_MESSAGE,
  THROTTLER_NAMES,
} from './throttler.constants';
import type { RequestWithSession } from '../decorators/current-session.decorator';

/**
 * Limitation de débit du BFF (story 2.4 — FR-9 / NFR-7).
 *
 * ⚠️ **Aucun `APP_GUARD`** : le `ThrottlerGuard` est appliqué **route par route**
 * (`@UseGuards(ThrottlerGuard)`), et seulement sur les deux écritures qui laissent une trace
 * durable dans le PMS. Une politique globale freinerait les lectures publiques rendues en SSR
 * (une page de résultats déclenche plusieurs appels par visite) et relève de la story **6.1**.
 *
 * Deux compteurs nommés s'appliquent conjointement à toute route gardée : `ip` et `identity`.
 */
/**
 * Module minimal exposant le stockage Redis.
 *
 * Nécessaire parce que `ThrottlerModule.forRootAsync` construit un module **dynamique** : sa
 * `useFactory` ne voit que ce qui est déclaré dans **ses** `imports`. Sans ce module dédié,
 * `RedisThrottlerStorage` reste invisible et le boot échoue sur `THROTTLER:MODULE_OPTIONS`.
 */
@Module({
  providers: [RedisThrottlerStorage],
  exports: [RedisThrottlerStorage],
})
export class ThrottlerStorageModule {}

@Module({
  imports: [
    ThrottlerStorageModule,
    ThrottlerModule.forRootAsync({
      imports: [ThrottlerStorageModule],
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => {
        const options = resolveThrottlerOptions();
        return {
          storage,
          errorMessage: THROTTLER_MESSAGE,
          throttlers: [
            {
              name: THROTTLER_NAMES.ip,
              ttl: options.windowMs,
              limit: options.ipLimit,
              blockDuration: options.blockMs,
            },
            {
              name: THROTTLER_NAMES.identity,
              ttl: options.windowMs,
              limit: options.identityLimit,
              blockDuration: options.blockMs,
              getTracker: identityTracker,
            },
          ],
        };
      },
    }),
  ],
  // `ThrottlerModule` est `@Global()` : une fois enregistré, ses jetons (options + stockage) sont
  // résolubles partout, y compris par le `ThrottlerGuard` posé en `@UseGuards` sur une route.
  exports: [ThrottlerModule, ThrottlerStorageModule],
})
export class AppThrottlerModule {}

/**
 * Traceur d'**identité** : le compte connecté, à défaut l'email soumis, à défaut l'IP.
 *
 * - `clientSession` est posé par `SessionGuard`, déclaré **avant** `ThrottlerGuard` dans
 *   `@UseGuards` — les gardes s'exécutent dans l'ordre déclaré ;
 * - sur `POST /auth/guest` (non gardée par session), l'identité est l'email du corps. Il est lu
 *   **brut** : les pipes de validation s'exécutent après les gardes, d'où la normalisation
 *   explicite ici — sans elle, `Alice@x.fr` et `alice@x.fr` rempliraient deux seaux distincts ;
 * - repli sur l'IP plutôt que sur une constante : une clé partagée mettrait tous les visiteurs
 *   anonymes dans le même seau et le premier abuseur bloquerait tout le monde.
 */
export function identityTracker(req: Record<string, unknown>): string {
  const request = req as unknown as RequestWithSession & Request;

  const userId = request.clientSession?.user.userId;
  if (userId) {
    return `user:${userId}`;
  }

  const email = (request.body as { email?: unknown } | undefined)?.email;
  if (typeof email === 'string' && email.trim().length > 0) {
    return `email:${throttleEmailKey(email)}`;
  }

  return `ip:${request.ip ?? 'inconnue'}`;
}

/** Fournisseurs pour lesquels les points de la partie locale ne distinguent pas deux boîtes. */
const DOTLESS_LOCAL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Clé de limitation dérivée d'un email — **jamais** la valeur transmise au PMS (revue 2.4).
 *
 * Sans elle, le compteur d'identité était contournable à volonté sur `POST /auth/guest` :
 * `alice+1@x.fr`, `alice+2@x.fr`… atteignent la **même** boîte mais ouvraient chacun leur seau,
 * ne laissant que la limite par IP — précisément celle qu'un `TRUST_PROXY` mal réglé neutralise.
 * On retire donc le sous-adressage (`+…`), et chez Gmail les points de la partie locale.
 *
 * ⚠️ Réservé strictement au **comptage** : le compte PMS, lui, est provisionné avec l'email tel
 * que saisi (normalisé par le DTO). Confondre les deux rattacherait la réservation d'un voyageur
 * à l'adresse d'un autre.
 */
function throttleEmailKey(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) {
    return normalized;
  }

  const domain = normalized.slice(at + 1);
  let local = normalized.slice(0, at);

  const plus = local.indexOf('+');
  if (plus >= 0) {
    local = local.slice(0, plus);
  }
  if (DOTLESS_LOCAL_DOMAINS.has(domain)) {
    local = local.replaceAll('.', '');
  }

  // Une partie locale vidée par la normalisation (`+promo@x.fr`, `...@gmail.com`) mettrait tout
  // un domaine dans un seul seau : on conserve alors l'adresse telle quelle.
  return local === '' ? normalized : `${local}@${domain}`;
}
