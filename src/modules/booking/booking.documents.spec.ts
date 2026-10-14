import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { RequestSession } from '../../common/decorators/current-session.decorator';
import type { PmsClientService } from '../../integration/pms/pms-client.service';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import type { SessionService } from '../auth/session.service';
import type { CatalogService } from '../catalog/catalog.service';
import type { BookingOptions } from './booking.constants';
import { BookingService } from './booking.service';
import type { CheckoutHoldService } from './checkout-hold.service';

const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const session = { sid: 'sid-1' } as RequestSession;

/**
 * Story 3.2 (B6) — documents de confirmation relayés au navigateur.
 *
 * Le front (:3001) et le BFF (:4000) sont d'origines différentes : le navigateur lit ces octets par
 * `fetch` + cookie de session, le BFF les obtient du PMS sous le JWT `Customer` en custody.
 */
describe('BookingService.getConfirmationDocument', () => {
  let getBinary: jest.Mock;
  let get: jest.Mock;
  let tokens: string[];
  let service: BookingService;

  beforeEach(() => {
    tokens = [];
    getBinary = jest.fn((path: string) =>
      Promise.resolve(
        path.endsWith('/confirmation-pdf')
          ? { data: PDF, contentType: 'application/pdf' }
          : { data: PNG, contentType: 'image/png' },
      ),
    );
    get = jest.fn().mockResolvedValue({
      success: true,
      data: { id: RESERVATION_ID, reservationCode: 'RES-20260901-A1B2C' },
    });
    service = new BookingService(
      {} as unknown as CatalogService,
      { getBinary, get } as unknown as PmsClientService,
      {
        withCustomerAuth: (
          _sid: string,
          fn: (token: string) => Promise<unknown>,
        ) => {
          tokens.push('jeton-customer');
          return fn('jeton-customer');
        },
      } as unknown as SessionService,
      {} as unknown as CheckoutHoldService,
      { getCorrelationId: () => 'corr-1' },
      {} as BookingOptions,
    );
  });

  it('QR : relaie les octets intacts sous le JWT du voyageur', async () => {
    const doc = await service.getConfirmationDocument(
      session,
      RESERVATION_ID,
      'qr',
    );

    expect(getBinary).toHaveBeenCalledWith(
      `/roomreservations/${RESERVATION_ID}/confirmation-qr`,
      expect.objectContaining({
        bearerToken: 'jeton-customer',
        correlationId: 'corr-1',
      }),
    );
    expect(doc.data.equals(PNG)).toBe(true);
    expect(doc.contentType).toBe('image/png');
    expect(doc.fileName).toBeNull();
  });

  it('PDF : nom de fichier RECONSTRUIT depuis le code de réservation relu', async () => {
    const doc = await service.getConfirmationDocument(
      session,
      RESERVATION_ID,
      'pdf',
    );

    expect(doc.data.equals(PDF)).toBe(true);
    expect(doc.contentType).toBe('application/pdf');
    expect(doc.fileName).toBe('RES-20260901-A1B2C.pdf');
  });

  it('PDF : code illisible ou relecture impossible → nom générique, jamais une valeur amont', async () => {
    get.mockResolvedValueOnce({
      success: true,
      data: { reservationCode: '../evil"\r\nSet-Cookie: x' },
    });
    const forged = await service.getConfirmationDocument(
      session,
      RESERVATION_ID,
      'pdf',
    );
    get.mockRejectedValueOnce(new PmsUnavailableError('down'));
    const unreadable = await service.getConfirmationDocument(
      session,
      RESERVATION_ID,
      'pdf',
    );

    expect(forged.fileName).toBe('reservation.pdf');
    expect(unreadable.fileName).toBe('reservation.pdf');
  });

  it('404 du PMS → 404, jamais un « document corrompu »', async () => {
    getBinary.mockRejectedValueOnce(
      new PmsRequestError('x', 404, { errors: ['Reservation not found'] }),
    );

    await expect(
      service.getConfirmationDocument(session, RESERVATION_ID, 'qr'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('403 du PMS → 404 : la réservation d’un autre compte est indiscernable d’une absente', async () => {
    getBinary.mockRejectedValueOnce(new PmsRequestError('x', 403));

    await expect(
      service.getConfirmationDocument(session, RESERVATION_ID, 'pdf'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('le texte du PMS ne sort jamais du BFF', async () => {
    getBinary.mockRejectedValueOnce(
      new PmsRequestError('Reservation not found', 404, {
        errors: ['Reservation not found'],
      }),
    );

    const err = (await service
      .getConfirmationDocument(session, RESERVATION_ID, 'qr')
      .catch((e: unknown) => e)) as NotFoundException;

    expect(JSON.stringify(err.getResponse())).not.toContain(
      'Reservation not found',
    );
  });

  it('type amont inattendu (JSON au lieu d’un PNG) → 503, jamais relayé', async () => {
    getBinary.mockResolvedValueOnce({
      data: Buffer.from('<html>'),
      contentType: 'text/html',
    });

    await expect(
      service.getConfirmationDocument(session, RESERVATION_ID, 'qr'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('panne PMS → propagée (503 par le filtre global)', async () => {
    getBinary.mockRejectedValueOnce(new PmsUnavailableError('down'));

    await expect(
      service.getConfirmationDocument(session, RESERVATION_ID, 'qr'),
    ).rejects.toBeInstanceOf(PmsUnavailableError);
  });
});
