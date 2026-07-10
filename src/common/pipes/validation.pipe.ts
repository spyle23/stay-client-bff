import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

/**
 * `ValidationPipe` global du BFF (story 1.6 — 1ʳᵉ route métier).
 *
 * `whitelist` + `forbidNonWhitelisted` : rejette tout champ non déclaré dans le DTO.
 * `transform` : convertit les query-params (`@Type(() => Number)`) et instancie le DTO.
 * `exceptionFactory` : produit une enveloppe d'erreur `{ message, errors }` **stable**,
 * dont la forme est reprise par `AllExceptionsFilter` puis lue par l'`api-client` du front.
 */
export function buildValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) =>
      new BadRequestException({
        message: 'Requête invalide.',
        errors: toFieldErrors(errors),
      }),
  });
}

/** Aplati les erreurs class-validator en `Record<champ, messages[]>`. */
function toFieldErrors(errors: ValidationError[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const err of errors) {
    out[err.property] = Object.values(err.constraints ?? {});
  }
  return out;
}
