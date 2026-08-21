import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { FakeRedis } from '../../../test/fake-redis';
import { RedisService } from '../../redis/redis.service';
import type { BookingOptions } from './booking.constants';
import {
  COMM_LOCALE_KEY_PREFIX,
  CheckoutHoldService,
  CLEAR_PAYMENT_STARTED_SCRIPT,
  COMPARE_AND_DELETE_SCRIPT,
  COUNT_AND_RESCHEDULE_SCRIPT,
  DROP_INDEXED_SCRIPT,
  HOLD_INDEX_KEY,
  HOLD_KEY_PREFIX,
  IDEMPOTENCY_KEY_PREFIX,
  INTENT_KEY_PREFIX,
  INTENT_MEMBER_PREFIX,
  MARK_PAYMENT_STARTED_SCRIPT,
  PROMOTE_INTENT_SCRIPT,
  STAY_LOCK_PREFIX,
  WRITE_AND_INDEX_SCRIPT,
  type StayFingerprint,
} from './checkout-hold.service';

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HOTEL_ID = '11111111-1111-1111-1111-111111111111';
const ROOM_ID = '22222222-2222-2222-2222-222222222222';
const RESERVATION_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_RESERVATION_ID = '44444444-4444-4444-4444-444444444444';
const INTENT_ID = '55555555-5555-5555-5555-555555555555';

const options: BookingOptions = {
  maxStayNights: 90,
  holdTtlSeconds: 900,
  holdRecordGraceSeconds: 3600,
  stayLockTtlMs: 90_000,
  lockWaitTimeoutMs: 5_000,
  lockPollIntervalMs: 100,
  sweeperIntervalMs: 60_000,
  sweeperBatchSize: 50,
  sweeperMaxAttempts: 5,
  sweeperRetryDelayMs: 60_000,
  sweeperEnabled: false,
  pmsCallBudgetMs: 24_750,
  intentReconcileDelayMs: 90_000,
  communicationLocaleTtlSeconds: 172_800,
};

const stay: StayFingerprint = {
  userId: USER_ID,
  roomId: ROOM_ID,
  checkInDate: '2026-09-01',
  checkOutDate: '2026-09-03',
  guests: 2,
};

/**
 * `FakeRedis` **augmenté d'un interpréteur des scripts du module**.
 *
 * ⚠️ Pourquoi il existe : les opérations composites du service (enregistrement + index, incrément
 * de tentative + report, promotion d'intention) sont passées en **Lua** précisément pour qu'aucun
 * état intermédiaire ne soit observable. Le double du dépôt ne connaît qu'`EVAL` du script
 * compare-and-delete ; sans cet interpréteur, ces chemins passeraient les tests **sans rien
 * écrire** — le pire des faux verts (`test/fake-redis.ts` documente ce piège pour cette raison).
 *
 * Il n'émule pas l'atomicité (impossible en mémoire, et sans objet ici : Jest est mono-thread) mais
 * bien les **effets** de chaque script, exprimés avec les commandes déjà honorées fidèlement.
 */
class ScriptedRedis extends FakeRedis {
  override async eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<number> {
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys);

    switch (script) {
      case COMPARE_AND_DELETE_SCRIPT: {
        if ((await super.get(keys[0])) !== String(argv[0])) {
          return 0;
        }
        await super.del(keys[0]);
        return 1;
      }
      case WRITE_AND_INDEX_SCRIPT: {
        await super.set(keys[0], String(argv[0]), 'EX', Number(argv[1]));
        await super.zadd(keys[1], Number(argv[2]), String(argv[3]));
        return 1;
      }
      case PROMOTE_INTENT_SCRIPT: {
        await super.set(keys[0], String(argv[0]), 'EX', Number(argv[1]));
        await super.zadd(keys[1], Number(argv[2]), String(argv[3]));
        await super.del(keys[2]);
        await super.zrem(keys[1], String(argv[4]));
        return 1;
      }
      case DROP_INDEXED_SCRIPT: {
        await super.del(keys[0]);
        await super.zrem(keys[1], String(argv[0]));
        return 1;
      }
      case MARK_PAYMENT_STARTED_SCRIPT:
      case CLEAR_PAYMENT_STARTED_SCRIPT: {
        // Le script renvoie 0 si l'enregistrement est absent, -1 s'il est illisible : ce sont les
        // deux codes que le service DOIT désormais inspecter (revue de code 3.1).
        const raw = await super.get(keys[0]);
        if (raw === null) {
          return 0;
        }
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return -1;
        }
        record.paymentStarted = script === MARK_PAYMENT_STARTED_SCRIPT;
        await super.set(keys[0], JSON.stringify(record), 'EX', Number(argv[0]));
        return 1;
      }
      case COUNT_AND_RESCHEDULE_SCRIPT: {
        const record = await this.decode(keys[0]);
        if (!record) {
          await super.zrem(keys[1], String(argv[2]));
          return -2;
        }
        const attempts = Number(record.attempts ?? 0) + 1;
        record.attempts = attempts;
        await super.set(keys[0], JSON.stringify(record), 'EX', Number(argv[0]));
        await super.zadd(keys[1], Number(argv[1]), String(argv[2]));
        return attempts;
      }
      default:
        throw new Error(`Script Lua non émulé par le double : ${script}`);
    }
  }

  private async decode(key: string): Promise<Record<string, unknown> | null> {
    const raw = await super.get(key);
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  }
}

