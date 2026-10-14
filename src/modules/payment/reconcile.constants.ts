import { resolvePmsCallBudgetMs } from '../booking/booking.constants';

/**
 * Paramètres de la **réconciliation paiement → confirmation** (#5, story 3.4, AC-8).
 *
 * Patron `resolveBookingOptions` / `resolvePaymentOptions` (fonction pure testable), à une
 * différence près, voulue par l'AC-8 : une valeur **hors bornes refuse le démarrage** au lieu d'être
 * ramenée dans l'intervalle. Ce job est le filet d'intégrité « payé ⇒ confirmé » : une configuration
 * fausse doit se voir au boot, pas des jours plus tard sous la forme d'un voyageur débité sans
 * confirmation.
 */
export const RECONCILE_OPTIONS = 'PAYMENT_RECONCILE_OPTIONS';

export interface ReconcileOptions {
  /** Planification du job (coupée sous `NODE_ENV=test`, comme le balayeur). */
  enabled: boolean;
  /** Période d'une passe (ms). Sert aussi de délai de grâce avant la 1ʳᵉ passe d'un candidat. */
  intervalMs: number;
  /** Nombre maximal de candidats traités par passe (borne la charge PMS et Stripe). */
  batchSize: number;
  /** Âge (s) au-delà duquel un paiement engagé non confirmé déclenche `integrity.alert`. */
  alertAfterSeconds: number;
  /** Fenêtre (s) de réémission d'une alerte, par réservation. */
  alertRepeatSeconds: number;
  /** Âge (s) au-delà duquel un candidat sort de l'index (8 j : au-delà d'une autorisation carte). */
  maxAgeSeconds: number;
  /**
   * Budget (ms) d'un appel PMS complet, **dérivé** de la configuration du client PMS (jamais
   * configurable à part) : dimensionne le verrou de passe et son échéance.
   */
  pmsCallBudgetMs: number;
}

export function resolveReconcileOptions(
  env: NodeJS.ProcessEnv = process.env,
): ReconcileOptions {
  const intervalMs = strictInteger(
    env,
    'PAYMENT_RECONCILE_INTERVAL_MS',
    60_000,
    10_000,
    600_000,
  );
  const batchSize = strictInteger(env, 'PAYMENT_RECONCILE_BATCH', 50, 1, 500);
  const alertAfterSeconds = strictInteger(
    env,
    'PAYMENT_RECONCILE_ALERT_AFTER_SECONDS',
    900,
    60,
    604_800,
  );
  const alertRepeatSeconds = strictInteger(
    env,
    'PAYMENT_RECONCILE_ALERT_REPEAT_SECONDS',
    3_600,
    60,
    604_800,
  );
  const maxAgeSeconds = strictInteger(
    env,
    'PAYMENT_RECONCILE_MAX_AGE_SECONDS',
    691_200,
    3_600,
    2_592_000,
  );

  // Une alerte qui ne peut partir qu'après la sortie de l'index ne partirait jamais : le filet
  // abandonnerait en silence un voyageur débité.
  if (alertAfterSeconds >= maxAgeSeconds) {
    throw new Error(
      `PAYMENT_RECONCILE_ALERT_AFTER_SECONDS (${alertAfterSeconds}) doit être strictement inférieur à PAYMENT_RECONCILE_MAX_AGE_SECONDS (${maxAgeSeconds}).`,
    );
  }

  return {
    enabled: resolveEnabled(env),
    intervalMs,
    batchSize,
    alertAfterSeconds,
    alertRepeatSeconds,
    maxAgeSeconds,
    pmsCallBudgetMs: resolvePmsCallBudgetMs(env),
  };
}

const NO = ['false', '0', 'no', 'off', 'n'];
const YES = ['true', '1', 'yes', 'on', 'y'];

/**
 * Interrupteur normalisé (discipline de `BOOKING_SWEEPER_ENABLED`). Vide : actif, sauf sous
 * `NODE_ENV=test` (les suites e2e bootent `AppModule` avec `nock`, un job en fond y émettrait des
 * appels PMS non interceptés). Une valeur illisible refuse le démarrage : couper ce filet par une
 * faute de frappe serait silencieux.
 */
function resolveEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.PAYMENT_RECONCILE_ENABLED ?? '').trim().toLowerCase();
  if (raw === '') {
    return env.NODE_ENV !== 'test';
  }
  if (NO.includes(raw)) {
    return false;
  }
  if (YES.includes(raw)) {
    return true;
  }
  throw new Error(
    `PAYMENT_RECONCILE_ENABLED invalide (« ${raw} ») : attendu true|false (ou 1|0, yes|no, on|off).`,
  );
}

/** Entier dans `[min, max]` ; vide → défaut ; illisible, fractionnaire ou hors bornes → refus au boot. */
function strictInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(
      `${name} invalide (« ${raw.trim()} ») : entier attendu entre ${min} et ${max}.`,
    );
  }
  return n;
}
