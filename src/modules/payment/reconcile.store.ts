import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { COMPARE_AND_DELETE_SCRIPT } from '../booking/checkout-hold.service';
import {
  RECONCILE_OPTIONS,
  type ReconcileOptions,
} from './reconcile.constants';

/**
 * Magasin Redis de la **réconciliation paiement → confirmation** (#5, AC-1).
 *
 * Quatre structures, **indépendantes de la session et du hold** (une session détruite ou un hold
 * oublié ne doivent jamais faire perdre un paiement engagé) :
 * - `payment:reconciles:v1` — index trié des candidats, **score = instant d'émission** de l'intent ;
 * - `payment:reconcile-due:v1` — échéancier **prioritaire**, score = prochaine tentative (grâce,
 *   backoff) : candidats jamais lus, ou dont la dernière lecture montrait de l'argent engagé ;
 * - `payment:reconcile-idle-due:v1` — échéancier des **paiements abandonnés** (#185) : `Pending`
 *   sans argent engagé à la dernière lecture (`idleRounds > 0`), servis après les prioritaires ;
 * - `payment:reconcile:v1:{id}` — état de suivi, sans aucune donnée personnelle ni secret.
 *
 * Un candidat indexé a **une** échéance, dans l'un **ou** l'autre échéancier : les scripts qui en
 * posent une retirent le membre de l'autre.
 *
 * L'**appartenance à l'index fait foi** : un candidat retiré (confirmé par le navigateur pendant une
 * passe, par exemple) ne peut pas être ressuscité par la mise à jour concurrente de cette passe. Les
 * transitions passent toutes par des scripts Lua (un seul pas Redis, aucun état intermédiaire).
 */

export const RECONCILE_INDEX_KEY = 'payment:reconciles:v1';
export const RECONCILE_DUE_KEY = 'payment:reconcile-due:v1';
export const RECONCILE_IDLE_DUE_KEY = 'payment:reconcile-idle-due:v1';
export const RECONCILE_KEY_PREFIX = 'payment:reconcile:v1:';
export const RECONCILE_LOCK_KEY = 'payment:reconcile:lock:v1';

/** Marge (s) de l'enregistrement au-delà de l'âge maximal : il survit à sa propre purge. */
const RECORD_TTL_MARGIN_SECONDS = 86_400;

/** Refus déterministe mémorisé : la confirmation n'est plus rejouée (AC-5). */
export type DeterministicRefusal =
  'amount-mismatch' | 'payment-not-authorized' | 'rejected';

/** État de suivi d'un candidat. Aucune donnée personnelle, aucun jeton, aucun secret. */
export interface ReconcileRecord {
  reservationId: string;
  /** Instant d'émission de l'intent (ms epoch), identique au score d'index. */
  issuedAt: number;
  /** Appels de confirmation émis par la réconciliation. */
  attempts: number;
  /** Échecs transitoires consécutifs (backoff). */
  failures: number;
  /** Identifiant de la ligne `Payment` du PMS, dès qu'il est connu. */
  paymentId: string | null;
  /** Dernier `intentStatus` lu chez Stripe (via le PMS). */
  lastIntentStatus: string | null;
  /** Refus déterministe reçu : plus aucun rejeu de la confirmation. */
  refusal: DeterministicRefusal | null;
  /** Dernière émission de `integrity.alert` (ms epoch). */
  lastAlertAt: number | null;
  /**
   * Lectures consécutives d'un `Pending` **sans argent engagé** (paiement abandonné, #185) : règle
   * l'espacement des relectures et range le candidat dans l'échéancier des abandons. Remis à 0 dès
   * qu'une lecture montre de l'argent engagé. Absent d'un état écrit avant #185 : vaut 0.
   */
  idleRounds?: number;
}

/**
 * Inscrit le candidat s'il est absent ; sinon répare seulement l'index, scores conservés.
 *
 * Exception (#185) : une réémission d'intent pour un candidat rangé parmi les abandons (le voyageur
 * revient payer) le replace dans l'échéancier prioritaire, relu après le délai de grâce.
 */
