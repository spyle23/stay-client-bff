import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { FakeRedis } from '../../../test/fake-redis';
import { RedisService } from '../../redis/redis.service';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { identityTracker } from './throttler.module';

const TTL_MS = 60_000;
const BLOCK_MS = 120_000;
/** Blocage **plus court que la fenêtre** — la configuration par défaut du dépôt et le cas qui
 *  discrimine la remise à zéro du compteur (voir le test dédié). */
const SHORT_BLOCK_MS = 10_000;
const LIMIT = 3;

/**
 * `test/fake-redis.ts` ne connaît qu'un seul script Lua : le compare-and-delete du verrou de
 * séjour. On lui apprend ici — **localement au test**, le double appartenant à un autre
 * périmètre — celui du limiteur, en respectant sa sémantique exacte : `INCR`, puis pose du TTL
 * **seulement si la clé n'en a pas**, puis renvoi de `[frappes, ttlRestantMs]`.
 *
 * Le script réel, lui, est exécuté par un **vrai** Redis dans `test/booking-reservation.e2e-spec.ts`
 * (suite e2e du limiteur) : ce double ne sert qu'à rendre la logique de blocage testable
 * unitairement, pas à valider le Lua.
 */
interface ScriptedRedis {
  eval: (
    script: string,
    numKeys: number,
    key: string,
    ttlMs: number,
  ) => Promise<[number, number]>;
  /** Scripts réellement soumis — prouve qu'un incrément = **un seul** aller-retour. */
  evaluated: string[];
}

function teachIncrementScript(fake: FakeRedis): ScriptedRedis {
  // `eval` est **remplacé** sur l'instance (le double n'expose que le compare-and-delete) : d'où
  // la réécriture du type plutôt qu'une intersection, dont la signature serait incompatible.
  const scripted = fake as unknown as ScriptedRedis;
  scripted.evaluated = [];
  scripted.eval = async (script, _numKeys, key, ttlMs) => {
    scripted.evaluated.push(script);
    const hits = await fake.incr(key);
    if ((await fake.pttl(key)) < 0) {
      await fake.pexpire(key, Number(ttlMs));
    }
    return [hits, await fake.pttl(key)];
  };
  return scripted;
}

const COUNTER_KEY = 'throttle:hits:v1:ip:k';
const BLOCK_KEY = 'throttle:block:v1:ip:k';

