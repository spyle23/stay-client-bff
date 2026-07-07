import { Module } from '@nestjs/common';
import {
  PMS_CLIENT_OPTIONS,
  type PmsClientOptions,
  PmsClientService,
} from './pms-client.service';
import { SERVICE_KEY_TOKEN, ServiceKeyProvider } from './service-key.provider';

/**
 * Résout les options du client PMS depuis un environnement, avec **bornes de sûreté** :
 * une mauvaise config ne doit jamais désactiver silencieusement le client (ex. `timeout=0`
 * = pas de timeout → hang ; `maxRetries<0` = aucun appel HTTP). Fonction pure → testable.
 */
export function resolvePmsClientOptions(
  env: NodeJS.ProcessEnv = process.env,
): PmsClientOptions {
  return {
    baseUrl: env.PMS_BASE_URL ?? 'http://localhost:5231/api/v1',
    // Un timeout ≤ 0 est traité par axios comme « aucun timeout » → on retombe sur le défaut.
    timeoutMs: positiveNumber(env.PMS_TIMEOUT_MS, 8000),
    // maxRetries : 0 valide (1 essai) ; négatif borné à 0 ; plafonné pour éviter l'emballement.
    maxRetries: boundedNumber(env.PMS_MAX_RETRIES, 2, 0, 10),
    retryBaseDelayMs: positiveNumber(env.PMS_RETRY_BASE_DELAY_MS, 150),
    breaker: {
      errorThresholdPercentage: boundedNumber(
        env.PMS_BREAKER_ERROR_THRESHOLD,
        50,
        1,
        100,
      ),
      resetTimeoutMs: positiveNumber(env.PMS_BREAKER_RESET_MS, 10000),
      volumeThreshold: boundedNumber(env.PMS_BREAKER_VOLUME, 5, 1, 100000),
    },
  };
}

/** Nombre strictement positif, sinon `fallback` (couvre `undefined`, vide, `NaN`, ≤ 0). */
function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Nombre borné dans `[min, max]`, sinon `fallback` si non parsable. */
function boundedNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(Math.max(n, min), max);
}

/**
 * Frontière PMS (FR-21). Fournit le client HTTP résilient et le détenteur de la clé de service,
 * importables par les modules de domaine (search/catalog/booking/payment/account…).
 */
@Module({
  providers: [
    {
      provide: PMS_CLIENT_OPTIONS,
      useFactory: () => resolvePmsClientOptions(),
    },
    {
      provide: SERVICE_KEY_TOKEN,
      useFactory: () => process.env.SERVICE_KEY ?? '',
    },
    PmsClientService,
    ServiceKeyProvider,
  ],
  exports: [PmsClientService, ServiceKeyProvider],
})
export class PmsModule {}