export const ENROLL_SCRIPT = `if redis.call('exists', KEYS[1]) == 1 then
  redis.call('zadd', KEYS[2], 'NX', ARGV[3], ARGV[5])
  if redis.call('zrem', KEYS[4], ARGV[5]) == 1 then
    redis.call('zadd', KEYS[3], ARGV[4], ARGV[5])
  else
    redis.call('zadd', KEYS[3], 'NX', ARGV[4], ARGV[5])
  end
  return 0
end
redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('zadd', KEYS[2], ARGV[3], ARGV[5])
redis.call('zrem', KEYS[4], ARGV[5])
redis.call('zadd', KEYS[3], ARGV[4], ARGV[5])
return 1`;

/**
 * Réécrit l'état et la prochaine échéance **si et seulement si** le candidat est encore indexé.
 * `ARGV[5]` = `'1'` : échéance posée dans l'échéancier des abandons (KEYS[4]), sinon dans
 * l'échéancier prioritaire (KEYS[3]) ; le membre est retiré de l'autre.
 */
export const UPDATE_SCRIPT = `if not redis.call('zscore', KEYS[2], ARGV[4]) then
  redis.call('zrem', KEYS[3], ARGV[4])
  redis.call('zrem', KEYS[4], ARGV[4])
  return 0
end
redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2])
if ARGV[5] == '1' then
  redis.call('zrem', KEYS[3], ARGV[4])
  redis.call('zadd', KEYS[4], ARGV[3], ARGV[4])
else
  redis.call('zrem', KEYS[4], ARGV[4])
  redis.call('zadd', KEYS[3], ARGV[3], ARGV[4])
end
return 1`;

/** Retire un candidat : état, index et échéanciers. */
export const REMOVE_SCRIPT = `redis.call('del', KEYS[1])
redis.call('zrem', KEYS[2], ARGV[1])
redis.call('zrem', KEYS[3], ARGV[1])
redis.call('zrem', KEYS[4], ARGV[1])
return 1`;

/** Lecture d'un candidat : état éventuel et score d'index (`null` : plus candidat). */
export interface ReconcileEntry {
  record: ReconcileRecord | null;
  issuedAt: number | null;
}

@Injectable()
export class PaymentReconcileStore {
  private readonly logger = new Logger(PaymentReconcileStore.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(RECONCILE_OPTIONS) private readonly options: ReconcileOptions,
  ) {}

  /** Durée de vie de l'état (s) : l'âge maximal plus une marge. */
  get recordTtlSeconds(): number {
    return this.options.maxAgeSeconds + RECORD_TTL_MARGIN_SECONDS;
  }

  /**
   * Inscrit la réservation à l'émission de l'intent (AC-1). Idempotent : une réémission garde
   * l'instant de la première (l'âge d'alerte et l'âge maximal comptent depuis elle).
   *
   * Première tentative après un délai de grâce d'un intervalle : le navigateur confirme d'abord
   * lui-même (#3) ; la réconciliation n'est que le filet.
   *
   * Panne Redis → 503 : l'appelant ne rend pas le `clientSecret`, faute de filet.
   */
  async enroll(reservationId: string, issuedAt: number): Promise<void> {
    const record: ReconcileRecord = {
      reservationId,
      issuedAt,
      attempts: 0,
      failures: 0,
      paymentId: null,
      lastIntentStatus: null,
      refusal: null,
      lastAlertAt: null,
      idleRounds: 0,
    };
    await this.guard(() =>
      this.redis.raw.eval(
        ENROLL_SCRIPT,
        4,
        RECONCILE_KEY_PREFIX + reservationId,
        RECONCILE_INDEX_KEY,
        RECONCILE_DUE_KEY,
        RECONCILE_IDLE_DUE_KEY,
        JSON.stringify(record),
        this.recordTtlSeconds,
        issuedAt,
        issuedAt + this.options.intervalMs,
        reservationId,
      ),
    );
  }

