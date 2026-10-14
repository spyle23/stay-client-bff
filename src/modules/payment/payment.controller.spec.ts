import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { Response } from 'express';
import type { RequestSession } from '../../common/decorators/current-session.decorator';
import type { ConfirmationProofDto } from './dto/confirmation-proof.dto';
import { PaymentController } from './payment.controller';
import type { PaymentService } from './payment.service';

const SESSION = { sid: 'sid-1' } as RequestSession;
const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';

/** Story 3.2 (B2) — route de confirmation. */
describe('PaymentController.confirm', () => {
  it('réexpose la preuve dans l’enveloppe ApiResponse, sans cache partagé', async () => {
    const proof = { reservationId: RESERVATION_ID } as ConfirmationProofDto;
    const confirm = jest.fn().mockResolvedValue(proof);
    const controller = new PaymentController({
      confirm,
    } as unknown as PaymentService);
    const headers = new Map<string, string>();
    const res = {
      setHeader: (name: string, value: string) => headers.set(name, value),
    };

    const response = await controller.confirm(
      SESSION,
      RESERVATION_ID,
      res as unknown as Response,
    );

    expect(confirm).toHaveBeenCalledWith(SESSION, RESERVATION_ID);
    expect(response).toEqual({ success: true, data: proof });
    expect(headers.get('Cache-Control')).toBe('no-store, private');
    expect(headers.get('Vary')).toBe('Cookie');
  });

  it('répond 200 et jamais 201 : le BFF ignore si le PMS vient de confirmer ou rejoue', () => {
    const handler = Object.getOwnPropertyDescriptor(
      PaymentController.prototype,
      'confirm',
    )?.value as object;

    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
      HttpStatus.OK,
    );
  });
});
