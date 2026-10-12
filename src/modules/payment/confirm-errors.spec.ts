import {
  BadGatewayException,
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
  classifyConfirmFailure,
  CONFIRM_REASON_KEY,
  PMS_CONFIRMATION_ENDPOINTS,
  toConfirmException,
  type ConfirmFailureReason,
} from './confirm-errors';

/** Refus PMS tel que `ApiResponse.Fail` le sérialise : le motif vit dans `errors`, pas `message`. */
const refused = (status: number, text: string) =>
  new PmsRequestError(`Le PMS a renvoyé le statut ${status}.`, status, {
    errors: [text],
  });

/** 502 de la confirmation (#152), retries épuisés : le motif survit dans le corps du dernier 5xx. */
const gateway = (text: string) =>
  new PmsUnavailableError('Le PMS ne répond pas.', undefined, {
    status: 502,
    body: { success: false, errors: [text] },
  });

/**
 * Story 3.2 (B5) — classement des refus de confirmation.
 *
 * Les textes sont ceux des constantes `ReservationErrors` livrées par #152 : une reformulation côté
 * PMS ferait échouer ces tests, et c'est voulu.
 */
describe('classifyConfirmFailure', () => {
  it.each<
    [string, PmsRequestError | PmsUnavailableError, ConfirmFailureReason]
  >([
    [
      'paiement non autorisé (400)',
      refused(400, 'Reservation payment is not authorized'),
      'payment-not-authorized',
    ],
    [
      'montant divergent (400)',
      refused(400, 'Authorized amount does not match the amount due'),
      'amount-mismatch',
    ],
    [
      'capture échouée (502, après retries)',
      gateway('Payment capture failed'),
      'capture-failed',
    ],
    [
      'autorisation expirée (502, après retries)',
      gateway('Payment authorisation has expired'),
      'authorisation-expired',
    ],
    [
      'réservation introuvable (404)',
      refused(404, 'Reservation not found'),
      'reservation-not-found',
    ],
    [
      'réservation annulée (400)',
      refused(400, 'Cannot confirm a reservation in status Cancelled'),
      'reservation-cancelled',
    ],
    [
      'motif inconnu (400)',
      refused(400, 'Something else entirely'),
      'rejected',
    ],
    [
      'statut non confirmable autre qu’annulé (400)',
      refused(400, 'Cannot confirm a reservation in status NoShow'),
      'rejected',
    ],
  ])('%s', (_label, error, expected) => {
    expect(classifyConfirmFailure(error)).toBe(expected);
  });

  it('lit aussi le motif dans `message` et dans un dictionnaire d’erreurs', () => {
    const inMessage = new PmsRequestError(
      'Authorized amount does not match the amount due',
      400,
    );
    const inRecord = new PmsRequestError('x', 400, {
      errors: { reservation: ['Reservation payment is not authorized'] },
    });

    expect(classifyConfirmFailure(inMessage)).toBe('amount-mismatch');
    expect(classifyConfirmFailure(inRecord)).toBe('payment-not-authorized');
  });

  it('une panne réseau ou un 5xx sans motif reconnu reste une panne (null ⇒ 503)', () => {
    expect(classifyConfirmFailure(new PmsUnavailableError('down'))).toBeNull();
    expect(
      classifyConfirmFailure(
        new PmsUnavailableError('down', undefined, {
          status: 502,
          body: '<html>Bad Gateway</html>',
        }),
      ),
    ).toBeNull();
    expect(classifyConfirmFailure(refused(503, 'x'))).toBeNull();
    expect(classifyConfirmFailure(refused(429, 'x'))).toBeNull();
  });

  it('401/403 sur /confirm vise la CLÉ DE SERVICE, pas la session : panne, pas « reconnectez-vous »', () => {
    // Renvoyer le voyageur à l'identification ne corrigerait rien : c'est la configuration du BFF.
    expect(classifyConfirmFailure(refused(401, 'Invalid key'))).toBeNull();
    expect(classifyConfirmFailure(refused(403, 'Forbidden'))).toBeNull();
  });

  it('ne classe pas une erreur étrangère au PMS', () => {
    expect(classifyConfirmFailure(new Error('boom'))).toBeNull();
  });
});

describe('toConfirmException', () => {
  it.each<[ConfirmFailureReason, new (...args: never[]) => Error]>([
    ['payment-not-authorized', ConflictException],
    ['amount-mismatch', ConflictException],
    ['authorisation-expired', ConflictException],
    ['reservation-cancelled', ConflictException],
    ['capture-failed', BadGatewayException],
    ['reservation-not-found', NotFoundException],
    // Une réservation d'une autre session : 404, jamais un oracle d'existence (AC-2).
    ['not-owner', NotFoundException],
    ['session-invalid', UnauthorizedException],
    ['rejected', BadRequestException],
  ])('%s → %p', (reason, expected) => {
    const exception = toConfirmException(reason);
    const body = exception.getResponse() as {
      message: string;
      errors: Record<string, string[]>;
    };

    expect(exception).toBeInstanceOf(expected);
    expect(body.errors[CONFIRM_REASON_KEY]).toEqual([reason]);
    // Message BFF générique, jamais le texte du PMS.
    expect(body.message).not.toMatch(/Reservation|Payment|Authorized/);
  });
});

describe('PMS_CONFIRMATION_ENDPOINTS', () => {
  it('compose la route de confirmation reconnue par la frontière X-Service-Key', () => {
    expect(
      PMS_CONFIRMATION_ENDPOINTS.confirm(
        '33333333-3333-4333-8333-333333333333',
      ),
    ).toBe('/reservations/33333333-3333-4333-8333-333333333333/confirm');
  });

  it('refuse un identifiant qui n’est pas un GUID (chemin forgé)', () => {
    expect(() => PMS_CONFIRMATION_ENDPOINTS.confirm('../x')).toThrow();
  });
});
