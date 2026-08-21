import { createHash, randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { BOOKING_OPTIONS, type BookingOptions } from './booking.constants';
import {
  isCommunicationLocale,
  type CommunicationLocale,
} from './special-requests';

/**
 * **État de tunnel** du domaine `booking` (story 2.4 — FR-9 / FR-14 / AR-6).
 *
 * Quatre responsabilités, toutes portées par Redis (unique magasin d'état du BFF, aucune vérité
 * métier durable — la Réservation appartient au PMS) :
 *
 * 1. **Idempotence de création** — le PMS **ignore** l'en-tête `Idempotency-Key` (constat vérifié
 *    en story 2.3). Sans mémoire côté BFF, un double clic ou un retour arrière créerait une
 *    seconde `Pending` qui gèlerait une seconde chambre.
 * 2. **Verrou de chambre** — `RoomReservationService.CreateAsync` fait un *check-then-insert* sans
 *    transaction sérialisée : deux créations concurrentes sur la même chambre peuvent aboutir
 *    toutes les deux. Le verrou les sérialise **côté BFF** (repli documenté de la dépendance D3 ;
 *    une création venue du back-office y échappe par construction).
 * 3. **Hold de checkout** — le PMS ne sait pas « tenir » une chambre : c'est la `Pending` qui
 *    l'immobilise. Le hold est donc la **promesse de libération** du BFF : une entrée horodatée
 *    plus un index trié que le balayeur consomme (`checkout-hold.sweeper.ts`).
 * 4. **Intention de création** (correctif D1) — enregistrée **avant** le POST au PMS. Si la réponse
 *    se perd (timeout, coupure, 5xx, breaker), le BFF ignore si la ligne a été insérée : la
 *    `Pending` éventuelle n'a ni identifiant connu, ni hold, ni entrée d'index — elle gèlerait une
 *    vraie chambre pour toujours, et le rejeu en créerait une seconde. L'intention est la trace qui
 *    permet au balayeur d'aller la chercher et de l'annuler.
 *
 * ## Atomicité (revue 2.4)
 *
 * Les séquences « enregistrement + index » et « lecture + modification + réécriture » passent par
 * des **scripts Lua** : Redis les exécute en un seul pas, donc sans état intermédiaire observable.
 * Sans cela :
 * - un `ZADD` en échec après un `SET` réussi produit un hold **hors index** — une chambre gelée
 *   sans aucun filet, invisible du balayeur ;
 * - deux `read`/`write` concurrents sur l'enregistrement entier **perdent** la mise à jour du
 *   second : `paymentStarted`, seul rempart de FR-14, peut être écrasé par un simple report de
 *   tentative du balayeur.
 *
 * ⚠️ **Toute panne Redis remonte en 503**, jamais en 500 (règle de la revue 2.1) : le magasin
 * d'état indisponible est une **indisponibilité de service**, pas un bug applicatif — et le front
 * distingue les deux (« réessayer » n'a de sens que sur le premier).
 *
 * À la livraison de la dépendance **D3** (expiration + atomicité côté PMS), ce service devient
 * redondant : il est volontairement isolé pour que son retrait soit trivial.
 */

/** Convention de nommage des clés Redis du dépôt : `<domaine>:<objet>:v1:<clé>`. */
export const HOLD_KEY_PREFIX = 'booking:hold:v1:';
export const HOLD_INDEX_KEY = 'booking:holds:v1';
export const IDEMPOTENCY_KEY_PREFIX = 'booking:idem:v1:';
export const STAY_LOCK_PREFIX = 'booking:lock:v1:';
export const SWEEPER_LOCK_KEY = 'booking:sweeper:lock:v1';
/** Enregistrement d'**intention de création** (correctif D1). */
export const INTENT_KEY_PREFIX = 'booking:intent:v1:';
/**
 * Langue de communication choisie au checkout (story 2.5, FR-10) — **clé propre**, délibérément
 * dissociée du hold (revue 2ᵉ passe, F7).
 *
 * ⚠️ Elle vivait d'abord sur `CheckoutHoldRecord`, ce qui liait sa durée de vie à celle du hold
 * (15 min + 1 h de sursis). Trois conséquences, toutes fausses vis-à-vis de ce que l'écran promet
 * (« enregistré avec votre réservation ») :
 * - le balayeur `release()` supprimait la clé du hold → la préférence disparaissait de l'écran ;
 * - un hold marqué `paymentStarted`, que le balayeur épargne, voyait quand même sa clé **expirer** ;
 * - la story 3.2 (confirmation) pouvait donc confirmer **sans** la langue, alors que AC-3 lui
 *   promet de pouvoir la lire.
 *
 * Le choix suit désormais la **Réservation**, pas la tenue de chambre : il survit à la libération du
 * hold et couvre la fenêtre d'expiration des `Pending` (dépendance D3, 48 h).
 */
export const COMM_LOCALE_KEY_PREFIX = 'booking:comm-locale:v1:';
/** Préfixe du membre d'index ZSET distinguant une intention d'un hold. */
export const INTENT_MEMBER_PREFIX = 'intent:';

/**
 * Suppression **compare-and-delete** : ne supprime que si la valeur est celle attendue.
 *
 * Deux usages, un même invariant « ne détruis que ce que tu as posé » : la libération d'un verrou
 * par son propriétaire, et la purge d'une clé d'idempotence par la réservation qu'elle désigne.
 */
export const COMPARE_AND_DELETE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Écrit un enregistrement TTLé **et** son entrée d'index, sans état intermédiaire observable. */
export const WRITE_AND_INDEX_SCRIPT = `redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('zadd', KEYS[2], ARGV[3], ARGV[4])
return 1`;

/** Installe le hold + son index **et** retire l'intention + son membre d'index, en un seul pas. */
export const PROMOTE_INTENT_SCRIPT = `redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('zadd', KEYS[2], ARGV[3], ARGV[4])
redis.call('del', KEYS[3])
redis.call('zrem', KEYS[2], ARGV[5])
return 1`;

/** Retire un enregistrement **et** son membre d'index. */
export const DROP_INDEXED_SCRIPT = `redis.call('del', KEYS[1])
redis.call('zrem', KEYS[2], ARGV[1])
return 1`;

/**
 * Pose `paymentStarted` **sans lire-modifier-réécrire côté client** : la modification de champ
 * s'exécute dans Redis, donc aucun report de tentative concurrent ne peut l'écraser (FR-14).
 */
export const MARK_PAYMENT_STARTED_SCRIPT = `local raw = redis.call('get', KEYS[1])
if not raw then return 0 end
local ok, record = pcall(cjson.decode, raw)
if not ok then return -1 end
record.paymentStarted = true
redis.call('set', KEYS[1], cjson.encode(record), 'EX', ARGV[1])
return 1`;

/**
 * Retire `paymentStarted`, en un seul pas Redis — miroir exact de la pose.
 *
 * Renvoie `1` si le drapeau a été retiré, `0` si l'enregistrement n'existe pas (rien à faire),
 * `-1` s'il est illisible.
 */
export const CLEAR_PAYMENT_STARTED_SCRIPT = `local raw = redis.call('get', KEYS[1])
if not raw then return 0 end
local ok, record = pcall(cjson.decode, raw)
if not ok then return -1 end
record.paymentStarted = false
redis.call('set', KEYS[1], cjson.encode(record), 'EX', ARGV[1])
return 1`;

/**
 * Incrémente `attempts` **et** repousse le score d'index en un seul pas.
 *
 * Les deux vivaient dans deux appels distincts : un échec du second laissait le compteur
 * incrémenté sans report (ou l'inverse). Ici l'échec est total ou nul, et le compteur ne peut plus
 * être écrasé par une mise à jour concurrente du même enregistrement.
 */
export const COUNT_AND_RESCHEDULE_SCRIPT = `local raw = redis.call('get', KEYS[1])
if not raw then
  redis.call('zrem', KEYS[2], ARGV[3])
  return -2
end
local ok, record = pcall(cjson.decode, raw)
if not ok then
  redis.call('zrem', KEYS[2], ARGV[3])
  return -1
end
record.attempts = (tonumber(record.attempts) or 0) + 1
redis.call('set', KEYS[1], cjson.encode(record), 'EX', ARGV[1])
redis.call('zadd', KEYS[2], ARGV[2], ARGV[3])
return record.attempts`;

/**
 * Empreinte d'un séjour pour un compte donné — clé d'idempotence de la création.
 *
 * Le **compte** en fait partie : deux voyageurs ne doivent jamais partager une réservation. Le
 * **verrou**, lui, ignore volontairement le compte *et* les dates (voir `stayLockKey`) : il protège
 * l'inventaire, pas l'appelant.
 */
export interface StayFingerprint {
  userId: string;
  roomId: string;
  checkInDate: string;
  checkOutDate: string;
  guests: number;
}

/**
 * Enregistrement de hold — **aucune donnée directement identifiante, aucun contenu utilisateur**.
 *
 * ⚠️ Formulation resserrée en revue (F16) : l'ancienne disait « aucune PII, aucun jeton », ce qui
 * était déjà faux à l'écriture. L'enregistrement porte `sid` — que `withCustomerAuth` convertit en
 * jeton porteur PMS, donc fonctionnellement un porte-jeton — et `userId`, une donnée personnelle
 * pseudonymisée. Le risque marginal est faible (les sessions vivent dans le même Redis), mais une
 * affirmation trop large invite un futur relecteur à y ajouter un champ « puisqu'il n'y a de toute
 * façon rien de sensible ici » : exactement le raisonnement que cet encadré doit interdire.
 *
 * Ce qui est **réellement** exclu, et doit le rester : le **contenu saisi par le voyageur**. Les
 * demandes spéciales (story 2.5) sont un texte libre susceptible de contenir des données de santé,
 * d'accessibilité ou alimentaires (RGPD art. 9). Elles transitent dans le corps HTTP vers le PMS et
 * ne sont **jamais** écrites ici — ni ailleurs dans Redis.
 */
export interface CheckoutHoldRecord {
  reservationId: string;
  /** Session propriétaire : indispensable au balayeur, l'annulation PMS exigeant son JWT. */
  sid: string;
  userId: string;
  hotelId: string;
  roomId: string;
  /** Échéance du hold (ms epoch). */
  expiresAt: number;
  /** Empreinte du séjour — permet de purger la clé d'idempotence à la libération. */
  stayKey: string;
  /** Posé par la story 3.1 dès qu'un paiement est engagé : le balayeur n'y touche plus (FR-14). */
  paymentStarted: boolean;
  /** Nombre de passes de balayage infructueuses. */
  attempts: number;
}

/**
 * Enregistrement d'**intention de création** (correctif D1) — écrit avant le POST au PMS.
 *
 * Il porte tout ce dont le balayeur a besoin pour **retrouver** une réservation dont l'identifiant
 * ne nous est jamais parvenu : la session propriétaire (l'endpoint de liste est réservé au
 * `Customer`) et l'empreinte du séjour (chambre + dates) qui l'identifie côté PMS.
 */
export interface CreateIntentRecord {
  intentId: string;
  sid: string;
  userId: string;
  hotelId: string;
  roomId: string;
  /** `AAAA-MM-JJ`. */
  checkInDate: string;
  checkOutDate: string;
  guests: number;
  /** Clé d'idempotence complète, pour purge à la réconciliation. */
  stayKey: string;
  /** Échéance de réconciliation (ms epoch) — score d'index. */
  reconcileAt: number;
  attempts: number;
}

export interface RegisterHoldInput {
  reservationId: string;
  sid: string;
  userId: string;
  hotelId: string;
  roomId: string;
  expiresAt: number;
  stay: StayFingerprint;
}

export interface RegisterIntentInput {
  intentId: string;
  sid: string;
  userId: string;
  hotelId: string;
  roomId: string;
  stay: StayFingerprint;
}

@Injectable()
export class CheckoutHoldService {
  private readonly logger = new Logger(CheckoutHoldService.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(BOOKING_OPTIONS) private readonly options: BookingOptions,
  ) {}

  /**
   * Durée de vie de l'**enregistrement** (secondes) : hold + sursis.
   *
   * Strictement supérieure au hold — le balayeur lit l'enregistrement **après** l'échéance.
   */
  get recordTtlSeconds(): number {
    return this.options.holdTtlSeconds + this.options.holdRecordGraceSeconds;
  }

  // --- Idempotence de création (AC-5) ------------------------------------------------------

  async readIdempotent(stay: StayFingerprint): Promise<string | null> {
    return this.guard(() => this.redis.get(this.idempotencyKey(stay)));
  }

  async writeIdempotent(
    stay: StayFingerprint,
    reservationId: string,
  ): Promise<void> {
    await this.guard(() =>
      this.redis.set(
        this.idempotencyKey(stay),
        reservationId,
        this.recordTtlSeconds,
      ),
    );
  }

  /**
   * Purge la mémoire d'idempotence.
   *
   * Appelée quand la réservation mémorisée n'est plus exploitable (libérée par le balayeur,
   * annulée en compensation, ou trouvée dans un statut terminal) : sans cela, un rejeu de création
   * renverrait au voyageur une réservation **annulée** comme si elle était la sienne.
   *
   * `expected` déclenche un **compare-and-delete** : la clé est dérivée du séjour, pas de la
   * réservation, si bien qu'une purge aveugle effacerait la mémoire d'une réservation *vivante*
   * recréée entre-temps pour le même séjour — et le clic suivant en créerait une troisième.
   */
  async clearIdempotent(
    stay: StayFingerprint,
    expected?: string,
  ): Promise<void> {
    await this.clearIdempotentKey(this.idempotencyKey(stay), expected);
  }

  /**
   * Purge une clé d'idempotence **déjà résolue** (mémorisée dans un hold ou une intention).
   *
   * Sans `expected`, la suppression est inconditionnelle : à n'utiliser que lorsque aucune
   * réservation vivante ne peut légitimement occuper la clé.
   */
  async clearIdempotentKey(stayKey: string, expected?: string): Promise<void> {
    if (expected === undefined) {
      await this.guard(() => this.redis.del(stayKey));
      return;
    }
    await this.guard(() =>
      this.redis.raw.eval(COMPARE_AND_DELETE_SCRIPT, 1, stayKey, expected),
    );
  }

  // --- Verrou de chambre (AC-4) ------------------------------------------------------------

  /** Renvoie le jeton de propriété du verrou, ou `null` si un autre appel le détient déjà. */
  async acquireStayLock(stay: StayFingerprint): Promise<string | null> {
    const token = randomUUID();
    const acquired = await this.guard(() =>
      this.redis.raw.set(
        this.stayLockKey(stay),
        token,
        'PX',
        this.options.stayLockTtlMs,
        'NX',
      ),
    );
    return acquired === 'OK' ? token : null;
  }

  /** Libère le verrou **si et seulement si** l'appelant en est le propriétaire. */
  async releaseStayLock(stay: StayFingerprint, token: string): Promise<void> {
    try {
      await this.redis.raw.eval(
        COMPARE_AND_DELETE_SCRIPT,
        1,
        this.stayLockKey(stay),
        token,
      );
    } catch {
      // Best-effort : le verrou expire de lui-même (PX) — ne jamais masquer l'erreur d'origine
      // d'un appel de création qui, lui, a peut-être réussi.
      this.logger.warn(
        'Libération du verrou de chambre impossible (le TTL prendra le relais).',
      );
    }
  }

  // --- Hold de checkout (AC-6 / AC-7) ------------------------------------------------------

  /** Enregistre le hold **et** son entrée d'index atomiquement (jamais de hold hors index). */
  async register(input: RegisterHoldInput): Promise<void> {
    const record = this.toHoldRecord(input);
    await this.guard(() =>
      this.redis.raw.eval(
        WRITE_AND_INDEX_SCRIPT,
        2,
        HOLD_KEY_PREFIX + record.reservationId,
        HOLD_INDEX_KEY,
        JSON.stringify(record),
        this.recordTtlSeconds,
        record.expiresAt,
        record.reservationId,
      ),
    );
  }

  async read(reservationId: string): Promise<CheckoutHoldRecord | null> {
    return this.readRecord<CheckoutHoldRecord>(
      HOLD_KEY_PREFIX + reservationId,
      `hold de la réservation ${reservationId}`,
    );
  }

  /**
   * Libère un hold : enregistrement, index **et** clé d'idempotence.
   *
   * Idempotente — un hold déjà retiré n'est pas une erreur (le balayeur peut repasser).
   *
   * ⚠️ La clé d'idempotence part en **compare-and-delete** : elle est dérivée du séjour, pas de la
   * réservation. Le balayeur libérant une R1 annulée effacerait sinon la mémoire d'une R2 encore
   * vivante recréée pour le même séjour — et le clic suivant du voyageur créerait une R3.
   */
  async release(reservationId: string): Promise<void> {
    const record = await this.read(reservationId);
    await this.guard(() =>
      this.redis.raw.eval(
        DROP_INDEXED_SCRIPT,
        2,
        HOLD_KEY_PREFIX + reservationId,
        HOLD_INDEX_KEY,
        reservationId,
      ),
    );
    if (record?.stayKey) {
      await this.clearIdempotentKey(record.stayKey, reservationId);
    }
  }

  /** Retire l'entrée d'index sans toucher à l'enregistrement (purge d'orphelin). */
  async forget(reservationId: string): Promise<void> {
    await this.guard(() => this.redis.raw.zrem(HOLD_INDEX_KEY, reservationId));
  }

  /**
   * Marque un paiement engagé — **seam de la story 3.1**.
   *
   * Un hold ainsi marqué n'est plus jamais balayé automatiquement : annuler une réservation dont
   * le paiement est en cours est l'incident que FR-14 interdit formellement. La modification est
   * appliquée **dans Redis** : un report de tentative concurrent du balayeur ne peut plus la
   * perdre en réécrivant l'enregistrement entier.
   */
  async markPaymentStarted(reservationId: string): Promise<void> {
    const applied = await this.guard(() =>
      this.redis.raw.eval(
        MARK_PAYMENT_STARTED_SCRIPT,
        1,
        HOLD_KEY_PREFIX + reservationId,
        this.recordTtlSeconds,
      ),
    );

    // ⚠️ Le script renvoie `0` (enregistrement absent) ou `-1` (JSON illisible) — deux cas où le
    // drapeau n'a PAS été posé. Ils étaient ignorés : le `clientSecret` partait alors que
    // l'invariant FR-14 n'était pas établi, et l'endpoint répondait 200. Seul un plantage Redis
    // remontait. Trouvé en revue de code 3.1.
    if (applied !== 1) {
      this.logger.error(
        `Gel de paiement impossible pour la réservation ${reservationId} ` +
          `(enregistrement de hold absent ou illisible).`,
      );
      throw new ServiceUnavailableException(
        'Service de réservation momentanément indisponible.',
      );
    }
  }

  /**
   * Retire le drapeau `paymentStarted` — **uniquement** quand il est prouvé qu'aucun paiement ne
   * peut exister (revue de code 3.1).
   *
   * Le gel est posé avant l'appel au PMS, ce qui est le seul instant sûr (FR-14). Mais un refus
   * déterministe du PMS — devise non encaissable, réservation plus en attente — laissait la chambre
   * immobilisée pour toujours, le balayeur ne touchant plus jamais un hold marqué. Le retrait suit
   * le même patron atomique que la pose : la modification s'exécute dans Redis.
   */
  async clearPaymentStarted(reservationId: string): Promise<void> {
    await this.guard(() =>
      this.redis.raw.eval(
        CLEAR_PAYMENT_STARTED_SCRIPT,
        1,
        HOLD_KEY_PREFIX + reservationId,
        this.recordTtlSeconds,
      ),
    );
  }

  /**
   * Reporte un hold dont la libération a échoué, en comptant la tentative.
   *
   * Renvoie le nombre de tentatives cumulées, ou `null` si l'enregistrement a disparu (l'entrée
   * d'index est alors retirée : plus rien à reporter).
   */
  async reschedule(
    reservationId: string,
    nextAt: number,
  ): Promise<number | null> {
    return this.countAndReschedule(
      HOLD_KEY_PREFIX + reservationId,
      reservationId,
      nextAt,
    );
  }

  /**
   * Membres échus à `now`, au plus `limit` (ordre : le plus ancien d'abord).
   *
   * ⚠️ L'index mêle **holds** (membre = identifiant de réservation) et **intentions** (membre
   * préfixé `intent:`) : c'est ce qui garantit qu'une seule passe, un seul verrou et un seul lot
   * couvrent les deux. L'appelant discrimine sur le préfixe.
   */
  async dueHolds(now: number, limit: number): Promise<string[]> {
    return this.guard(() =>
      this.redis.raw.zrangebyscore(
        HOLD_INDEX_KEY,
        '-inf',
        now,
        'LIMIT',
        0,
        limit,
      ),
    );
  }

  // --- Langue de communication (story 2.5, FR-10) -------------------------------------------

  /**
   * Mémorise la langue choisie **pour la Réservation**, hors du hold (voir `COMM_LOCALE_KEY_PREFIX`).
   *
   * Sans effet si `locale` est `null` : aucune clé n'est écrite, et « aucun choix exprimé » reste un
   * état représentable — c'est ce que le front oppose désormais via son drapeau `touched`.
   */
  async writeCommunicationLocale(
    reservationId: string,
    locale: CommunicationLocale | null,
  ): Promise<void> {
    if (locale === null) {
      return;
    }
    await this.guard(() =>
      this.redis.set(
        COMM_LOCALE_KEY_PREFIX + reservationId,
        locale,
        this.options.communicationLocaleTtlSeconds,
      ),
    );
  }

  /** Langue mémorisée, ou `null` — y compris pour une valeur illisible ou d'une version antérieure. */
  async readCommunicationLocale(
    reservationId: string,
  ): Promise<CommunicationLocale | null> {
    const raw = await this.guard(() =>
      this.redis.get(COMM_LOCALE_KEY_PREFIX + reservationId),
    );
    return isCommunicationLocale(raw) ? raw : null;
  }

  // --- Intention de création (correctif D1) ------------------------------------------------

  /**
   * Enregistre l'intention **avant** le POST de création, avec son entrée d'index (atomique).
   *
   * Le score est volontairement lointain (`intentReconcileDelayMs`) : réconcilier une requête
   * encore en vol ferait annuler une réservation que le voyageur voit apparaître.
   */
  async registerIntent(input: RegisterIntentInput): Promise<void> {
    const record: CreateIntentRecord = {
      intentId: input.intentId,
      sid: input.sid,
      userId: input.userId,
      hotelId: input.hotelId,
      roomId: input.roomId,
      checkInDate: input.stay.checkInDate,
      checkOutDate: input.stay.checkOutDate,
      guests: input.stay.guests,
      stayKey: this.idempotencyKey(input.stay),
      reconcileAt: Date.now() + this.options.intentReconcileDelayMs,
      attempts: 0,
    };
    await this.guard(() =>
      this.redis.raw.eval(
        WRITE_AND_INDEX_SCRIPT,
        2,
        INTENT_KEY_PREFIX + record.intentId,
        HOLD_INDEX_KEY,
        JSON.stringify(record),
        this.recordTtlSeconds,
        record.reconcileAt,
        intentMember(record.intentId),
      ),
    );
  }

  async readIntent(intentId: string): Promise<CreateIntentRecord | null> {
    return this.readRecord<CreateIntentRecord>(
      INTENT_KEY_PREFIX + intentId,
      `intention de création ${intentId}`,
    );
  }

  /**
   * Atomique : installe le hold + son index **et** retire l'intention + son membre d'index.
   *
   * Remplace `register` sur le chemin nominal. En deux appels séparés, une panne entre les deux
   * laisserait soit un hold sans intention retirée (le balayeur irait chercher une réservation
   * déjà suivie), soit une intention sans hold (la `Pending` ne serait libérée qu'à la
   * réconciliation, bien après l'échéance promise au voyageur).
   */
  async promoteIntent(
    intentId: string,
    input: RegisterHoldInput,
  ): Promise<void> {
    const record = this.toHoldRecord(input);
    await this.guard(() =>
      this.redis.raw.eval(
        PROMOTE_INTENT_SCRIPT,
        3,
        HOLD_KEY_PREFIX + record.reservationId,
        HOLD_INDEX_KEY,
        INTENT_KEY_PREFIX + intentId,
        JSON.stringify(record),
        this.recordTtlSeconds,
        record.expiresAt,
        record.reservationId,
        intentMember(intentId),
      ),
    );
  }

  /** Retire l'enregistrement d'intention et son membre d'index. */
  async dropIntent(intentId: string): Promise<void> {
    await this.guard(() =>
      this.redis.raw.eval(
        DROP_INDEXED_SCRIPT,
        2,
        INTENT_KEY_PREFIX + intentId,
        HOLD_INDEX_KEY,
        intentMember(intentId),
      ),
    );
  }

  /**
   * Reporte la réconciliation d'une intention, en comptant la tentative.
   *
   * Renvoie le nombre de tentatives cumulées, ou `null` si l'intention a disparu.
   */
  async rescheduleIntent(
    intentId: string,
    nextAt: number,
  ): Promise<number | null> {
    return this.countAndReschedule(
      INTENT_KEY_PREFIX + intentId,
      intentMember(intentId),
      nextAt,
    );
  }

  // --- Verrou d'exécution du balayeur ------------------------------------------------------

  /** Empêche deux instances BFF de balayer (donc d'annuler) les mêmes réservations en parallèle. */
  async acquireSweeperLock(ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const acquired = await this.guard(() =>
      this.redis.raw.set(SWEEPER_LOCK_KEY, token, 'PX', ttlMs, 'NX'),
    );
    return acquired === 'OK' ? token : null;
  }

  async releaseSweeperLock(token: string): Promise<void> {
    try {
      await this.redis.raw.eval(
        COMPARE_AND_DELETE_SCRIPT,
        1,
        SWEEPER_LOCK_KEY,
        token,
      );
    } catch {
      this.logger.warn(
        'Libération du verrou de balayage impossible (le TTL prendra le relais).',
      );
    }
  }

  // --- Interne -----------------------------------------------------------------------------

  private toHoldRecord(input: RegisterHoldInput): CheckoutHoldRecord {
    return {
      reservationId: input.reservationId,
      sid: input.sid,
      userId: input.userId,
      hotelId: input.hotelId,
      roomId: input.roomId,
      expiresAt: input.expiresAt,
      stayKey: this.idempotencyKey(input.stay),
      paymentStarted: false,
      attempts: 0,
    };
  }

  /** Lecture JSON tolérante : un enregistrement corrompu est traité comme absent, mais logué. */
  private async readRecord<T>(key: string, label: string): Promise<T | null> {
    const raw = await this.guard(() => this.redis.get(key));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Enregistrement corrompu : traité comme absent plutôt que de faire échouer une passe.
      this.logger.warn(`Enregistrement illisible (${label}) — ignoré.`);
      return null;
    }
  }

  /** Incrément de tentative + report d'échéance, en un seul pas Redis. */
  private async countAndReschedule(
    key: string,
    member: string,
    nextAt: number,
  ): Promise<number | null> {
    const attempts = await this.guard(() =>
      this.redis.raw.eval(
        COUNT_AND_RESCHEDULE_SCRIPT,
        2,
        key,
        HOLD_INDEX_KEY,
        this.recordTtlSeconds,
        nextAt,
        member,
      ),
    );
    return typeof attempts === 'number' && attempts > 0 ? attempts : null;
  }

  private idempotencyKey(stay: StayFingerprint): string {
    return (
      IDEMPOTENCY_KEY_PREFIX +
      digest(
        [
          stay.userId,
          stay.roomId,
          stay.checkInDate,
          stay.checkOutDate,
          String(stay.guests),
        ].join('|'),
      )
    );
  }

  /**
   * Clé de verrou : **la chambre seule**, sans le compte ni les dates.
   *
   * C'est l'inventaire que l'on protège, pas l'appelant : deux voyageurs différents visant la même
   * chambre sont exactement le cas de double-booking à sérialiser.
   *
   * ⚠️ Les dates en sont volontairement **absentes** (correctif de la revue 2.4). Une clé
   * (chambre, dates) est un hash **exact** : `09-01→09-03` et `09-02→09-04` produisent deux
   * verrous distincts alors qu'ils **se chevauchent** — soit précisément la collision que le PMS,
   * dépourvu d'atomicité (D3), peut accepter deux fois. Verrouiller la chambre entière sérialise
   * tout chevauchement ; le surcoût de contention est borné par la durée d'une seule création et
   * reste très inférieur au coût d'un double-booking réel.
   */
  private stayLockKey(stay: StayFingerprint): string {
    return STAY_LOCK_PREFIX + digest(stay.roomId);
  }

  /**
   * Exécute une opération Redis en convertissant toute panne en **503**.
   *
   * Sans cette conversion, l'exception ioredis brute tombe dans la branche par défaut du filtre
   * global → 500, que le front interprète comme un bug (revue 2.1).
   */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      this.logger.error(
        `Magasin d'état du tunnel indisponible : ${err instanceof Error ? err.message : 'erreur inconnue'}`,
      );
      throw new ServiceUnavailableException(
        'Service de réservation momentanément indisponible.',
      );
    }
  }
}

/** Membre d'index d'une intention — distinct d'un identifiant de réservation par construction. */
function intentMember(intentId: string): string {
  return INTENT_MEMBER_PREFIX + intentId;
}

function digest(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}
