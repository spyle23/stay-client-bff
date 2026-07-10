import {
  type ArgumentsHost,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import {
  AllExceptionsFilter,
  type ErrorEnvelope,
} from './all-exceptions.filter';

function run(
  filter: AllExceptionsFilter,
  exception: unknown,
): { statusCode: number; body: ErrorEnvelope } {
  let statusCode = 0;
  let body: ErrorEnvelope = { success: false, message: '' };
  const json = jest.fn((payload: ErrorEnvelope) => {
    body = payload;
  });
  const status = jest.fn((code: number) => {
    statusCode = code;
    return { json };
  });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;

  filter.catch(exception, host);
  return { statusCode, body };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('mappe PmsUnavailableError → 503 (dégradation gracieuse)', () => {
    const { statusCode, body } = run(
      filter,
      new PmsUnavailableError('PMS indisponible.'),
    );
    expect(statusCode).toBe(503);
    expect(body.success).toBe(false);
    expect(body.message).toBe('PMS indisponible.');
  });

  it("mappe PmsRequestError → statut d'origine + enveloppe préservée", () => {
    const { statusCode, body } = run(
      filter,
      new PmsRequestError('Conflit métier.', 409, {
        errors: { room: ['déjà réservée'] },
      }),
    );
    expect(statusCode).toBe(409);
    expect(body.message).toBe('Conflit métier.');
    expect(body.errors).toEqual({ room: ['déjà réservée'] });
  });

  it('mappe la validation (BadRequestException) → 400 avec errors par champ', () => {
    const { statusCode, body } = run(
      filter,
      new BadRequestException({
        message: 'Requête invalide.',
        errors: { guests: ['guests doit être ≥ 1'] },
      }),
    );
    expect(statusCode).toBe(400);
    expect(body.message).toBe('Requête invalide.');
    expect(body.errors).toEqual({ guests: ['guests doit être ≥ 1'] });
  });

  it('mappe une HttpException Nest standard (message[]) → 400 générique + errors._', () => {
    const { statusCode, body } = run(
      filter,
      new BadRequestException(['champ manquant']),
    );
    expect(statusCode).toBe(400);
    expect(body.errors).toEqual({ _: ['champ manquant'] });
  });

  it('mappe NotFoundException → 404', () => {
    const { statusCode, body } = run(
      filter,
      new NotFoundException('introuvable'),
    );
    expect(statusCode).toBe(404);
    expect(body.message).toBe('introuvable');
  });

  it('mappe une erreur inconnue → 500 générique (jamais le détail interne)', () => {
    const { statusCode, body } = run(filter, new Error('secret interne'));
    expect(statusCode).toBe(500);
    expect(body.message).toBe('Erreur interne du serveur.');
    expect(body.message).not.toContain('secret');
  });
});
