import {
  isServiceKeyRoute,
  SERVICE_KEY_ROUTES,
  type ServiceKeyMethod,
} from './service-key-routes';

const ID = '3f2b8c1e-6d4a-4b7e-9a10-5c2d1e0f9a88';

describe('Liste blanche X-Service-Key (miroir de ServiceKeyRoutes du PMS, #153 / #5 AC-7)', () => {
  it('énumère exactement les trois routes de service du PMS, méthode comprise', () => {
    // Ajouter ou retirer une entrée doit faire échouer ce test : la liste suit celle du PMS.
    expect(
      SERVICE_KEY_ROUTES.map((route) => `${route.method} ${route.template}`),
    ).toEqual([
      'POST /reservations/{id:guid}/confirm',
      'GET /reservations/{id:guid}',
      'GET /reservations/{id:guid}/payment',
    ]);
  });

  it.each<[ServiceKeyMethod, string]>([
    ['POST', `/reservations/${ID}/confirm`],
    ['POST', `reservations/${ID}/confirm`],
    ['GET', `/reservations/${ID}`],
    ['GET', `/reservations/${ID}/payment`],
    ['GET', `/reservations/${ID.toUpperCase()}/payment`],
  ])('accepte %s %s', (method, path) => {
    expect(isServiceKeyRoute(method, path)).toBe(true);
  });

  it.each<[ServiceKeyMethod, string]>([
    // Bonne route, mauvaise méthode.
    ['GET', `/reservations/${ID}/confirm`],
    ['POST', `/reservations/${ID}`],
    ['DELETE', `/reservations/${ID}`],
    ['PUT', `/reservations/${ID}/payment`],
    // Identifiant qui n'est pas un GUID (contrainte `{id:guid}` du PMS).
    ['POST', '/reservations/abc-123/confirm'],
    ['GET', '/reservations/r1'],
    // Routes hors liste (AC-3 de #153).
    ['GET', `/roomreservations/${ID}`],
    ['GET', `/payments/${ID}`],
    ['POST', `/roomreservations/${ID}/cancel`],
    ['GET', '/reservations/validate'],
    ['GET', '/hotels'],
    // Contournements : query-string, segment en trop, slash final, remontée de chemin.
    ['GET', `/reservations/${ID}?x=1`],
    ['GET', `/reservations/${ID}/payment/extra`],
    ['GET', `/reservations/${ID}/`],
    ['GET', `/reservations/${ID}/../../payments/${ID}`],
  ])('refuse %s %s', (method, path) => {
    expect(isServiceKeyRoute(method, path)).toBe(false);
  });
});
