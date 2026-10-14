import { resolvePmsCallBudgetMs } from '../booking/booking.constants';

/**
 * Paramètres du module `payment` — **bornés et documentés** (`.env.example`), patron
 * `resolveBookingOptions` : fonction pure testable, aucune lecture d'env dispersée.
 *
 * Story 3.2 (AC-3) : verrou single-flight de la confirmation `payment:confirm:v1:{reservationId}`.
 */
export const PAYMENT_OPTIONS = 'PAYMENT_OPTIONS';

export interface PaymentOptions {
  /**
   * Durée de vie du verrou de confirmation (ms).
   *
   * ⚠️ Doit dépasser le budget d'un appel PMS complet (`PMS_TIMEOUT_MS × (PMS_MAX_RETRIES + 1)` +
   * backoff) : un verrou qui expire pendant l'appel laisse partir une seconde confirmation
   * (leçon 2.1). Refus au boot en deçà.
   */
  confirmLockTtlMs: number;

  /**
   * Attente maximale (ms) du perdant (deuxième onglet) avant de relire la réservation. Au-delà, la
   * relecture décide : `Confirmed` → la même preuve ; sinon 503 rejouable.
   */
  confirmWaitTimeoutMs: number;

  /** Intervalle de scrutation du verrou par le perdant (ms). */
  confirmPollIntervalMs: number;
}

export function resolvePaymentOptions(
  env: NodeJS.ProcessEnv = process.env,
): PaymentOptions {
  const pmsCallBudgetMs = resolvePmsCallBudgetMs(env);
  // Défaut : le budget PMS plus une marge, jamais moins de 45 s.
  const confirmLockTtlMs = bounded(
    env.PAYMENT_CONFIRM_LOCK_MS,
    Math.max(45_000, pmsCallBudgetMs + 10_000),
    5_000,
    300_000,
  );

  if (confirmLockTtlMs <= pmsCallBudgetMs) {
    throw new Error(
      `PAYMENT_CONFIRM_LOCK_MS (${confirmLockTtlMs}) doit dépasser le budget d'un appel PMS complet (${pmsCallBudgetMs} ms) : le verrou expirerait pendant la confirmation.`,
    );
  }

  const confirmWaitTimeoutMs = bounded(
    env.PAYMENT_CONFIRM_WAIT_MS,
    30_000,
    1_000,
    120_000,
  );
  const confirmPollIntervalMs = bounded(
    env.PAYMENT_CONFIRM_POLL_MS,
    250,
    10,
    5_000,
  );

  if (confirmPollIntervalMs >= confirmWaitTimeoutMs) {
    throw new Error(
      `PAYMENT_CONFIRM_POLL_MS (${confirmPollIntervalMs}) doit être strictement inférieur à PAYMENT_CONFIRM_WAIT_MS (${confirmWaitTimeoutMs}).`,
    );
  }

  return { confirmLockTtlMs, confirmWaitTimeoutMs, confirmPollIntervalMs };
}

function bounded(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.trunc(Math.min(Math.max(n, min), max));
}
