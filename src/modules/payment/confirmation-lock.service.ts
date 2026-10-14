import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { COMPARE_AND_DELETE_SCRIPT } from '../booking/checkout-hold.service';
import { PAYMENT_OPTIONS, type PaymentOptions } from './payment.constants';

/** Convention de nommage des clés Redis du dépôt : `<domaine>:<objet>:v1:<clé>`. */
export const CONFIRM_LOCK_KEY_PREFIX = 'payment:confirm:v1:';

/**
 * Verrou **single-flight** de la confirmation d'une Réservation (story 3.2, AC-3).
 *
 * Deux onglets, un double clic ou un retour 3-DS concurrent d'un rechargement : un seul
 * `POST /reservations/{id}/confirm` doit partir au PMS. Le verrou est posé en **CAS**
 * (`SET … NX PX`) et rendu en **compare-and-delete** : jamais de lire-modifier-réécrire (leçon 2.4).
 *
 * ⚠️ C'est du **confort et de l'économie d'appels**, pas la garantie d'idempotence : celle-ci vient
 * du PMS (transition sous verrou de ligne, index unique de l'outbox, capture Stripe idempotente).
 *
 * Service **partagé** : la réconciliation (#5, `PaymentReconciler`) prend le même verrou, pour ne
 * jamais rejouer une confirmation pendant que le voyageur la déclenche.
 *
 * Panne Redis à la prise ou à la lecture → **503**, jamais 500 (règle 2.1). La libération est
 * best-effort : le TTL prend le relais.
 */
@Injectable()
export class ConfirmationLockService {
  private readonly logger = new Logger(ConfirmationLockService.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(PAYMENT_OPTIONS) private readonly options: PaymentOptions,
  ) {}

  /** Jeton de propriété du verrou, ou `null` si une autre confirmation le détient déjà. */
  async acquire(reservationId: string): Promise<string | null> {
    const token = randomUUID();
    const acquired = await this.guard(() =>
      this.redis.raw.set(
        CONFIRM_LOCK_KEY_PREFIX + reservationId,
        token,
        'PX',
        this.options.confirmLockTtlMs,
        'NX',
      ),
    );
    return acquired === 'OK' ? token : null;
  }

  /** `true` tant qu'une confirmation est en vol pour cette réservation. */
  async isHeld(reservationId: string): Promise<boolean> {
    const value = await this.guard(() =>
      this.redis.get(CONFIRM_LOCK_KEY_PREFIX + reservationId),
    );
    return value !== null;
  }

  /** Libère le verrou **si et seulement si** l'appelant en est le propriétaire. */
  async release(reservationId: string, token: string): Promise<void> {
    try {
      await this.redis.raw.eval(
        COMPARE_AND_DELETE_SCRIPT,
        1,
        CONFIRM_LOCK_KEY_PREFIX + reservationId,
        token,
      );
    } catch {
      // Best-effort : le verrou expire de lui-même (PX). Ne jamais masquer l'issue de la
      // confirmation, qui a peut-être réussi.
      this.logger.warn(
        'Libération du verrou de confirmation impossible (le TTL prendra le relais).',
      );
    }
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      this.logger.error(
        `Magasin d'état de la confirmation indisponible : ${err instanceof Error ? err.message : 'erreur inconnue'}`,
      );
      throw new ServiceUnavailableException(
        'Service de confirmation momentanément indisponible.',
      );
    }
  }
}
