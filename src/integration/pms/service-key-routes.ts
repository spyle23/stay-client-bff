/**
 * **Liste blanche** des routes PMS autorisées à porter `X-Service-Key` (AR-8, #153, #5 AC-7).
 *
 * Miroir exact de `ServiceKeyRoutes` côté Stay-api (méthode + gabarit, contrainte `{id:guid}`) :
 * - `POST /reservations/{id}/confirm` — confirmation ferme (story 3.2) ;
 * - `GET  /reservations/{id}` — lecture de service d'une réservation (réconciliation, #5) ;
 * - `GET  /reservations/{id}/payment` — lecture de service du paiement (réconciliation, #5).
 *
 * Chemins relatifs à la baseURL `…/api/v1`. Partagée par `ServiceKeyProvider` (qui produit
 * l'en-tête) et `PmsClientService` (qui refuse d'émettre `X-Service-Key` vers toute autre route) :
 * la frontière est appliquée au point d'envoi réel, pas seulement à la construction de l'en-tête.
 *
 * ⚠️ Toute modification de la liste côté PMS DOIT être répercutée ici (et inversement) : un test
 * énumère les entrées et échoue si l'une est ajoutée ou retirée.
 */

export type ServiceKeyMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ServiceKeyRoute {
  method: ServiceKeyMethod;
  /** Gabarit lisible, identique à celui du PMS (diagnostic et test d'énumération). */
  template: string;
  pattern: RegExp;
}

/** GUID 8-4-4-4-12, comme la contrainte de route `{id:guid}` du PMS. */
const GUID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export const SERVICE_KEY_ROUTES: readonly ServiceKeyRoute[] = Object.freeze([
  {
    method: 'POST',
    template: '/reservations/{id:guid}/confirm',
    pattern: new RegExp(`^/?reservations/${GUID}/confirm$`),
  },
  {
    method: 'GET',
    template: '/reservations/{id:guid}',
    pattern: new RegExp(`^/?reservations/${GUID}$`),
  },
  {
    method: 'GET',
    template: '/reservations/{id:guid}/payment',
    pattern: new RegExp(`^/?reservations/${GUID}/payment$`),
  },
]);

/** `true` si `(méthode, chemin)` figure dans la liste blanche — query-string et slash final refusés. */
export function isServiceKeyRoute(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  return SERVICE_KEY_ROUTES.some(
    (route) => route.method === verb && route.pattern.test(path),
  );
}
