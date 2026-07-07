import { Inject, Injectable } from '@nestjs/common';
import { isConfirmationPath } from './confirm-path';
import type { PmsRequestContext } from './pms-client.service';

export const SERVICE_KEY_TOKEN = 'PMS_SERVICE_KEY';

/**
 * Détenteur **exclusif** de la clé de service (AR-8). Le `X-Service-Key` n'est produit que
 * pour l'appel de confirmation de réservation, jamais ailleurs, et jamais exposé au navigateur.
 * `PmsClientService` applique la même frontière au point d'envoi réel (défense en profondeur).
 *
 * La clé de confirmation `Pending → Confirmed` (FR-13) sera émise par le module `payment`
 * (Epic 3) en passant par `confirmationContext()`.
 */
@Injectable()
export class ServiceKeyProvider {
  constructor(@Inject(SERVICE_KEY_TOKEN) private readonly serviceKey: string) {}

  /** En-têtes de service pour la route de confirmation. Rejette tout autre chemin ou une clé vide. */
  confirmationHeaders(path: string): Record<string, string> {
    if (!isConfirmationPath(path)) {
      throw new Error(
        `X-Service-Key interdit hors de la route de confirmation /reservations/{id}/confirm (reçu: "${path}").`,
      );
    }
    if (!this.serviceKey) {
      // Fail-fast : mieux vaut une erreur explicite qu'un X-Service-Key vide refusé tard par le PMS.
      throw new Error(
        'SERVICE_KEY manquant : impossible de produire X-Service-Key pour la confirmation.',
      );
    }
    return { 'X-Service-Key': this.serviceKey };
  }

  /** Contexte `PmsRequestContext` prêt pour `PmsClientService.post(confirmPath, body, ctx)`. */
  confirmationContext(
    path: string,
    extra?: PmsRequestContext,
  ): PmsRequestContext {
    return {
      ...extra,
      headers: { ...(extra?.headers ?? {}), ...this.confirmationHeaders(path) },
    };
  }
}
