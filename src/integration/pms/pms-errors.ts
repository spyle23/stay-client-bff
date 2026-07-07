/**
 * Erreurs typées de la frontière PMS (FR-21 / AR-7 / NFR-10).
 *
 * Deux catégories distinctes, traitées différemment par la résilience :
 * - `PmsRequestError`   : réponse **4xx métier** du PMS. NON retryée, ne fait **pas** ouvrir le
 *   circuit breaker ; porte le statut + l'enveloppe d'erreur pour mapping par les modules.
 * - `PmsUnavailableError` : **dégradation gracieuse**. Panne réseau, timeout, 5xx après retries,
 *   ou circuit ouvert. Le BFF ne crashe jamais : il remonte cette erreur typée.
 */

export class PmsRequestError extends Error {
  readonly status: number;
  readonly errors?: Record<string, string[]> | string[];
  readonly responseBody?: unknown;

  constructor(
    message: string,
    status: number,
    options?: {
      errors?: Record<string, string[]> | string[];
      responseBody?: unknown;
    },
  ) {
    super(message);
    this.name = 'PmsRequestError';
    this.status = status;
    this.errors = options?.errors;
    this.responseBody = options?.responseBody;
  }
}

export class PmsUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    // Chaîne l'erreur d'origine via le `cause` natif (Error.cause) plutôt que de le shadow.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'PmsUnavailableError';
  }
}
