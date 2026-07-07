import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { correlationStorage } from './correlation.context';

/** En-tête de corrélation (lu en entrée, réémis en sortie). */
export const CORRELATION_ID_HEADER = 'X-Correlation-ID';

/**
 * Format accepté pour un corrélation-id **entrant** (non fiable) : charset sûr, borné.
 * Rejette les caractères de contrôle (`\r\n` → `setHeader` lèverait 500), les valeurs jointes
 * (`"a, b"`), et les valeurs trop longues — on régénère alors un id propre.
 */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Middleware d'entrée du BFF : lit un `X-Correlation-ID` fourni, sinon en génère un ;
 * le réémet en réponse et ouvre le contexte `AsyncLocalStorage` pour toute la requête
 * (logs + appels sortants). Appliqué **en premier** (`app.use` dans `main.ts`) afin
 * d'englober la journalisation `pino` et les handlers.
 */
export function correlationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers['x-correlation-id'];
  // Ne réutiliser l'id fourni que s'il est sûr (charset/longueur) ; sinon en générer un propre.
  const correlationId =
    typeof incoming === 'string' && SAFE_CORRELATION_ID.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  correlationStorage.run({ correlationId }, () => next());
}
