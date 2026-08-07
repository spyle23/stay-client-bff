/**
 * Paramètres du module `booking` (tunnel de réservation) — **bornés et documentés**
 * (`.env.example`). Patron `resolveCatalogOptions` / `resolveAuthOptions` : fonction pure
 * testable, jamais de lecture d'env dispersée dans les services.
 *
 * Story 2.2 (FR-7) : durée maximale d'un devis.
 * Story 2.4 (FR-9 / FR-14 / AR-6) : hold de checkout, verrou de séjour, balayeur de libération.
 *
 * Le module n'a **pas** de cache de devis (Décision 2 de la story 2.2) : le devis délègue à
 * `CatalogService.getRoomDetail`, déjà caché et déjà protégé contre la mise en cache d'une
 * réponse dégradée. Deux caches produiraient deux vérités de prix.
 */

export interface BookingOptions {
  /**
   * Durée maximale d'un séjour (nuits). Au-delà, le devis est refusé (400) plutôt que de produire
   * un total aberrant — miroir de `CATALOG_MAX_STAY_NIGHTS`, qui écarte silencieusement le
   * contexte de dates côté `catalog`.
   */
  maxStayNights: number;

  /**
   * Durée du **Hold de checkout** (secondes) : le temps pendant lequel la chambre est tenue pour
   * un voyageur qui n'a pas encore payé (FR-14, ≈ 15–20 min au PRD ; Q13 non tranchée).
   *
   * Le PMS ne sait pas « tenir » une chambre : c'est la Réservation `Pending` elle-même qui
   * l'immobilise (`IsRoomAvailableAsync` n'exclut que `Cancelled`). Ce réglage est donc la durée
   * au bout de laquelle le **balayeur** annule une `Pending` restée sans paiement.
   */
  holdTtlSeconds: number;

  /**
   * Sursis (secondes) pendant lequel l'**enregistrement** de hold survit à son échéance.
   *
   * ⚠️ Vital : le balayeur a besoin du `sid` du propriétaire **après** l'expiration du hold pour
   * pouvoir annuler côté PMS (l'annulation exige le JWT du titulaire). Si l'enregistrement
   * expirait en même temps que le hold, le balayeur trouverait une entrée d'index sans données et
   * la chambre resterait gelée définitivement. Le sursis couvre aussi les tentatives de rattrapage.
   */
  holdRecordGraceSeconds: number;

  /**
   * TTL du verrou de **chambre** (ms) — sérialise les créations concurrentes sur une chambre.
   *
   * ⚠️ Doit couvrir le budget de la **section critique entière**, pas d'un seul appel : sous
   * verrou, `precheck` compose `CatalogService.getRoomDetail` (4 appels PMS, chacun retryé) *puis*
   * poste la création. Un verrou plus court expire **pendant** la création : une seconde requête
   * partirait et le PMS, dépourvu d'atomicité (D3), pourrait accepter deux réservations
   * chevauchantes. Budget d'un appel complet = `pmsCallBudgetMs` ; la section critique en vaut
   * plusieurs → défaut 90 s, plancher aligné sur `pmsCallBudgetMs` (refus au boot en deçà).
   */
  stayLockTtlMs: number;

  /** Attente maximale du perdant du verrou avant d'abandonner en 503 (ms). */
  lockWaitTimeoutMs: number;

  /** Intervalle de scrutation du verrou par le perdant (ms). */
  lockPollIntervalMs: number;

  /** Période du balayeur de holds échus (ms). */
  sweeperIntervalMs: number;

  /** Nombre maximal de holds traités par passe (borne la charge PMS d'une passe). */
  sweeperBatchSize: number;

  /**
   * Nombre de passes après lequel un hold impossible à libérer est abandonné (avec log `error`).
   * Sans plafond, une réservation dont la session a disparu serait retentée indéfiniment.
   */
  sweeperMaxAttempts: number;

  /** Report d'un hold dont la libération a échoué, avant nouvelle tentative (ms). */
  sweeperRetryDelayMs: number;

  /**
   * Active la planification du balayeur.
   *
   * Coupé sous `NODE_ENV=test` : les suites e2e bootent `AppModule` complet avec `nock`, et un
   * balayeur qui se déclenche en fond émettrait des appels PMS non interceptés, rendant les tests
   * intermittents. Les tests du balayeur appellent `sweep()` directement.
   */
  sweeperEnabled: boolean;

  /**
   * Budget (ms) d'**un** appel PMS complet, dérivé de la configuration du client
   * (`PMS_TIMEOUT_MS` × tentatives + backoff majoré). Correctif D1 / revue 2.4.
   *
   * Il n'est pas configurable directement : le dupliquer dans une variable propre au module
   * garantirait qu'un jour les deux divergent. Il sert de **référence commune** à trois réglages
   * qui, mal dimensionnés, cassent des invariants : le verrou de chambre (il doit survivre à la
   * section critique), le TTL du verrou de passe du balayeur, et le délai de réconciliation des
   * intentions de création.
   */
  pmsCallBudgetMs: number;

