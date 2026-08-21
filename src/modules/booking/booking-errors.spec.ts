import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import {
  BOOKING_REASON_KEY,
  classifyReservationFailure,
  isPmsGuid,
  PMS_RESERVATION_ENDPOINTS,
  toBookingException,
} from './booking-errors';

/**
 * Corps d'erreur **réel** du PMS, relevé en conditions réelles (Phase 3 de la story 2.3) :
 * `ApiResponse<T>.Fail(error)` place le texte dans `errors`, et laisse `message` à `null`.
 * `PmsClientService.toRequestError` retombe alors sur son libellé par défaut.
 */
function pmsBadRequest(text: string): PmsRequestError {
  return new PmsRequestError('Le PMS a renvoyé le statut 400.', 400, {
    errors: [text],
    responseBody: { success: false, data: null, message: null, errors: [text] },
  });
}

describe('classifyReservationFailure', () => {
  it('reconnaît une indisponibilité datée depuis `errors` (et non `message`)', () => {
    const err = pmsBadRequest('Room is not available for the selected dates');
    expect(err.message).not.toMatch(/available/i); // le motif n'est PAS dans `message`
    expect(classifyReservationFailure(err)).toBe('room-unavailable');
  });

  it('reconnaît une chambre hors service (statut ≠ Available)', () => {
    expect(
      classifyReservationFailure(
        pmsBadRequest('Room is not available for booking'),
      ),
    ).toBe('room-unavailable');
  });

  it('reconnaît un dépassement de capacité', () => {
    expect(
      classifyReservationFailure(
        pmsBadRequest('Number of guests exceeds room capacity of 2'),
      ),
    ).toBe('over-capacity');
  });

  it.each([
    'Check-out date must be after check-in date',
    'Check-in date cannot be in the past',
  ])('reconnaît des dates invalides : %s', (text) => {
    expect(classifyReservationFailure(pmsBadRequest(text))).toBe(
      'invalid-dates',
    );
  });

  it.each(['Room not found', 'Room does not belong to this hotel'])(
    'reconnaît une chambre introuvable : %s',
    (text) => {
      expect(classifyReservationFailure(pmsBadRequest(text))).toBe(
        'room-not-found',
      );
    },
  );

  it('reconnaît un client PMS introuvable comme une session invalide', () => {
    expect(
      classifyReservationFailure(pmsBadRequest('Customer not found')),
    ).toBe('session-invalid');
  });

  it('lit aussi un `errors` sous forme de dictionnaire par champ', () => {
    const err = new PmsRequestError('Le PMS a renvoyé le statut 400.', 400, {
      errors: { _: ['Room is not available for the selected dates'] },
    });
    expect(classifyReservationFailure(err)).toBe('room-unavailable');
  });

  it('lit aussi un motif porté par `message` (si le PMS le remplissait un jour)', () => {
    const err = new PmsRequestError(
      'Number of guests exceeds room capacity of 4',
      400,
    );
    expect(classifyReservationFailure(err)).toBe('over-capacity');
  });

  it('ne devine jamais : tout 400 non reconnu devient `rejected`', () => {
    expect(classifyReservationFailure(pmsBadRequest('Some future error'))).toBe(
      'rejected',
    );
  });

  it('mappe 401/403 sur `session-invalid` sans lire le texte', () => {
    expect(classifyReservationFailure(new PmsRequestError('x', 401))).toBe(
      'session-invalid',
    );
    expect(classifyReservationFailure(new PmsRequestError('x', 403))).toBe(
      'session-invalid',
    );
  });

  it('mappe un 404 PMS sur `room-not-found`', () => {
    expect(classifyReservationFailure(new PmsRequestError('x', 404))).toBe(
      'room-not-found',
    );
  });

  it('renvoie null pour une panne (elle doit remonter en 503, pas être classée)', () => {
    expect(
      classifyReservationFailure(new PmsUnavailableError('panne')),
    ).toBeNull();
    expect(classifyReservationFailure(new Error('boom'))).toBeNull();
    expect(
      classifyReservationFailure(new PmsRequestError('x', 500)),
    ).toBeNull();
  });

  it.each([
    ['408 Request Timeout', 408],
    ['425 Too Early', 425],
    ['429 Too Many Requests', 429],
  ])(
    'renvoie null sur %s : réessayable, jamais « vérifiez votre séjour »',
    (_label, status) => {
      // Ces statuts arrivent d'un proxy/WAF/limiteur, avec un corps que rien ne classe. Les
      // ranger en `rejected` afficherait un 400 « Vérifiez les informations de votre séjour »
      // à un voyageur dont le séjour est valide — et lui cacherait que réessayer suffit.
      expect(classifyReservationFailure(pmsBadRequest2(status))).toBeNull();
    },
  );

  it('classe encore les autres 4xx non reconnus en refus déterministe', () => {
    // Contre-épreuve du test ci-dessus : la sortie « réessayable » ne doit pas avaler tout 4xx.
    expect(classifyReservationFailure(pmsBadRequest2(422))).toBe('rejected');
  });
});