  /** Lit l'état et le score d'index d'un candidat. Un état illisible est traité comme absent. */
  async read(reservationId: string): Promise<ReconcileEntry> {
    const [raw, score] = await Promise.all([
      this.redis.get(RECONCILE_KEY_PREFIX + reservationId),
      this.redis.raw.zscore(RECONCILE_INDEX_KEY, reservationId),
    ]);
    let record: ReconcileRecord | null = null;
    if (raw) {
      try {
        record = JSON.parse(raw) as ReconcileRecord;
      } catch {
        this.logger.warn(
          `État de réconciliation illisible (réservation ${reservationId}) — reconstitué.`,
        );
      }
    }
    const issuedAt = score === null ? null : Number(score);
    return {
      record,
      issuedAt:
        issuedAt !== null && Number.isFinite(issuedAt) ? issuedAt : null,
    };
  }

  /**
   * Réécrit l'état et reporte la prochaine tentative ; `false` si le candidat a été retiré
   * entre-temps. L'échéancier suit l'état : abandonné (`idleRounds > 0`) ou prioritaire (#185).
   */
  async update(record: ReconcileRecord, nextAt: number): Promise<boolean> {
    const applied = await this.redis.raw.eval(
      UPDATE_SCRIPT,
      4,
      RECONCILE_KEY_PREFIX + record.reservationId,
      RECONCILE_INDEX_KEY,
      RECONCILE_DUE_KEY,
      RECONCILE_IDLE_DUE_KEY,
      JSON.stringify(record),
      this.recordTtlSeconds,
      nextAt,
      record.reservationId,
      (record.idleRounds ?? 0) > 0 ? '1' : '0',
    );
    return applied === 1;
  }

  /** Sort un candidat de l'index (confirmé, annulé sans argent engagé, âge maximal dépassé). */
  async remove(reservationId: string): Promise<void> {
    await this.redis.raw.eval(
      REMOVE_SCRIPT,
      4,
      RECONCILE_KEY_PREFIX + reservationId,
      RECONCILE_INDEX_KEY,
      RECONCILE_DUE_KEY,
      RECONCILE_IDLE_DUE_KEY,
      reservationId,
    );
  }

  /**
   * Candidats dont la tentative est échue à `now`, au plus `limit` : d'abord l'échéancier
   * prioritaire, le plus ancien d'abord, puis, dans la place restante, les paiements abandonnés
   * (#185 AC-3). Des abandons nombreux ne retardent donc jamais un paiement engagé : ils ne prennent
   * que ce que les prioritaires laissent du lot.
   */
  async due(now: number, limit: number): Promise<string[]> {
    const priority = await this.redis.raw.zrangebyscore(
      RECONCILE_DUE_KEY,
      '-inf',
      now,
      'LIMIT',
      0,
      limit,
    );
    if (priority.length >= limit) {
      return priority;
    }
    const idle = await this.redis.raw.zrangebyscore(
      RECONCILE_IDLE_DUE_KEY,
      '-inf',
      now,
      'LIMIT',
      0,
      limit - priority.length,
    );
    // Deux lectures distinctes : un membre déplacé entre elles n'est servi qu'une fois.
    return [...new Set([...priority, ...idle])];
  }

  /** Candidats émis avant `before` (âge maximal dépassé), au plus `limit`. */
  async olderThan(before: number, limit: number): Promise<string[]> {
    return this.redis.raw.zrangebyscore(
      RECONCILE_INDEX_KEY,
      '-inf',
      `(${before}`,
      'LIMIT',
      0,
      limit,
    );
  }

  /** Verrou de passe : une seule instance du BFF réconcilie à la fois (AC-4). */
  async acquirePassLock(ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const acquired = await this.redis.raw.set(
      RECONCILE_LOCK_KEY,
      token,
      'PX',
      ttlMs,
      'NX',
    );
    return acquired === 'OK' ? token : null;
  }

  async releasePassLock(token: string): Promise<void> {
    try {
      await this.redis.raw.eval(
        COMPARE_AND_DELETE_SCRIPT,
        1,
        RECONCILE_LOCK_KEY,
        token,
      );
    } catch {
      this.logger.warn(
        'Libération du verrou de réconciliation impossible (le TTL prendra le relais).',
      );
    }
  }

  /** Panne Redis sur un chemin de requête → 503, jamais 500 (règle 2.1). */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      this.logger.error(
        `Magasin d'état de la réconciliation indisponible : ${err instanceof Error ? err.message : 'erreur inconnue'}`,
      );
      throw new ServiceUnavailableException(
        'Service de paiement momentanément indisponible.',
      );
    }
  }
}
