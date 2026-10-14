import { ServiceUnavailableException } from '@nestjs/common';
import type { RedisService } from '../../redis/redis.service';
import type { ReconcileOptions } from './reconcile.constants';
import {
  ENROLL_SCRIPT,
  PaymentReconcileStore,
  RECONCILE_DUE_KEY,
  RECONCILE_INDEX_KEY,
  RECONCILE_KEY_PREFIX,
  RECONCILE_LOCK_KEY,
  REMOVE_SCRIPT,
  UPDATE_SCRIPT,
  type ReconcileRecord,
} from './reconcile.store';

const ID = '3f2b8c1e-6d4a-4b7e-9a10-5c2d1e0f9a88';

const options: ReconcileOptions = {
  enabled: false,
  intervalMs: 60_000,
  batchSize: 50,
  alertAfterSeconds: 900,
  alertRepeatSeconds: 3_600,
  maxAgeSeconds: 691_200,
  pmsCallBudgetMs: 24_750,
};

function makeRedis() {
  const raw = {
    eval: jest.fn().mockResolvedValue(1),
    zscore: jest.fn().mockResolvedValue('1000'),
    zrangebyscore: jest.fn().mockResolvedValue([ID]),
    set: jest.fn().mockResolvedValue('OK'),
  };
  const service = {
    raw,
    get: jest.fn().mockResolvedValue(null),
  };
  return { raw, service };
}

function record(overrides: Partial<ReconcileRecord> = {}): ReconcileRecord {
  return {
    reservationId: ID,
    issuedAt: 1_000,
    attempts: 0,
    failures: 0,
    paymentId: null,
    lastIntentStatus: null,
    refusal: null,
    lastAlertAt: null,
    ...overrides,
  };
}

describe('PaymentReconcileStore (#5 AC-1)', () => {
  let redis: ReturnType<typeof makeRedis>;
  let store: PaymentReconcileStore;

  beforeEach(() => {
    redis = makeRedis();
    store = new PaymentReconcileStore(
      redis.service as unknown as RedisService,
      options,
    );
  });

  it('inscrit le candidat en un seul pas : état, index (score = émission) et échéance après grâce', async () => {
    await store.enroll(ID, 1_000);

    expect(redis.raw.eval).toHaveBeenCalledWith(
      ENROLL_SCRIPT,
      3,
      RECONCILE_KEY_PREFIX + ID,
      RECONCILE_INDEX_KEY,
      RECONCILE_DUE_KEY,
      expect.any(String),
      691_200 + 86_400,
      1_000,
      61_000,
      ID,
    );
    const written = JSON.parse(
      (redis.raw.eval.mock.calls[0] as unknown[])[5] as string,
    ) as ReconcileRecord;
    expect(written).toEqual(record());
  });

  it('l’état inscrit ne porte ni donnée personnelle ni jeton (clés exactes)', async () => {
    await store.enroll(ID, 1_000);
    const written = JSON.parse(
      (redis.raw.eval.mock.calls[0] as unknown[])[5] as string,
    ) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(
      [
        'attempts',
        'failures',
        'issuedAt',
        'lastAlertAt',
        'lastIntentStatus',
        'paymentId',
        'refusal',
        'reservationId',
      ].sort(),
    );
  });

  it('le script d’inscription ne réécrit jamais un candidat existant (première émission conservée)', () => {
    expect(ENROLL_SCRIPT).toMatch(/exists/);
    expect(ENROLL_SCRIPT).toMatch(/'NX'/);
  });

  it('une panne Redis à l’inscription devient un 503, jamais un 500', async () => {
    redis.raw.eval.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(store.enroll(ID, 1_000)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('lit l’état et le score d’index', async () => {
    redis.service.get.mockResolvedValueOnce(JSON.stringify(record()));
    await expect(store.read(ID)).resolves.toEqual({
      record: record(),
      issuedAt: 1_000,
    });
  });

  it('un état illisible est traité comme absent ; un candidat hors index n’a pas d’émission', async () => {
    redis.service.get.mockResolvedValueOnce('{pas du json');
    redis.raw.zscore.mockResolvedValueOnce(null);
    await expect(store.read(ID)).resolves.toEqual({
      record: null,
      issuedAt: null,
    });
  });

  it('la mise à jour est conditionnée à l’appartenance à l’index (aucune résurrection)', async () => {
    redis.raw.eval.mockResolvedValueOnce(0);
    await expect(store.update(record({ failures: 2 }), 5_000)).resolves.toBe(
      false,
    );
    expect(redis.raw.eval).toHaveBeenCalledWith(
      UPDATE_SCRIPT,
      3,
      RECONCILE_KEY_PREFIX + ID,
      RECONCILE_INDEX_KEY,
      RECONCILE_DUE_KEY,
      JSON.stringify(record({ failures: 2 })),
      691_200 + 86_400,
      5_000,
      ID,
    );
    expect(UPDATE_SCRIPT).toMatch(/zscore/);
  });

  it('retire état, index et échéance en un seul pas', async () => {
    await store.remove(ID);
    expect(redis.raw.eval).toHaveBeenCalledWith(
      REMOVE_SCRIPT,
      3,
      RECONCILE_KEY_PREFIX + ID,
      RECONCILE_INDEX_KEY,
      RECONCILE_DUE_KEY,
      ID,
    );
  });

  it('lit les échéances et les candidats trop anciens (borne exclusive), bornés au lot', async () => {
    await store.due(9_000, 10);
    expect(redis.raw.zrangebyscore).toHaveBeenCalledWith(
      RECONCILE_DUE_KEY,
      '-inf',
      9_000,
      'LIMIT',
      0,
      10,
    );
    await store.olderThan(4_000, 10);
    expect(redis.raw.zrangebyscore).toHaveBeenLastCalledWith(
      RECONCILE_INDEX_KEY,
      '-inf',
      '(4000',
      'LIMIT',
      0,
      10,
    );
  });

  it('verrou de passe : SET NX PX, libéré en compare-and-delete', async () => {
    const token = await store.acquirePassLock(60_000);
    expect(token).toEqual(expect.any(String));
    expect(redis.raw.set).toHaveBeenCalledWith(
      RECONCILE_LOCK_KEY,
      token,
      'PX',
      60_000,
      'NX',
    );
    redis.raw.set.mockResolvedValueOnce(null);
    await expect(store.acquirePassLock(60_000)).resolves.toBeNull();

    await store.releasePassLock(token!);
    expect(redis.raw.eval).toHaveBeenLastCalledWith(
      expect.stringContaining("redis.call('del'"),
      1,
      RECONCILE_LOCK_KEY,
      token,
    );
  });

  it('une libération de verrou en échec ne lève pas (le TTL prend le relais)', async () => {
    redis.raw.eval.mockRejectedValueOnce(new Error('down'));
    await expect(store.releasePassLock('t')).resolves.toBeUndefined();
  });
});
