/**
 * Reconnaissance de l'unique route autorisée à porter `X-Service-Key` (AR-8) :
 * `POST /reservations/{id}/confirm` (chemin relatif à la baseURL `…/api/v1`).
 *
 * Partagé par `ServiceKeyProvider` (qui produit l'en-tête) et `PmsClientService`
 * (qui refuse d'émettre `X-Service-Key` vers toute autre route) — frontière appliquée
 * au point d'envoi réel, pas seulement à la construction de l'en-tête.
 */
const CONFIRM_PATH = /^\/?reservations\/[^/]+\/confirm$/;

export function isConfirmationPath(path: string): boolean {
  return CONFIRM_PATH.test(path);
}
