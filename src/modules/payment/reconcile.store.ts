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
 * Trois structures, **indépendantes de la session et du hold** (une session détruite ou un hold
 * oublié ne doivent jamais faire perdre un paiement engagé) :
 * - `payment:reconciles:v1` — index trié des candidats, **score = instant d'émission** de l'intent ;
 * - `payment:reconcile-due:v1` — échéancier, score = prochaine tentative (grâce, backoff) ;
 * - `payment:reconcile:v1:{id}` — état de suivi, sans aucune donnée personnelle ni secret.
 *
 * L'**appartenance à l'index fait foi** : un candidat retiré (confirmé par le navigateur pendant une
 * passe, par exemple) ne peut pas être ressuscité par la mise à jour concurrente de cette passe. Les
 * transitions passent toutes par des scripts Lua (un seul pas Redis, aucun état intermédiaire).
 */

export const RECONCILE_INDEX_KEY = 'payment:reconciles:v1';
export const RECONCILE_DUE_KEY = 'payment:reconcile-due:v1';
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
}

/** Inscrit le candidat s'il est absent ; sinon répare seulement l'index, scores conservés. */
export const ENROLL_SCRIPT = `if redis.call('exists', KEYS[1]) == 1 then
  redis.call('zadd', KEYS[2], 'NX', ARGV[3], ARGV[5])
  redis.call('zadd', KEYS[3], 'NX', ARGV[4], ARGV[5])
  return 0
end
redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('zadd', KEYS[2], ARGV[3], ARGV[5])
redis.call('zadd', KEYS[3], ARGV[4], ARGV[5])
return 1`;

/** Réécrit l'état et la prochaine échéance **si et seulement si** le candidat est encore indexé. */
export const UPDATE_SCRIPT = `if not redis.call('zscore', KEYS[2], ARGV[4]) then
  redis.call('zrem', KEYS[3], ARGV[4])
  return 0
end
redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('zadd', KEYS[3], ARGV[3], ARGV[4])
return 1`;

/** Retire un candidat : état, index et échéancier. */
export const REMOVE_SCRIPT = `redis.call('del', KEYS[1])
redis.call('zrem', KEYS[2], ARGV[1])
redis.call('zrem', KEYS[3], ARGV[1])
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
    };
    await this.guard(() =>
      this.redis.raw.eval(
        ENROLL_SCRIPT,
        3,
        RECONCILE_KEY_PREFIX + reservationId,
        RECONCILE_INDEX_KEY,
        RECONCILE_DUE_KEY,
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

  /** Réécrit l'état et reporte la prochaine tentative ; `false` si le candidat a été retiré entre-temps. */
  async update(record: ReconcileRecord, nextAt: number): Promise<boolean> {
    const applied = await this.redis.raw.eval(
      UPDATE_SCRIPT,
      3,
      RECONCILE_KEY_PREFIX + record.reservationId,
      RECONCILE_INDEX_KEY,
      RECONCILE_DUE_KEY,
      JSON.stringify(record),
      this.recordTtlSeconds,
      nextAt,
      record.reservationId,
    );
    return applied === 1;
  }

  /** Sort un candidat de l'index (confirmé, annulé sans argent engagé, âge maximal dépassé). */
  async remove(reservationId: string): Promise<void> {
    await this.redis.raw.eval(
      REMOVE_SCRIPT,
      3,
      RECONCILE_KEY_PREFIX + reservationId,
      RECONCILE_INDEX_KEY,
      RECONCILE_DUE_KEY,
      reservationId,
    );
  }

  /** Candidats dont la tentative est échue à `now`, au plus `limit`, le plus ancien d'abord. */
  async due(now: number, limit: number): Promise<string[]> {
    return this.redis.raw.zrangebyscore(
      RECONCILE_DUE_KEY,
      '-inf',
      now,
      'LIMIT',
      0,
      limit,
    );
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
