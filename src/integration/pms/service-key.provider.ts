import { Inject, Injectable } from '@nestjs/common';
import type { PmsRequestContext } from './pms-client.service';
import { isServiceKeyRoute, type ServiceKeyMethod } from './service-key-routes';

export const SERVICE_KEY_TOKEN = 'PMS_SERVICE_KEY';

/**
 * Détenteur **exclusif** de la clé de service (AR-8). Le `X-Service-Key` n'est produit que pour
 * les routes de la liste blanche (`service-key-routes.ts`, miroir de #153), jamais ailleurs, et
 * jamais exposé au navigateur. `PmsClientService` applique la même frontière au point d'envoi réel
 * (défense en profondeur).
 *
 * Utilisateurs : la confirmation ferme (story 3.2) et la réconciliation (#5), qui lit l'état d'une
 * réservation et de son paiement sans session voyageur.
 */
@Injectable()
export class ServiceKeyProvider {
  constructor(@Inject(SERVICE_KEY_TOKEN) private readonly serviceKey: string) {}

  /** En-têtes de service pour une route de la liste blanche. Rejette tout autre appel ou une clé vide. */
  serviceHeaders(
    method: ServiceKeyMethod,
    path: string,
  ): Record<string, string> {
    if (!isServiceKeyRoute(method, path)) {
      throw new Error(
        `X-Service-Key interdit hors de la liste blanche des routes de service (reçu: ${method} "${path}").`,
      );
    }
    if (!this.serviceKey) {
      // Fail-fast : mieux vaut une erreur explicite qu'un X-Service-Key vide refusé tard par le PMS.
      throw new Error(
        'SERVICE_KEY manquant : impossible de produire X-Service-Key pour un appel de service.',
      );
    }
    return { 'X-Service-Key': this.serviceKey };
  }

  /** Contexte `PmsRequestContext` prêt pour un appel de service (`get`/`post` du client PMS). */
  serviceContext(
    method: ServiceKeyMethod,
    path: string,
    extra?: PmsRequestContext,
  ): PmsRequestContext {
    return {
      ...extra,
      headers: {
        ...(extra?.headers ?? {}),
        ...this.serviceHeaders(method, path),
      },
    };
  }

  /** En-têtes de service pour `POST /reservations/{id}/confirm`. */
  confirmationHeaders(path: string): Record<string, string> {
    return this.serviceHeaders('POST', path);
  }

  /** Contexte prêt pour `PmsClientService.post(confirmPath, body, ctx)`. */
  confirmationContext(
    path: string,
    extra?: PmsRequestContext,
  ): PmsRequestContext {
    return this.serviceContext('POST', path, extra);
  }
}