describe('RedisThrottlerStorage', () => {
  let redis: FakeRedis;
  let scripted: ScriptedRedis;
  let storage: RedisThrottlerStorage;

  beforeEach(() => {
    redis = new FakeRedis();
    scripted = teachIncrementScript(redis);
    storage = new RedisThrottlerStorage(
      new RedisService(redis as unknown as Redis),
    );
  });

  const hit = (key = 'k') =>
    storage.increment(key, TTL_MS, LIMIT, BLOCK_MS, 'ip');

  /** Frappe avec un blocage **plus court que la fenêtre** (configuration par défaut du dépôt). */
  const shortBlockHit = (key = 'k') =>
    storage.increment(key, TTL_MS, LIMIT, SHORT_BLOCK_MS, 'ip');

  it('compte les frappes successives', async () => {
    await expect(hit()).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
    await expect(hit()).resolves.toMatchObject({
      totalHits: 2,
      isBlocked: false,
    });
    await expect(hit()).resolves.toMatchObject({
      totalHits: 3,
      isBlocked: false,
    });
  });

  it('bloque au-delà de la limite (le guard ne lève que sur `isBlocked`)', async () => {
    for (let i = 0; i < LIMIT; i++) {
      await hit();
    }
    await expect(hit()).resolves.toMatchObject({
      totalHits: 4,
      isBlocked: true,
    });
  });

  it('reste bloqué tant que le blocage court, et le martèlement ne le prolonge pas', async () => {
    for (let i = 0; i <= LIMIT; i++) {
      await hit();
    }

    // Au milieu de la sanction : toujours bloqué…
    redis.advance(BLOCK_MS / 2);
    const midway = await hit();
    expect(midway.isBlocked).toBe(true);
    // …et le compteur ne monte plus : un martèlement ne repousse pas l'échéance.
    expect(midway.totalHits).toBe(4);
    expect(midway.timeToBlockExpire).toBe(BLOCK_MS / 2 / 1000);

    // Juste avant l'échéance : encore bloqué (la sanction dure bien `blockDuration`).
    redis.advance(BLOCK_MS / 2 - 1);
    await expect(hit()).resolves.toMatchObject({ isBlocked: true });
  });

  it('aligne l’expiration du compteur sur celle du blocage (base de la remise à zéro)', async () => {
    for (let i = 0; i <= LIMIT; i++) {
      await shortBlockHit();
    }
    // Sans cet alignement, le compteur survivrait au blocage avec le TTL de la fenêtre.
    expect(redis.ttlMsOf(COUNTER_KEY)).toBe(SHORT_BLOCK_MS);
    expect(redis.ttlMsOf(BLOCK_KEY)).toBe(SHORT_BLOCK_MS);
  });

  /**
   * ⚠️ Cas **discriminant** de la revue 2.4 : le blocage expire alors que la fenêtre court
   * encore (`THROTTLE_BLOCK_MS` < `THROTTLE_WINDOW_MS`, la configuration par défaut). Avancer
   * l'horloge au-delà de la fenêtre — comme le faisait le seul test temporel de cette suite —
   * fait disparaître les deux clés et n'exerce donc rien.
   *
   * Sans remise à zéro, la frappe qui suit la levée du blocage incrémenterait un compteur resté
   * à `limit + 1` et re-bloquerait aussitôt, en boucle, jusqu'à la fin de la fenêtre : 60 s de
   * sanction configurée deviendraient une heure d'exclusion.
   */
  it('repart d’un compteur VIERGE quand le blocage expire alors que la fenêtre court encore', async () => {
    for (let i = 0; i <= LIMIT; i++) {
      await shortBlockHit();
    }
    redis.advance(SHORT_BLOCK_MS + 1);
    // La fenêtre n'est PAS terminée : il lui reste ~50 s.
    expect(SHORT_BLOCK_MS + 1).toBeLessThan(TTL_MS);

    await expect(shortBlockHit()).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
    // Et la nouvelle fenêtre repart entière (le compteur avait bien disparu).
    expect(redis.ttlMsOf(COUNTER_KEY)).toBe(TTL_MS);
  });

  it('se débloque à l’expiration de la fenêtre et du blocage', async () => {
    for (let i = 0; i <= LIMIT; i++) {
      await hit();
    }
    redis.advance(BLOCK_MS + 1);
    await expect(hit()).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
  });

  it('isole les compteurs par clé et par nom de limiteur', async () => {
    await storage.increment('a', TTL_MS, LIMIT, BLOCK_MS, 'ip');
    await expect(
      storage.increment('b', TTL_MS, LIMIT, BLOCK_MS, 'ip'),
    ).resolves.toMatchObject({ totalHits: 1 });
    await expect(
      storage.increment('a', TTL_MS, LIMIT, BLOCK_MS, 'identity'),
    ).resolves.toMatchObject({ totalHits: 1 });
  });

  /**
   * ⚠️ Unités : `ttl`/`blockDuration` arrivent en **millisecondes** (v6), tandis que
   * `timeToExpire`/`timeToBlockExpire` repartent en **secondes** (le guard les pose tels quels
   * dans `X-RateLimit-Reset` et `Retry-After`). Une confusion rend la limite inopérante ou
   * quasi permanente.
   */
  it('renvoie des durées en SECONDES à partir d’un TTL en millisecondes', async () => {
    const record = await hit();
    expect(record.timeToExpire).toBe(TTL_MS / 1000);

    for (let i = 0; i < LIMIT; i++) {
      await hit();
    }
    const blocked = await hit();
    expect(blocked.timeToBlockExpire).toBe(BLOCK_MS / 1000);
  });

  it('pose bien un TTL sur le compteur (jamais de clé éternelle)', async () => {
    await hit();
    const key = redis.liveKeys().find((k) => k.startsWith('throttle:hits:'));
    expect(redis.ttlMsOf(key as string)).toBe(TTL_MS);
  });

  it('incrémente et pose le TTL en UNE opération atomique (script Lua)', async () => {
    await hit();

    // Un seul aller-retour : ni fenêtre d'entrelacement entre instances, ni clé laissée sans
    // expiration si le lien tombe entre l'INCR et le PEXPIRE.
    expect(scripted.evaluated).toHaveLength(1);
    expect(scripted.evaluated[0]).toContain('INCR');
    expect(scripted.evaluated[0]).toContain('PEXPIRE');
  });

  it('répare un compteur laissé sans TTL (auto-guérison après crash entre INCR et PEXPIRE)', async () => {
    // Sans cette réparation, le compteur resterait éternel et bloquerait ce tracker définitivement.
    await redis.set(COUNTER_KEY, '2');
    const record = await hit();
    expect(record.totalHits).toBe(3);
    expect(redis.ttlMsOf(COUNTER_KEY)).toBe(TTL_MS);
  });

  it('remonte un 503 si Redis est en panne (fail-closed, jamais « tout passe »)', async () => {
    const broken = new RedisThrottlerStorage(
      new RedisService({
        pttl: () => Promise.reject(new Error('ECONNREFUSED')),
      } as unknown as Redis),
    );
    await expect(
      broken.increment('k', TTL_MS, LIMIT, BLOCK_MS, 'ip'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('remonte un 503 si le script d’incrément échoue (fail-closed)', async () => {
    scripted.eval = () => Promise.reject(new Error('NOSCRIPT'));
    await expect(hit()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('identityTracker', () => {
  it('trace le compte connecté quand la session est résolue', () => {
    expect(
      identityTracker({ clientSession: { user: { userId: 'u-1' } } }),
    ).toBe('user:u-1');
  });

  it('trace l’email du corps quand aucune session n’existe (Checkout invité)', () => {
    expect(identityTracker({ body: { email: 'lea@example.com' } })).toBe(
      'email:lea@example.com',
    );
  });

  it('normalise l’email : casse et espaces ne créent pas deux seaux', () => {
    // Les pipes de validation s'exécutent APRÈS les gardes : l'email arrive brut.
    expect(identityTracker({ body: { email: '  Lea@Example.COM ' } })).toBe(
      'email:lea@example.com',
    );
  });

  /**
   * ⚠️ Sans-quoi le compteur d'identité serait **contournable à volonté** : `alice+1@x.fr`,
   * `alice+2@x.fr`… tombent tous dans la même boîte aux lettres mais produisaient chacun un seau
   * distinct, ne laissant que la limite par IP sur le chemin de conversion.
   */
  it('ignore le sous-adressage « + » : un seul seau par boîte réelle', () => {
    const base = identityTracker({ body: { email: 'alice@x.fr' } });
    expect(identityTracker({ body: { email: 'alice+1@x.fr' } })).toBe(base);
    expect(identityTracker({ body: { email: 'alice+2@x.fr' } })).toBe(base);
    expect(
      identityTracker({ body: { email: 'alice+n importe quoi@x.fr' } }),
    ).toBe(base);
  });

  it('ignore les points de la partie locale chez Gmail (mais pas ailleurs)', () => {
    // Gmail livre a.l.i.c.e@gmail.com et alice@gmail.com dans la même boîte…
    expect(identityTracker({ body: { email: 'a.l.i.c.e@gmail.com' } })).toBe(
      'email:alice@gmail.com',
    );
    expect(identityTracker({ body: { email: 'a.lice@googlemail.com' } })).toBe(
      'email:alice@googlemail.com',
    );
    // …mais chez les autres fournisseurs, deux adresses distinctes = deux personnes distinctes.
    expect(identityTracker({ body: { email: 'a.lice@x.fr' } })).toBe(
      'email:a.lice@x.fr',
    );
  });

  it('n’écrase pas une adresse dont la normalisation viderait la partie locale', () => {
    // `+promo@x.fr` ne doit pas devenir `@x.fr` : tout un domaine partagerait alors un seul seau.
    expect(identityTracker({ body: { email: '+promo@x.fr' } })).toBe(
      'email:+promo@x.fr',
    );
  });

  it('retombe sur l’IP plutôt que sur une clé partagée', () => {
    // Une constante mettrait tous les visiteurs anonymes dans le même seau : le premier abuseur
    // bloquerait tout le monde.
    expect(identityTracker({ ip: '203.0.113.7' })).toBe('ip:203.0.113.7');
  });

  it('privilégie la session sur le corps de la requête', () => {
    expect(
      identityTracker({
        clientSession: { user: { userId: 'u-1' } },
        body: { email: 'autre@example.com' },
      }),
    ).toBe('user:u-1');
  });
});