describe('CheckoutHoldService', () => {
  let redis: ScriptedRedis;
  let service: CheckoutHoldService;

  beforeEach(() => {
    redis = new ScriptedRedis();
    service = new CheckoutHoldService(
      new RedisService(redis as unknown as Redis),
      options,
    );
  });

  function registerHold(overrides: Partial<{ id: string; expiresAt: number }>) {
    return service.register({
      reservationId: overrides.id ?? RESERVATION_ID,
      sid: 'sid-1',
      userId: USER_ID,
      hotelId: HOTEL_ID,
      roomId: ROOM_ID,
      expiresAt: overrides.expiresAt ?? redis.now + 1,
      stay,
    });
  }

  describe('verrou de chambre (AC-4)', () => {
    it('accorde le verrou une seule fois pour une même chambre', async () => {
      const first = await service.acquireStayLock(stay);
      const second = await service.acquireStayLock(stay);
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('la clé de verrou porte un TTL (aucune immobilisation définitive)', async () => {
      await service.acquireStayLock(stay);
      const key = [...redis.liveKeys()].find((k) =>
        k.startsWith(STAY_LOCK_PREFIX),
      );
      expect(key).toBeDefined();
      expect(redis.ttlMsOf(key as string)).toBe(options.stayLockTtlMs);
    });

    it('libère le verrou pour son propriétaire uniquement (compare-and-delete)', async () => {
      const token = (await service.acquireStayLock(stay)) as string;

      await service.releaseStayLock(stay, 'jeton-usurpé');
      expect(await service.acquireStayLock(stay)).toBeNull();

      await service.releaseStayLock(stay, token);
      expect(await service.acquireStayLock(stay)).not.toBeNull();
    });

    /**
     * ⚠️ Ce test remplace un précédent (« n'oppose pas deux séjours différents sur la même
     * chambre ») qui verrouillait le comportement fautif : la clé était un hash **exact** de
     * (chambre, dates), donc deux séjours qui **se chevauchent** n'étaient pas sérialisés — soit
     * exactement le double-booking à empêcher, le PMS n'ayant aucune atomicité (D3).
     */
    it('sérialise deux séjours qui se chevauchent sur la même chambre', async () => {
      expect(await service.acquireStayLock(stay)).not.toBeNull();
      expect(
        await service.acquireStayLock({
          ...stay,
          checkInDate: '2026-09-02',
          checkOutDate: '2026-09-04',
        }),
      ).toBeNull();
    });

    it('sérialise aussi deux séjours disjoints (le verrou porte sur la chambre entière)', async () => {
      // Coût assumé : une contention brève entre deux séjours qui n'entrent pas en conflit. Le
      // prix d'une distinction fine serait de laisser passer les chevauchements ci-dessus.
      expect(await service.acquireStayLock(stay)).not.toBeNull();
      expect(
        await service.acquireStayLock({ ...stay, checkInDate: '2026-10-01' }),
      ).toBeNull();
    });

    it("n'oppose pas deux chambres différentes", async () => {
      expect(await service.acquireStayLock(stay)).not.toBeNull();
      expect(
        await service.acquireStayLock({ ...stay, roomId: 'une-autre-chambre' }),
      ).not.toBeNull();
    });

    it('ignore le compte : deux voyageurs visant la même chambre se sérialisent', async () => {
      expect(await service.acquireStayLock(stay)).not.toBeNull();
      expect(
        await service.acquireStayLock({ ...stay, userId: 'un-autre-compte' }),
      ).toBeNull();
    });
  });

  describe('idempotence (AC-5)', () => {
    it('relit la réservation écrite pour la même empreinte de séjour', async () => {
      await service.writeIdempotent(stay, RESERVATION_ID);
      await expect(service.readIdempotent(stay)).resolves.toBe(RESERVATION_ID);
    });

    it.each([
      ['une autre chambre', { roomId: 'autre-chambre' }],
      ['un autre compte', { userId: 'autre-compte' }],
      ["d'autres dates", { checkInDate: '2026-12-01' }],
      ['un autre nombre de voyageurs', { guests: 3 }],
    ])('ne collisionne pas avec %s', async (_label, overrides) => {
      await service.writeIdempotent(stay, RESERVATION_ID);
      await expect(
        service.readIdempotent({ ...stay, ...overrides }),
      ).resolves.toBeNull();
    });

    it('expire avec la fenêtre suivie du hold (jamais de clé éternelle)', async () => {
      await service.writeIdempotent(stay, RESERVATION_ID);
      const key = redis
        .liveKeys()
        .find((k) => k.startsWith(IDEMPOTENCY_KEY_PREFIX)) as string;
      expect(redis.ttlMsOf(key)).toBe(
        (options.holdTtlSeconds + options.holdRecordGraceSeconds) * 1000,
      );
    });

    it('clearIdempotent purge la clé (rejeu après libération = nouvelle réservation)', async () => {
      await service.writeIdempotent(stay, RESERVATION_ID);
      await service.clearIdempotent(stay);
      await expect(service.readIdempotent(stay)).resolves.toBeNull();
    });

    it('clearIdempotent ne purge PAS une clé qui désigne déjà une autre réservation', async () => {
      await service.writeIdempotent(stay, OTHER_RESERVATION_ID);
      await service.clearIdempotent(stay, RESERVATION_ID);
      await expect(service.readIdempotent(stay)).resolves.toBe(
        OTHER_RESERVATION_ID,
      );
    });
  });

  describe('hold de checkout (AC-6)', () => {
    it('enregistre le hold et l’indexe à son échéance', async () => {
      const expiresAt = redis.now + options.holdTtlSeconds * 1000;
      await registerHold({ expiresAt });

      const record = await service.read(RESERVATION_ID);
      expect(record).toMatchObject({
        reservationId: RESERVATION_ID,
        sid: 'sid-1',
        expiresAt,
        paymentStarted: false,
        attempts: 0,
      });
      await expect(redis.zcard(HOLD_INDEX_KEY)).resolves.toBe(1);
    });

    it('écrit l’enregistrement et son index en UN SEUL script (jamais de hold hors index)', async () => {
      // Un `ZADD` en échec après un `SET` réussi produirait un hold invisible du balayeur : une
      // vraie chambre gelée sans aucun filet. Les deux écritures ne doivent donc jamais être
      // séparables — ce que prouve l'unique aller-retour, scripté, qui produit les deux effets.
      const evaluate = jest.spyOn(redis, 'eval');

      await registerHold({});

      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(evaluate.mock.calls[0][0]).toBe(WRITE_AND_INDEX_SCRIPT);
      await expect(service.read(RESERVATION_ID)).resolves.not.toBeNull();
      await expect(redis.zcard(HOLD_INDEX_KEY)).resolves.toBe(1);
    });

    it("survit à l'échéance du hold : le balayeur a besoin du `sid` APRÈS expiration", async () => {
      const expiresAt = redis.now + options.holdTtlSeconds * 1000;
      await registerHold({ expiresAt });

      redis.advance(options.holdTtlSeconds * 1000 + 1);
      expect(redis.ttlMsOf(HOLD_KEY_PREFIX + RESERVATION_ID)).toBeGreaterThan(
        0,
      );
      await expect(service.read(RESERVATION_ID)).resolves.not.toBeNull();
    });

    it('ne rend échu qu’un hold dont l’échéance est passée', async () => {
      await registerHold({ expiresAt: redis.now + 900_000 });

      await expect(service.dueHolds(redis.now, 10)).resolves.toEqual([]);
      await expect(service.dueHolds(redis.now + 900_001, 10)).resolves.toEqual([
        RESERVATION_ID,
      ]);
    });

    it('borne le lot renvoyé par `dueHolds`', async () => {
      for (let i = 0; i < 5; i++) {
        await service.register({
          reservationId: `res-${i}`,
          sid: 'sid',
          userId: USER_ID,
          hotelId: HOTEL_ID,
          roomId: ROOM_ID,
          expiresAt: redis.now + i,
          stay: { ...stay, roomId: `room-${i}` },
        });
      }
      await expect(
        service.dueHolds(redis.now + 10_000, 2),
      ).resolves.toHaveLength(2);
    });

    it('release retire le hold, son index ET la clé d’idempotence', async () => {
      await service.writeIdempotent(stay, RESERVATION_ID);
      await registerHold({});

      await service.release(RESERVATION_ID);

      await expect(service.read(RESERVATION_ID)).resolves.toBeNull();
      await expect(redis.zcard(HOLD_INDEX_KEY)).resolves.toBe(0);
      // Sans cette purge, un rejeu de création renverrait une réservation ANNULÉE.
      await expect(service.readIdempotent(stay)).resolves.toBeNull();
    });

    /**
     * La clé d'idempotence est dérivée du **séjour**, pas de la réservation : entre l'annulation
     * d'une R1 par le balayeur et sa libération, le voyageur a pu recréer une R2 vivante sur la
     * même empreinte. Une purge aveugle effacerait la mémoire de R2, et le clic suivant créerait
     * une R3 — deux `Pending` pour un seul séjour.
     */
    it('release ne purge pas une clé d’idempotence qui désigne déjà une AUTRE réservation', async () => {
      await service.writeIdempotent(stay, RESERVATION_ID);
      await registerHold({});
      await service.writeIdempotent(stay, OTHER_RESERVATION_ID);

      await service.release(RESERVATION_ID);

      await expect(service.readIdempotent(stay)).resolves.toBe(
        OTHER_RESERVATION_ID,
      );
    });

    it('release d’un hold inconnu ne lève pas (idempotent)', async () => {
      await expect(service.release('inconnu')).resolves.toBeUndefined();
    });
  });

  describe('invariant FR-14 (AC-7)', () => {
    beforeEach(async () => {
      await registerHold({});
    });

    it('markPaymentStarted marque le hold sans perdre le reste de l’enregistrement', async () => {
      await service.markPaymentStarted(RESERVATION_ID);
      const record = await service.read(RESERVATION_ID);
      expect(record?.paymentStarted).toBe(true);
      expect(record?.sid).toBe('sid-1');
    });

    /**
     * ⚠️ Comportement INVERSÉ en revue de code 3.1.
     *
     * Ce test affirmait auparavant qu'un hold inconnu « ne lève pas ». C'était précisément le
     * défaut : le script Lua renvoie `0` quand l'enregistrement a disparu (TTL écoulé, éviction
     * Redis) et `-1` quand il est illisible — deux cas où le drapeau n'a PAS été posé. Le code de
     * retour étant ignoré, l'appelant poursuivait et renvoyait le `clientSecret` au navigateur alors
     * que l'invariant FR-14 (« geler avant d'émettre ») n'était pas établi, avec un 200 à la clé.
     *
     * Échouer bruyamment est le seul comportement sûr : une chambre que le balayeur peut encore
     * annuler ne doit pas se retrouver payable.
     */
    it('markPaymentStarted ÉCHOUE quand le hold est absent : FR-14 ne peut pas être établi', async () => {
      await expect(
        service.markPaymentStarted('inconnu'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('markPaymentStarted échoue aussi sur un enregistrement illisible', async () => {
      await redis.set(
        HOLD_KEY_PREFIX + 'corrompu',
        'ceci-n-est-pas-du-json',
        60,
      );

      await expect(
        service.markPaymentStarted('corrompu'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    /**
     * Revue de code 3.1 — le gel doit pouvoir être relâché quand il est prouvé qu'aucun paiement
     * ne peut exister (refus PMS antérieur à tout appel Stripe). Sans cela, une réservation
     * structurellement impayable immobilisait la chambre pour toujours.
     */
    it('clearPaymentStarted relâche le gel sans perdre le reste de l’enregistrement', async () => {
      await service.markPaymentStarted(RESERVATION_ID);
      expect((await service.read(RESERVATION_ID))?.paymentStarted).toBe(true);

      await service.clearPaymentStarted(RESERVATION_ID);

      const record = await service.read(RESERVATION_ID);
      expect(record?.paymentStarted).toBe(false);
      expect(record?.sid).toBe('sid-1');
    });

    /**
     * `paymentStarted` est le **seul** rempart de FR-14. Tant que la mise à jour était un
     * lire-modifier-réécrire côté client, deux mises à jour concurrentes de l'enregistrement
     * entier se perdaient l'une l'autre : un simple report de tentative du balayeur, parti d'une
     * lecture antérieure, réécrivait `paymentStarted: false` sur un paiement engagé.
     */
    it.each([
      [
        'markPaymentStarted',
        (s: CheckoutHoldService) => s.markPaymentStarted(RESERVATION_ID),
      ],
      [
        'reschedule',
        (s: CheckoutHoldService) => s.reschedule(RESERVATION_ID, 1_000),
      ],
    ])(
      '%s ne relit jamais l’enregistrement côté client (aucune perte de mise à jour concurrente)',
      async (_label, call) => {
        const get = jest.spyOn(redis, 'get');
        await call(service);
        expect(get).not.toHaveBeenCalledWith(HOLD_KEY_PREFIX + RESERVATION_ID);
      },
    );

    it('un report de tentative préserve un paiement déjà engagé', async () => {
      await service.markPaymentStarted(RESERVATION_ID);
      await service.reschedule(RESERVATION_ID, redis.now + 60_000);

      const record = await service.read(RESERVATION_ID);
      expect(record?.paymentStarted).toBe(true);
      expect(record?.attempts).toBe(1);
    });

    it('reschedule incrémente les tentatives et repousse l’échéance d’index', async () => {
      const next = redis.now + 60_000;
      await expect(service.reschedule(RESERVATION_ID, next)).resolves.toBe(1);

      expect((await service.read(RESERVATION_ID))?.attempts).toBe(1);
      await expect(service.dueHolds(redis.now + 1, 10)).resolves.toEqual([]);
      await expect(service.dueHolds(next + 1, 10)).resolves.toEqual([
        RESERVATION_ID,
      ]);
    });

    it('reschedule d’un hold disparu renvoie null et retire l’entrée d’index', async () => {
      await expect(service.reschedule('fantôme', 1_000)).resolves.toBeNull();
      await expect(redis.zcard(HOLD_INDEX_KEY)).resolves.toBe(1); // le hold réel reste
    });
  });

  describe('intention de création (correctif D1)', () => {
    async function registerIntent(): Promise<void> {
      await service.registerIntent({
        intentId: INTENT_ID,
        sid: 'sid-1',
        userId: USER_ID,
        hotelId: HOTEL_ID,
        roomId: ROOM_ID,
        stay,
      });
    }

    it('enregistre l’empreinte du séjour et la session, indispensables à la réconciliation', async () => {
      await registerIntent();

      const record = await service.readIntent(INTENT_ID);
      expect(record).toMatchObject({
        intentId: INTENT_ID,
        sid: 'sid-1',
        hotelId: HOTEL_ID,
        roomId: ROOM_ID,
        checkInDate: stay.checkInDate,
        checkOutDate: stay.checkOutDate,
        guests: 2,
        attempts: 0,
      });
      expect(record?.stayKey.startsWith(IDEMPOTENCY_KEY_PREFIX)).toBe(true);
    });

    it('planifie la réconciliation au-delà du budget PMS (jamais sur une requête en vol)', async () => {
      const before = Date.now();
      await registerIntent();
      const record = await service.readIntent(INTENT_ID);

      expect(record?.reconcileAt).toBeGreaterThanOrEqual(
        before + options.intentReconcileDelayMs,
      );
      expect(options.intentReconcileDelayMs).toBeGreaterThan(
        options.pmsCallBudgetMs,
      );
    });

    it('indexe l’intention dans le MÊME index que les holds, sous un membre distinct', async () => {
      await registerIntent();
      const due = await service.dueHolds(
        Date.now() + options.intentReconcileDelayMs + 1,
        10,
      );
      expect(due).toEqual([`${INTENT_MEMBER_PREFIX}${INTENT_ID}`]);
    });

    it('n’est pas échue avant son délai de réconciliation', async () => {
      await registerIntent();
      await expect(service.dueHolds(Date.now(), 10)).resolves.toEqual([]);
    });

    it('promoteIntent installe le hold et retire l’intention en un seul script', async () => {
      await registerIntent();
      const evaluate = jest.spyOn(redis, 'eval');

      await service.promoteIntent(INTENT_ID, {
        reservationId: RESERVATION_ID,
        sid: 'sid-1',
        userId: USER_ID,
        hotelId: HOTEL_ID,
        roomId: ROOM_ID,
        expiresAt: redis.now + 900_000,
        stay,
      });

      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(evaluate.mock.calls[0][0]).toBe(PROMOTE_INTENT_SCRIPT);
      await expect(service.read(RESERVATION_ID)).resolves.toMatchObject({
        reservationId: RESERVATION_ID,
      });
      await expect(service.readIntent(INTENT_ID)).resolves.toBeNull();
      // L'index ne doit contenir que le hold : une intention promue puis réconciliée irait
      // chercher — et annuler — la réservation qu'elle vient d'engendrer.
      await expect(
        service.dueHolds(Date.now() + 86_400_000, 10),
      ).resolves.toEqual([RESERVATION_ID]);
    });

    it('dropIntent retire l’enregistrement ET son membre d’index', async () => {
      await registerIntent();
      await service.dropIntent(INTENT_ID);

      await expect(service.readIntent(INTENT_ID)).resolves.toBeNull();
      await expect(redis.zcard(HOLD_INDEX_KEY)).resolves.toBe(0);
    });

    it('dropIntent d’une intention inconnue ne lève pas (idempotent)', async () => {
      await expect(service.dropIntent('inconnue')).resolves.toBeUndefined();
    });

    it('rescheduleIntent compte la tentative et repousse l’échéance', async () => {
      await registerIntent();
      const next = Date.now() + 600_000;

      await expect(service.rescheduleIntent(INTENT_ID, next)).resolves.toBe(1);
      expect((await service.readIntent(INTENT_ID))?.attempts).toBe(1);
      await expect(service.dueHolds(next - 1, 10)).resolves.toEqual([]);
      await expect(service.dueHolds(next + 1, 10)).resolves.toEqual([
        `${INTENT_MEMBER_PREFIX}${INTENT_ID}`,
      ]);
    });

    it('rescheduleIntent d’une intention disparue renvoie null et nettoie l’index', async () => {
      await expect(
        service.rescheduleIntent('fantôme', Date.now()),
      ).resolves.toBeNull();
      await expect(redis.zcard(HOLD_INDEX_KEY)).resolves.toBe(0);
    });

    it('l’enregistrement d’intention porte le TTL de la fenêtre suivie', async () => {
      await registerIntent();
      expect(redis.ttlMsOf(INTENT_KEY_PREFIX + INTENT_ID)).toBe(
        (options.holdTtlSeconds + options.holdRecordGraceSeconds) * 1000,
      );
    });
  });

  describe('purge d’index orphelin', () => {
    it('forget retire une entrée d’index dont l’enregistrement a disparu', async () => {
      await redis.zadd(HOLD_INDEX_KEY, 1, 'fantôme');
      await service.forget('fantôme');
      await expect(redis.zcard(HOLD_INDEX_KEY)).resolves.toBe(0);
    });
  });

  describe('panne du magasin d’état', () => {
    function failing(): CheckoutHoldService {
      const broken = {
        get: () => Promise.reject(new Error('ECONNREFUSED')),
        set: () => Promise.reject(new Error('ECONNREFUSED')),
        del: () => Promise.reject(new Error('ECONNREFUSED')),
        zadd: () => Promise.reject(new Error('ECONNREFUSED')),
        zrangebyscore: () => Promise.reject(new Error('ECONNREFUSED')),
        zrem: () => Promise.reject(new Error('ECONNREFUSED')),
        eval: () => Promise.reject(new Error('ECONNREFUSED')),
      };
      return new CheckoutHoldService(
        new RedisService(broken as unknown as Redis),
        options,
      );
    }

    it.each([
      ['readIdempotent', (s: CheckoutHoldService) => s.readIdempotent(stay)],
      [
        'writeIdempotent',
        (s: CheckoutHoldService) => s.writeIdempotent(stay, RESERVATION_ID),
      ],
      ['acquireStayLock', (s: CheckoutHoldService) => s.acquireStayLock(stay)],
      ['read', (s: CheckoutHoldService) => s.read(RESERVATION_ID)],
      [
        'register',
        (s: CheckoutHoldService) =>
          s.register({
            reservationId: RESERVATION_ID,
            sid: 'sid',
            userId: USER_ID,
            hotelId: HOTEL_ID,
            roomId: ROOM_ID,
            expiresAt: 1,
            stay,
          }),
      ],
      [
        'registerIntent',
        (s: CheckoutHoldService) =>
          s.registerIntent({
            intentId: INTENT_ID,
            sid: 'sid',
            userId: USER_ID,
            hotelId: HOTEL_ID,
            roomId: ROOM_ID,
            stay,
          }),
      ],
      [
        'promoteIntent',
        (s: CheckoutHoldService) =>
          s.promoteIntent(INTENT_ID, {
            reservationId: RESERVATION_ID,
            sid: 'sid',
            userId: USER_ID,
            hotelId: HOTEL_ID,
            roomId: ROOM_ID,
            expiresAt: 1,
            stay,
          }),
      ],
      ['dropIntent', (s: CheckoutHoldService) => s.dropIntent(INTENT_ID)],
      [
        'rescheduleIntent',
        (s: CheckoutHoldService) => s.rescheduleIntent(INTENT_ID, 1),
      ],
    ])('%s remonte un 503, jamais un 500', async (_label, call) => {
      // Un 500 serait interprété par le front comme un bug applicatif ; une panne du magasin
      // d'état est une INDISPONIBILITÉ (NFR-10). Règle héritée de la revue 2.1.
      await expect(call(failing())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  /**
   * Story 2.5 (FR-10) — langue de communication, sous sa **propre** clé (revue 2ᵉ passe, F7).
   *
   * Elle vivait sur `CheckoutHoldRecord` : le balayeur la supprimait avec le hold, et son TTL
   * (hold + sursis) l'évinçait de toute façon bien avant l'expiration d'une `Pending`.
   */
  describe('langue de communication', () => {
    it('écrit et relit la langue choisie', async () => {
      await service.writeCommunicationLocale(RESERVATION_ID, 'en');
      await expect(
        service.readCommunicationLocale(RESERVATION_ID),
      ).resolves.toBe('en');
    });

    it("n'écrit RIEN quand aucune langue n'est exprimée", async () => {
      // « Aucun choix » doit rester un état représentable : écrire un défaut le rendrait
      // indistinguable d'un choix réel (contrat du DTO de sortie).
      await service.writeCommunicationLocale(RESERVATION_ID, null);
      await expect(
        service.readCommunicationLocale(RESERVATION_ID),
      ).resolves.toBeNull();
      expect(
        await redis.get(COMM_LOCALE_KEY_PREFIX + RESERVATION_ID),
      ).toBeNull();
    });

    it('survit à la libération du hold — deux clés, deux durées de vie', async () => {
      await registerHold({});
      await service.writeCommunicationLocale(RESERVATION_ID, 'fr');

      await service.release(RESERVATION_ID);

      expect(await service.read(RESERVATION_ID)).toBeNull();
      await expect(
        service.readCommunicationLocale(RESERVATION_ID),
      ).resolves.toBe('fr');
    });

    it("pose un TTL aligné sur l'expiration des `Pending`, pas sur le hold", async () => {
      await service.writeCommunicationLocale(RESERVATION_ID, 'fr');
      const ttl =
        (await redis.pttl(COMM_LOCALE_KEY_PREFIX + RESERVATION_ID)) / 1000;
      expect(ttl).toBe(options.communicationLocaleTtlSeconds);
      // Le point de la correction : bien AU-DELÀ de la durée de vie de l'enregistrement de hold.
      expect(ttl).toBeGreaterThan(
        options.holdTtlSeconds + options.holdRecordGraceSeconds,
      );
    });

    it("ignore une valeur illisible ou issue d'une version antérieure", async () => {
      // Le garde vit ICI, au contact de Redis : servir « de » casserait le contrat du front.
      await redis.set(COMM_LOCALE_KEY_PREFIX + RESERVATION_ID, 'de');
      await expect(
        service.readCommunicationLocale(RESERVATION_ID),
      ).resolves.toBeNull();
    });
  });
});
