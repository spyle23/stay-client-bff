/**
 * Faux client Redis **fidèle** pour les tests unitaires (stories 2.4+).
 *
 * Vit sous `test/` (exclu du build) et non sous `src/`, pour ne jamais partir en production.
 *
 * ⚠️ **Pourquoi une implémentation fidèle plutôt qu'un `jest.fn()` permissif** : la revue de la
 * story 2.1 a montré qu'un faux client qui accepte tout **valide du code faux**. Un verrou posé
 * sans `NX` semble fonctionner, une clé écrite sans TTL semble expirer, un `ZADD` ignoré fait
 * passer un balayeur qui n'indexe rien. Ce double honore donc réellement :
 * - `SET k v [EX s | PX ms] [NX]` (dont l'échec de `NX` sur clé existante → `null`) ;
 * - l'expiration (horloge injectable, pas de `setTimeout`) ;
 * - `EVAL` du script de libération compare-and-delete ;
 * - les commandes de tri (`ZADD`/`ZRANGEBYSCORE`/`ZREM`/`ZCARD`) ;
 * - `INCR` / `PEXPIRE ... NX` / `PTTL` (stockage du throttler).
 */

interface Entry {
  value: string;
  /** Échéance absolue (ms epoch), ou `null` si la clé n'expire pas. */
  expiresAt: number | null;
}

export class FakeRedis {
  private readonly strings = new Map<string, Entry>();
  private readonly sortedSets = new Map<string, Map<string, number>>();
  /** Horloge injectable — les tests avancent le temps sans attendre. */
  now = 0;

  /** Avance l'horloge du double (les clés échues deviennent invisibles). */
  advance(ms: number): void {
    this.now += ms;
  }

  private alive(key: string): Entry | undefined {
    const entry = this.strings.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.alive(key)?.value ?? null);
  }

  set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    const tokens = args.map((a) => String(a));
    const upper = tokens.map((t) => t.toUpperCase());

    if (upper.includes('NX') && this.alive(key)) {
      return Promise.resolve(null);
    }

    let expiresAt: number | null = null;
    const ex = upper.indexOf('EX');
    const px = upper.indexOf('PX');
    if (ex >= 0) {
      expiresAt = this.now + Number(tokens[ex + 1]) * 1000;
    } else if (px >= 0) {
      expiresAt = this.now + Number(tokens[px + 1]);
    }

    this.strings.set(key, { value, expiresAt });
    return Promise.resolve('OK');
  }

  del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) {
        removed++;
      }
      if (this.sortedSets.delete(key)) {
        removed++;
      }
    }
    return Promise.resolve(removed);
  }

  incr(key: string): Promise<number> {
    const current = Number(this.alive(key)?.value ?? '0');
    const next = current + 1;
    // INCR conserve le TTL existant (comportement Redis).
    const expiresAt = this.alive(key)?.expiresAt ?? null;
    this.strings.set(key, { value: String(next), expiresAt });
    return Promise.resolve(next);
  }

  pexpire(key: string, ms: number, mode?: string): Promise<number> {
    const entry = this.alive(key);
    if (!entry) {
      return Promise.resolve(0);
    }
    if (mode?.toUpperCase() === 'NX' && entry.expiresAt !== null) {
      return Promise.resolve(0);
    }
    entry.expiresAt = this.now + ms;
    return Promise.resolve(1);
  }

  pttl(key: string): Promise<number> {
    const entry = this.alive(key);
    if (!entry) {
      return Promise.resolve(-2);
    }
    return Promise.resolve(
      entry.expiresAt === null ? -1 : entry.expiresAt - this.now,
    );
  }

  zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    const isNew = !set.has(member);
    set.set(member, Number(score));
    this.sortedSets.set(key, set);
    return Promise.resolve(isNew ? 1 : 0);
  }

  zrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
    ...args: unknown[]
  ): Promise<string[]> {
    const set = this.sortedSets.get(key);
    if (!set) {
      return Promise.resolve([]);
    }
    const lo = min === '-inf' ? Number.NEGATIVE_INFINITY : Number(min);
    const hi = max === '+inf' ? Number.POSITIVE_INFINITY : Number(max);
    let members = [...set.entries()]
      .filter(([, score]) => score >= lo && score <= hi)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);

    const tokens = args.map((a) => String(a).toUpperCase());
    const limitAt = tokens.indexOf('LIMIT');
    if (limitAt >= 0) {
      const offset = Number(args[limitAt + 1]);
      const count = Number(args[limitAt + 2]);
      members = members.slice(offset, offset + count);
    }
    return Promise.resolve(members);
  }

  zrem(key: string, ...members: string[]): Promise<number> {
    const set = this.sortedSets.get(key);
    if (!set) {
      return Promise.resolve(0);
    }
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) {
        removed++;
      }
    }
    return Promise.resolve(removed);
  }

  zcard(key: string): Promise<number> {
    return Promise.resolve(this.sortedSets.get(key)?.size ?? 0);
  }

  /** Supporte le script compare-and-delete du dépôt (`GET` puis `DEL` si propriétaire). */
  eval(
    _script: string,
    _numKeys: number,
    key: string,
    token: string,
  ): Promise<number> {
    if (this.alive(key)?.value === token) {
      this.strings.delete(key);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }

  ping(): Promise<string> {
    return Promise.resolve('PONG');
  }

  quit(): Promise<string> {
    return Promise.resolve('OK');
  }

  disconnect(): void {
    /* no-op */
  }

  /** Introspection de test : nombre de clés vivantes (hors ensembles triés). */
  liveKeys(): string[] {
    return [...this.strings.keys()].filter(
      (key) => this.alive(key) !== undefined,
    );
  }

  /** Introspection de test : TTL restant en ms, ou `null` si la clé n'expire pas. */
  ttlMsOf(key: string): number | null {
    const entry = this.alive(key);
    if (!entry) {
      return null;
    }
    return entry.expiresAt === null ? null : entry.expiresAt - this.now;
  }
}