  /**
   * Délai (ms) avant qu'une **intention de création** non résolue soit réconciliée par le balayeur.
   *
   * ⚠️ Doit rester **confortablement supérieur** au budget PMS complet : réconcilier une requête
   * encore en vol ferait annuler par le balayeur une réservation que le voyageur est en train de
   * voir apparaître. Trop long, à l'inverse, laisse une `Pending` fantôme geler une vraie chambre
   * d'autant plus longtemps. Défaut 90 s, bornes 30 s–10 min, refus au boot si ≤ `pmsCallBudgetMs`.
   */
  intentReconcileDelayMs: number;

  /**
   * Durée de vie (secondes) de la **langue de communication** mémorisée pour une Réservation
   * (story 2.5, FR-10 ; revue 2ᵉ passe F7).
   *
   * ⚠️ Volontairement **découplée du hold**. La langue suit la *Réservation*, pas la tenue de
   * chambre : elle doit survivre à la libération du hold et rester lisible jusqu'à la confirmation
   * (story 3.2). Le plafond dur d'une `Pending` non payée est de **48 h** (dépendance D3, PRD
   * §9-D3) — c'est la borne qui fait sens ici, pas les 15 min du hold.
   *
   * Plancher aligné sur la durée de vie de l'enregistrement de hold : plus court la ferait
   * disparaître **avant** le hold, ce qui reproduirait exactement le défaut corrigé.
   */
  communicationLocaleTtlSeconds: number;
}

export const BOOKING_OPTIONS = 'BOOKING_OPTIONS';

export function resolveBookingOptions(
  env: NodeJS.ProcessEnv = process.env,
): BookingOptions {
  const lockWaitTimeoutMs = bounded(
    env.BOOKING_LOCK_WAIT_MS,
    5_000,
    100,
    60_000,
  );
  const lockPollIntervalMs = bounded(env.BOOKING_LOCK_POLL_MS, 100, 10, 2_000);

  // Bornés indépendamment, ces deux réglages peuvent se contredire (poll ≥ attente ⇒ une seule
  // lecture, budget dépassé d'un ordre de grandeur). On le refuse au boot plutôt qu'à l'exécution
  // (patron `resolveAuthOptions`).
  if (lockPollIntervalMs >= lockWaitTimeoutMs) {
    throw new Error(
      `BOOKING_LOCK_POLL_MS (${lockPollIntervalMs}) doit être strictement inférieur à BOOKING_LOCK_WAIT_MS (${lockWaitTimeoutMs}).`,
    );
  }

  const holdTtlSeconds = bounded(env.BOOKING_HOLD_TTL_SECONDS, 900, 300, 3_600);
  const holdRecordGraceSeconds = bounded(
    env.BOOKING_HOLD_GRACE_SECONDS,
    3_600,
    300,
    86_400,
  );
  const sweeperIntervalMs = bounded(
    env.BOOKING_SWEEPER_INTERVAL_MS,
    60_000,
    5_000,
    600_000,
  );

  // Un balayeur plus lent que le hold lui-même laisserait l'inventaire gelé bien au-delà de la
  // promesse faite au voyageur (« tenue jusqu'à … »). Refusé au boot.
  if (sweeperIntervalMs > holdTtlSeconds * 1000) {
    throw new Error(
      `BOOKING_SWEEPER_INTERVAL_MS (${sweeperIntervalMs}) ne peut pas dépasser la durée du hold (${holdTtlSeconds * 1000} ms).`,
    );
  }

  const sweeperRetryDelayMs = bounded(
    env.BOOKING_SWEEPER_RETRY_MS,
    60_000,
    1_000,
    3_600_000,
  );
  const recordTtlMs = (holdTtlSeconds + holdRecordGraceSeconds) * 1_000;

  // Un report plus long que la durée de vie de l'ENREGISTREMENT est un piège silencieux : à la
  // reprise, l'enregistrement a expiré, `read` renvoie `null` et le balayeur classe l'entrée en
  // « index orphelin » → `forget` **sans annulation ni log d'erreur**. La `Pending` reste, la
  // chambre reste gelée, et plus personne ne le sait. Refusé au boot (revue 2.4).
  if (sweeperRetryDelayMs > recordTtlMs) {
    throw new Error(
      `BOOKING_SWEEPER_RETRY_MS (${sweeperRetryDelayMs}) ne peut pas dépasser la durée de vie de l'enregistrement de hold (${recordTtlMs} ms = BOOKING_HOLD_TTL_SECONDS + BOOKING_HOLD_GRACE_SECONDS).`,
    );
  }

  const pmsCallBudgetMs = resolvePmsCallBudgetMs(env);
  const stayLockTtlMs = bounded(
    env.BOOKING_STAY_LOCK_MS,
    90_000,
    25_000,
    300_000,
  );

  // Le verrou est le SEUL rempart contre le double-booking (le PMS fait un check-then-insert non
  // sérialisé — dépendance D3). S'il expire avant la fin de la section critique, une seconde
  // requête part et deux `Pending` chevauchantes peuvent naître. Un plancher borné ne suffit pas :
  // avec un `PMS_TIMEOUT_MS` généreux, même le plafond du réglage passe sous le budget réel. On
  // refuse alors au boot plutôt que de faire tourner un verrou décoratif.
  if (stayLockTtlMs < pmsCallBudgetMs) {
    throw new Error(
      `BOOKING_STAY_LOCK_MS (${stayLockTtlMs}) est inférieur au budget d'un appel PMS complet (${pmsCallBudgetMs} ms = PMS_TIMEOUT_MS × (PMS_MAX_RETRIES + 1) + backoff) : le verrou expirerait pendant la création.`,
    );
  }

  const intentReconcileDelayMs = bounded(
    env.BOOKING_INTENT_RECONCILE_MS,
    90_000,
    30_000,
    600_000,
  );

  // Réconcilier une intention **avant** la fin du budget PMS reviendrait à annuler une réservation
  // dont la requête est encore en vol — exactement l'incident que la réconciliation doit éviter.
  if (intentReconcileDelayMs <= pmsCallBudgetMs) {
    throw new Error(
      `BOOKING_INTENT_RECONCILE_MS (${intentReconcileDelayMs}) doit être strictement supérieur au budget d'un appel PMS complet (${pmsCallBudgetMs} ms) : sinon le balayeur annulerait une création encore en vol.`,
    );
  }

  const communicationLocaleTtlSeconds = bounded(
    env.BOOKING_COMM_LOCALE_TTL_SECONDS,
    172_800, // 48 h — plafond dur d'une `Pending` non payée (D3)
    recordTtlMs / 1000,
    604_800, // 7 j
  );

  return {
    maxStayNights: bounded(env.BOOKING_MAX_STAY_NIGHTS, 90, 1, 365),
    communicationLocaleTtlSeconds,
    holdTtlSeconds,
    holdRecordGraceSeconds,
    stayLockTtlMs,
    lockWaitTimeoutMs,
    lockPollIntervalMs,
    sweeperIntervalMs,
    sweeperBatchSize: bounded(env.BOOKING_SWEEPER_BATCH, 50, 1, 500),
    sweeperMaxAttempts: bounded(env.BOOKING_SWEEPER_MAX_ATTEMPTS, 5, 1, 50),
    sweeperRetryDelayMs,
    sweeperEnabled: resolveSweeperEnabled(env),
    pmsCallBudgetMs,
    intentReconcileDelayMs,
  };
}

