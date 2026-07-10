import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';

/**
 * Filtre d'exceptions **global** du BFF (story 1.6). Normalise toute exception en une
 * enveloppe d'erreur `{ success:false, message, errors? }` — la même forme que le PMS et
 * que l'`api-client` du front (`ApiClientError(message, status, errors?)`).
 *
 * Mapping :
 * - `PmsUnavailableError` → **503** (dégradation gracieuse — jamais un faux « 0 résultat », NFR-10) ;
 * - `PmsRequestError`     → statut d'origine (4xx métier) + enveloppe préservée ;
 * - `HttpException`       → statut Nest (dont la validation → 400) ; les charges utiles
 *   structurées de `@nestjs/terminus` (`/health`) sont **laissées intactes** ;
 * - inconnu               → **500** générique (détail loggé, jamais exposé au client).
 */
export interface ErrorEnvelope {
  success: false;
  message: string;
  errors?: Record<string, string[]>;
}

type ResponseBody = ErrorEnvelope | Record<string, unknown>;

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.normalize(exception);

    // 5xx serveur : détail loggé (avec le correlation-id du contexte), jamais renvoyé au client.
    if (status >= 500) {
      this.logger.error(
        `${describe(body)} (status ${status})`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    body: ResponseBody;
  } {
    if (exception instanceof PmsUnavailableError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: { success: false, message: exception.message },
      };
    }
    if (exception instanceof PmsRequestError) {
      const errors = toFieldErrors(exception.errors);
      return {
        status: exception.status,
        body: errors
          ? { success: false, message: exception.message, errors }
          : { success: false, message: exception.message },
      };
    }
    if (exception instanceof HttpException) {
      const raw = exception.getResponse();
      // Charge utile @nestjs/terminus (`/health` : status/info/error/details) → laissée intacte.
      if (isHealthPayload(raw)) {
        return { status: exception.getStatus(), body: raw };
      }
      return {
        status: exception.getStatus(),
        body: fromHttpException(exception),
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { success: false, message: 'Erreur interne du serveur.' },
    };
  }
}

/** Détecte la forme d'un résultat de health-check terminus (à ne pas réécrire). */
function isHealthPayload(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.status === 'string' &&
    typeof record.details === 'object' &&
    record.details !== null
  );
}

/** Message court pour la journalisation des 5xx. */
function describe(body: ResponseBody): string {
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' ? message : 'Erreur serveur';
}

/** Normalise le champ `errors` d'une `PmsRequestError` (Record ou tableau) en `Record`. */
function toFieldErrors(
  errors: Record<string, string[]> | string[] | undefined,
): Record<string, string[]> | undefined {
  if (errors === undefined) {
    return undefined;
  }
  if (Array.isArray(errors)) {
    return errors.length > 0 ? { _: errors } : undefined;
  }
  return errors;
}

/** Extrait `{ message, errors? }` d'une `HttpException` (factory custom OU forme Nest par défaut). */
function fromHttpException(exception: HttpException): ErrorEnvelope {
  const res: unknown = exception.getResponse();
  if (typeof res === 'string') {
    return { success: false, message: res };
  }
  if (res !== null && typeof res === 'object') {
    const record = res as Record<string, unknown>;
    const message = extractMessage(record, exception.message);
    const errors = extractErrors(record);
    return errors
      ? { success: false, message, errors }
      : { success: false, message };
  }
  return { success: false, message: exception.message };
}

function extractMessage(
  record: Record<string, unknown>,
  fallback: string,
): string {
  const message = record.message;
  if (typeof message === 'string' && message.length > 0) {
    return message;
  }
  if (isStringArray(message) && message.length > 0) {
    return 'Requête invalide.';
  }
  return fallback;
}

function extractErrors(
  record: Record<string, unknown>,
): Record<string, string[]> | undefined {
  const errors = record.errors;
  if (errors !== null && typeof errors === 'object' && !Array.isArray(errors)) {
    return errors as Record<string, string[]>;
  }
  const message = record.message;
  if (isStringArray(message) && message.length > 0) {
    return { _: message };
  }
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
