import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { FakeRedis } from '../../../test/fake-redis';
import { RedisService } from '../../redis/redis.service';
import {
  CONFIRM_LOCK_KEY_PREFIX,
  ConfirmationLockService,
} from './confirmation-lock.service';
import type { PaymentOptions } from './payment.constants';

const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';

const options: PaymentOptions = {
  confirmLockTtlMs: 60_000,
  confirmWaitTimeoutMs: 30_000,
  confirmPollIntervalMs: 250,
};

/**
 * Story 3.2 (AC-3) — verrou single-flight `payment:confirm:v1:{reservationId}`.
 *
 * Exposé comme service réutilisable : la réconciliation (#5) prendra le MÊME verrou, pour ne jamais
 * confirmer en parallèle d'un voyageur.
 */
describe('ConfirmationLockService', () => {
  let redis: FakeRedis;
  let service: ConfirmationLockService;

  beforeEach(() => {
    redis = new FakeRedis();
    service = new ConfirmationLockService(
      new RedisService(redis as unknown as Redis),
      options,
    );
  });

  it('pose la clé de convention du dépôt, avec un TTL', async () => {
    const token = await service.acquire(RESERVATION_ID);

    expect(token).toEqual(expect.any(String));
    expect(await redis.get(CONFIRM_LOCK_KEY_PREFIX + RESERVATION_ID)).toBe(
      token,
    );
    expect(CONFIRM_LOCK_KEY_PREFIX).toBe('payment:confirm:v1:');
    expect(await redis.pttl(CONFIRM_LOCK_KEY_PREFIX + RESERVATION_ID)).toBe(
      60_000,
    );
  });

  it('un second demandeur n’obtient rien tant que le premier tient le verrou (CAS NX)', async () => {
    const first = await service.acquire(RESERVATION_ID);
    const second = await service.acquire(RESERVATION_ID);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await service.isHeld(RESERVATION_ID)).toBe(true);
  });

  it('ne libère que le verrou qu’il a posé (compare-and-delete)', async () => {
    const token = await service.acquire(RESERVATION_ID);

    await service.release(RESERVATION_ID, 'jeton-étranger');
    expect(await service.isHeld(RESERVATION_ID)).toBe(true);

    await service.release(RESERVATION_ID, token!);
    expect(await service.isHeld(RESERVATION_ID)).toBe(false);
  });

  it('expire de lui-même : un BFF tué en pleine confirmation ne bloque pas à vie', async () => {
    await service.acquire(RESERVATION_ID);
    redis.advance(60_001);

    expect(await service.isHeld(RESERVATION_ID)).toBe(false);
    expect(await service.acquire(RESERVATION_ID)).not.toBeNull();
  });

  it('panne Redis à la prise du verrou : 503, jamais 500', async () => {
    const broken = new ConfirmationLockService(
      new RedisService({
        set: () => Promise.reject(new Error('ECONNREFUSED')),
        get: () => Promise.reject(new Error('ECONNREFUSED')),
      } as unknown as Redis),
      options,
    );

    await expect(broken.acquire(RESERVATION_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(broken.isHeld(RESERVATION_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('panne Redis à la libération : silencieuse (le TTL prend le relais)', async () => {
    const broken = new ConfirmationLockService(
      new RedisService({
        eval: () => Promise.reject(new Error('ECONNREFUSED')),
      } as unknown as Redis),
      options,
    );

    await expect(
      broken.release(RESERVATION_ID, 'token'),
    ).resolves.toBeUndefined();
  });
});
