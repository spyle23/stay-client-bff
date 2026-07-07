import { AsyncLocalStorage } from 'node:async_hooks';

interface CorrelationStore {
  correlationId: string;
}

/**
 * Contexte de corrélation par requête, porté par `AsyncLocalStorage` (zéro dépendance).
 * Alimenté par `correlationMiddleware` (à l'entrée du BFF) et lu par les logs `pino`
 * (`customProps`) ainsi que par les appels sortants vers le PMS (propagation NFR-11).
 */
export const correlationStorage = new AsyncLocalStorage<CorrelationStore>();

/** Corrélation-id de la requête courante, ou `undefined` hors contexte de requête. */
export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