/** `PmsRequestError` d'un statut arbitraire, corps non classable (proxy/WAF, pas le PMS). */
function pmsBadRequest2(status: number): PmsRequestError {
  return new PmsRequestError(`Le PMS a renvoyé le statut ${status}.`, status);
}

describe('toBookingException', () => {
  it.each([
    ['room-unavailable', ConflictException, 409],
    ['over-capacity', ConflictException, 409],
    ['price-changed', ConflictException, 409],
    ['invalid-dates', BadRequestException, 400],
    ['rejected', BadRequestException, 400],
    ['room-not-found', NotFoundException, 404],
    ['session-invalid', UnauthorizedException, 401],
  ] as const)('%s → %p', (reason, type, status) => {
    const ex = toBookingException(reason);
    expect(ex).toBeInstanceOf(type);
    expect(ex.getStatus()).toBe(status);
  });

  it('porte le motif machine dans `errors.reason` (dictionnaire lisible par le front)', () => {
    const body = toBookingException('room-unavailable').getResponse() as {
      message: string;
      errors: Record<string, string[]>;
    };
    expect(body.errors[BOOKING_REASON_KEY]).toEqual(['room-unavailable']);
  });

  it('ne fait jamais fuiter le texte du PMS dans le message', () => {
    const body = toBookingException('room-unavailable').getResponse() as {
      message: string;
    };
    expect(body.message).not.toMatch(/Room is not available/i);
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('transporte le nouveau total sur `price-changed` (unités mineures + devise)', () => {
    const body = toBookingException('price-changed', {
      total: 17000,
      currency: 'EUR',
    }).getResponse() as { errors: Record<string, string[]> };
    expect(body.errors[BOOKING_REASON_KEY]).toEqual(['price-changed']);
    expect(body.errors.total).toEqual(['17000']);
    expect(body.errors.currency).toEqual(['EUR']);
  });
});

describe('PMS_RESERVATION_ENDPOINTS', () => {
  const HOTEL_ID = '11111111-1111-4111-8111-111111111111';
  const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';

  it('compose les chemins de réservation du PMS', () => {
    expect(PMS_RESERVATION_ENDPOINTS.create(HOTEL_ID)).toBe(
      `/roomreservations/hotels/${HOTEL_ID}/reservations`,
    );
    expect(PMS_RESERVATION_ENDPOINTS.byId(RESERVATION_ID)).toBe(
      `/roomreservations/${RESERVATION_ID}`,
    );
    expect(PMS_RESERVATION_ENDPOINTS.cancel(RESERVATION_ID)).toBe(
      `/roomreservations/${RESERVATION_ID}/cancel`,
    );
  });

  it('compose la liste des réservations du compte courant (Status + PageSize)', () => {
    expect(PMS_RESERVATION_ENDPOINTS.myReservations(1, 100)).toBe(
      '/roomreservations/my-reservations?Status=1&PageSize=100',
    );
  });

  /**
   * L'ancienne version de ce test énumérait les trois chemins nominaux et vérifiait qu'aucun ne
   * finit par `/confirm` — ce qu'aucun gabarit ne peut structurellement produire : il ne prouvait
   * rien. La vraie menace est un identifiant **hostile ou corrompu** (Redis, rejeu, balayeur)
   * interpolé tel quel. C'est cela qui est testé ici.
   */
  it.each([
    ['un suffixe /confirm', `${RESERVATION_ID}/confirm`],
    ['une traversée de chemin', '../reservations/x/confirm'],
    ['une query injectée', `${RESERVATION_ID}?x=1`],
    ['une chaîne vide', ''],
    ['un identifiant libre', 'r1'],
  ])(
    'refuse %s plutôt que de le concaténer dans un chemin PMS',
    (_label, hostile) => {
      expect(() => PMS_RESERVATION_ENDPOINTS.byId(hostile)).toThrow(/GUID/);
      expect(() => PMS_RESERVATION_ENDPOINTS.cancel(hostile)).toThrow(/GUID/);
      expect(() => PMS_RESERVATION_ENDPOINTS.create(hostile)).toThrow(/GUID/);
    },
  );

  it('reconnaît un GUID exploitable et rejette tout le reste', () => {
    expect(isPmsGuid(RESERVATION_ID)).toBe(true);
    expect(isPmsGuid(RESERVATION_ID.toUpperCase())).toBe(true);
    expect(isPmsGuid(`${RESERVATION_ID} `)).toBe(false);
    expect(isPmsGuid(undefined)).toBe(false);
    expect(isPmsGuid(42)).toBe(false);
  });
});