/**
 * Budget (ms) d'un appel PMS complet, **dérivé** de la configuration du client PMS.
 *
 * `PmsClientService` applique `PMS_TIMEOUT_MS` **par tentative**, retente `PMS_MAX_RETRIES` fois et
 * patiente entre deux tentatives d'un backoff exponentiel avec gigue (`base·2^(n-1) + [0, base)`).
 * Le majorant est donc `timeout × (retries + 1) + base·(2^retries − 1) + base·retries` — soit
 * ≈ 25 s avec les défauts (8 s × 3 + 750 ms), valeur citée dans toute la documentation du module.
 */
function resolvePmsCallBudgetMs(env: NodeJS.ProcessEnv): number {
  // Mêmes règles de lecture que `resolvePmsClientOptions` : un timeout ≤ 0 est traité par axios
  // comme « aucun timeout » et retombe donc sur le défaut, pas sur un plancher arbitraire.
  const timeoutMs = positive(env.PMS_TIMEOUT_MS, 8_000);
  const maxRetries = bounded(env.PMS_MAX_RETRIES, 2, 0, 10);
  const retryBaseMs = positive(env.PMS_RETRY_BASE_DELAY_MS, 150);
  const backoffMs =
    retryBaseMs * (Math.pow(2, maxRetries) - 1) + retryBaseMs * maxRetries;
  return Math.ceil(timeoutMs * (maxRetries + 1) + backoffMs);
}

/**
 * Interrupteur du balayeur, **normalisé** (même discipline que `resolveTrustProxy`).
 *
 * ⚠️ Ce drapeau commande un composant qui **annule de vraies réservations**. Une comparaison
 * stricte à la chaîne `'false'` faisait *activer* le balayeur sur `0`, `no`, `off` ou `FALSE` —
 * l'exact inverse de l'intention de l'exploitant. Toute forme reconnue de « non » coupe.
 */
function resolveSweeperEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.BOOKING_SWEEPER_ENABLED ?? '').trim().toLowerCase();
  if (raw === '') {
    return env.NODE_ENV !== 'test';
  }
  return !['false', '0', 'no', 'off', 'n'].includes(raw);
}

/** Nombre strictement positif, sinon `fallback` (couvre `undefined`, vide, `NaN`, ≤ 0). */
function positive(raw: string | undefined, fallback: number): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Entier borné dans `[min, max]`, sinon `fallback` si non parsable.
 *
 * ⚠️ La **normalisation en entier** est essentielle : une valeur fractionnaire passe `Number()`,
 * franchit les bornes, puis casse plus bas (arithmétique de nuits, expiration Redis rejetée par
 * `EXPIRE`). Borner sans normaliser est une validation en trompe-l'œil (cf. `catalog.constants.ts`).
 */
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
