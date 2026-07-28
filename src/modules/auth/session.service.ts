import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CorrelationService } from '../../common/correlation/correlation.service';
import type { ApiResponse } from '../../integration/pms/api-response.types';
import type { PmsRequestContext } from '../../integration/pms/pms-client.service';
import { PmsClientService } from '../../integration/pms/pms-client.service';
import { PmsRequestError } from '../../integration/pms/pms-errors';
import { RedisService } from '../../redis/redis.service';
import {
  AUTH_OPTIONS,
  type AuthOptions,
  CUSTOMER_ROLE,
  REFRESH_LOCK_PREFIX,
  SESSION_KEY_PREFIX,
} from './auth.constants';
import { generateGuestPassword } from './guest-password';
import { generateSessionId } from './session-cookie';

/**
 * Custody des jetons `Customer` (story 2.1 — AR-9 / NFR-8 / FR-19).
 *
 * Invariants :
 * - les JWT PMS **ne quittent jamais le serveur** : ils vivent dans Redis, indexés par un `sid`
 *   opaque ; aucune méthode publique ne les renvoie à l'appelant HTTP ;
 * - `withCustomerAuth` est **le seul** chemin d'appel PMS authentifié : il gère 401 → refresh →
 *   rejeu unique → sinon destruction de session ;
 * - le refresh est **single-flight** (obligatoire, pas optimisation) : le PMS **révoque** l'ancien
 *   refresh token avant d'en émettre un nouveau (`AuthService.RefreshTokenAsync`), donc deux
 *   refresh concurrents feraient échouer le second en 400 et déconnecteraient l'utilisateur.
 *
 * Redis est l'unique magasin d'état (AR-6) : aucune vérité métier durable, TTL systématique.
 */

/** Endpoints d'auth du PMS (`Stay-api`). ⚠️ Le refresh est `refresh-token`, pas `refresh`. */
export const PMS_AUTH_ENDPOINTS = {
  login: '/auth/login',
  registerCustomer: '/auth/register/customer',
  refreshToken: '/auth/refresh-token',
  logout: '/auth/logout',
} as const;

/** Coordonnées collectées au Checkout invité (story 2.3 — FR-8). */
export interface GuestIdentityInput {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
}

/**
 * L'email fourni en Checkout invité correspond déjà à un compte PMS.
 *
 * Erreur **typée** plutôt qu'un test de message dans le contrôleur : le PMS n'expose aucun code
 * d'erreur distinct (`AuthService.RegisterCustomerAsync` renvoie un simple `Result.Failure`
 * textuel → 400), la reconnaissance est donc fragile et doit vivre en **un seul endroit**, testé.
 */
export class GuestEmailConflictError extends Error {
  constructor() {
    super('Un compte existe déjà avec cette adresse email.');
    this.name = 'GuestEmailConflictError';
  }
}

/**
 * Code machine porté par le corps d'erreur quand le compte PMS a été créé mais que la session
 * n'a pas pu être ouverte. Le front s'en sert pour ne PAS proposer de réessayer avec la même
 * adresse — ce rejeu se heurterait au 409 d'un compte que personne ne peut ouvrir.
 */
export const GUEST_ACCOUNT_ORPHANED_CODE = 'guest-account-created';

const EMAIL_TAKEN_PATTERN = /email\s+is\s+already\s+registered/i;

/**
 * Reconnaît le refus d'unicité d'email du PMS (`AuthService.cs:69`).
 *
 * ⚠️ Le motif se trouve dans **`errors`**, pas dans `message` : `ApiBadRequest` du PMS sérialise
 * `{"success":false,"message":null,"errors":["Email is already registered."]}` — vérifié en
 * conditions réelles. Ne tester que `err.message` reviendrait à lire « Le PMS a renvoyé le statut
 * 400 » (libellé par défaut du client HTTP) et à ne **jamais** détecter la collision. On balaie
 * donc les deux, sous les deux formes d'`errors` (tableau ou dictionnaire par champ).
 *
 * Tout autre 400 est une **validation refusée** (nom vide, email malformé, mot de passe hors
 * politique) : le confondre avec une collision enverrait le voyageur se connecter à un compte
 * qui n'existe pas.
 */
function isEmailAlreadyRegistered(err: unknown): boolean {
  if (!(err instanceof PmsRequestError) || err.status !== 400) {
    return false;
  }
  const messages = [err.message, ...flattenPmsErrors(err.errors)];
  return messages.some((text) => EMAIL_TAKEN_PATTERN.test(text));
}

/** Aplatit `errors` du PMS, qu'il soit un tableau de messages ou un dictionnaire par champ. */
function flattenPmsErrors(
  errors: Record<string, string[]> | string[] | undefined,
): string[] {
  if (!errors) {
    return [];
  }
  return Array.isArray(errors) ? errors : Object.values(errors).flat();
}

/**
 * Réponse d'auth du PMS (`AuthResponseDto`) — champs **à plat** (pas d'objet `user` imbriqué,
 * pas d'`expiresIn`). Tous optionnels/nullables dans les types générés → narrowing obligatoire.
 */
export interface PmsAuthResponse {
  userId?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /** Sérialisation en chaîne tolérée (un `JsonStringEnumConverter` côté PMS la produirait). */
  role?: number | string | null;
  accessToken?: string | null;
  accessTokenExpiration?: string | null;
  refreshToken?: string | null;
  refreshTokenExpiration?: string | null;
}

/** Identité exposable au navigateur (aucun jeton, aucun rôle interne superflu). */
export interface SessionUser {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

/** Enregistrement complet stocké **côté serveur uniquement**. */
export interface SessionRecord extends SessionUser {
  role: number;
  accessToken: string;
  /** ISO 8601 UTC ; conservé même expiré — le refresh PMS l'exige (il identifie l'utilisateur). */
  accessTokenExpiration: string | null;
  refreshToken: string;
  refreshTokenExpiration: string | null;
}

/** Libération de verrou **compare-and-delete** : ne supprime que si l'on en est le propriétaire. */
const RELEASE_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  /**
   * Dédup **in-process** des refresh concurrents (même instance BFF). Complète le verrou Redis,
   * qui couvre le cas multi-instances : sans elle, N requêtes simultanées d'un même onglet
   * partiraient toutes sur le chemin « perdant du verrou » (scrutation) au lieu d'attendre.
   */
  private readonly inflightRefreshes = new Map<
    string,
    Promise<SessionRecord>
  >();

  constructor(
    private readonly pms: PmsClientService,
    private readonly redis: RedisService,
    private readonly correlation: CorrelationService,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
  ) {}

  /**
   * Proxifie la connexion vers le PMS puis crée la session serveur.
   * Un rôle ≠ `Customer` est **refusé sans créer de session** : le PMS expose un login unique
   * pour tous les rôles, l'application cliente n'est pas un back-office (AC-4).
   */
  async login(
    email: string,
    password: string,
  ): Promise<{ sid: string; ttlSeconds: number; user: SessionUser }> {
    const res = await this.pms.post<PmsAuthResponse>(
      PMS_AUTH_ENDPOINTS.login,
      { email, password },
      this.pmsContext(),
    );
    const record = this.toSessionRecord(res.data);

    if (record.role !== CUSTOMER_ROLE) {
      // Message volontairement générique (aucune information sur le rôle réel du compte).
      throw new ForbiddenException(
        "Ce compte n'est pas un compte voyageur. Utilisez l'espace professionnel.",
      );
    }

    return this.openSession(record);
  }

  /**
   * **Checkout invité** (story 2.3 — FR-8) : provisionne un `Customer` léger côté PMS puis ouvre
   * la session, exactement comme une connexion.
   *
   * Pourquoi un vrai compte : réserver exige le rôle `Customer`
   * (`RoomReservationsController.CreateReservation`) — le PMS n'a pas de checkout anonyme
   * (dépendance D5). Le mot de passe est tiré au hasard et **immédiatement oublié**
   * (cf. `guest-password.ts`).
   *
   * ⚠️ `maxRetries: 0` : `register/customer` n'est pas idempotent côté PMS. Rejouer un appel dont
   * la réponse s'est perdue ferait échouer la 2ᵉ tentative en « email déjà pris » — le voyageur
   * se verrait alors refuser un compte qui vient d'être créé pour lui et dont personne ne détient
   * le mot de passe. Un 503 rejouable vaut mieux que cette impasse.
   */
  async provisionGuest(
    guest: GuestIdentityInput,
  ): Promise<{ sid: string; ttlSeconds: number; user: SessionUser }> {
    const password = generateGuestPassword();

    let res: ApiResponse<PmsAuthResponse>;
    try {
      res = await this.pms.post<PmsAuthResponse>(
        PMS_AUTH_ENDPOINTS.registerCustomer,
        {
          firstName: guest.firstName,
          lastName: guest.lastName,
          email: guest.email,
          password,
          // Exigé par le validateur PMS (`NotEmpty` + `Equal(Password)`).
          confirmPassword: password,
          phone: guest.phone,
        },
        { ...this.pmsContext(), maxRetries: 0 },
      );
    } catch (err) {
      if (isEmailAlreadyRegistered(err)) {
        throw new GuestEmailConflictError();
      }
      throw err;
    }

    // ⚠️ FRONTIÈRE : à partir d'ici le compte EXISTE côté PMS. Tout échec ultérieur laisse un
    // compte que personne ne peut ouvrir (mot de passe oublié par construction) et qui rendra
    // 409 à toute nouvelle tentative sur la même adresse. Ces échecs ne doivent donc pas être
    // présentés comme des pannes ordinaires « réessayez » — le rejeu est précisément l'impasse.
    let record: SessionRecord;
    try {
      record = this.toSessionRecord(res.data);
    } catch (err) {
      throw this.guestAccountOrphaned(guest.email, res.data?.userId, err);
    }

    if (record.role !== CUSTOMER_ROLE) {
      // Défense en profondeur : `register/customer` ne peut créer qu'un `Customer`, mais une
      // session ouverte sur un autre rôle depuis l'app cliente ne doit jamais exister. Le compte
      // est néanmoins créé : on trace l'orphelin, tout en gardant le 403 (plus informatif ici).
      this.logOrphanedGuestAccount(
        guest.email,
        record.userId,
        'rôle inattendu',
      );
      throw new ForbiddenException(
        "Ce compte n'est pas un compte voyageur. Utilisez l'espace professionnel.",
      );
    }

    try {
      return await this.openSession(record);
    } catch (err) {
      throw this.guestAccountOrphaned(guest.email, record.userId, err);
    }
  }

  /**
   * Échec survenu **après** la création du compte PMS : le compte existe, la session non.
   *
   * Distingué d'une panne ordinaire par le code `guest-account-created`, pour que le front
   * n'invite pas à réessayer avec la même adresse (le rejeu donnerait un 409 sur un compte
   * inouvrable). L'alerte serveur porte de quoi rattraper l'orphelin — jamais de jeton.
   */
  private guestAccountOrphaned(
    email: string,
    userId: string | null | undefined,
    cause: unknown,
  ): ServiceUnavailableException {
    this.logOrphanedGuestAccount(
      email,
      userId,
      cause instanceof Error ? cause.message : 'cause inconnue',
    );
    return new ServiceUnavailableException({
      message:
        "Votre compte a bien été créé, mais nous n'avons pas pu ouvrir votre session.",
      errors: { reason: [GUEST_ACCOUNT_ORPHANED_CODE] },
    });
  }

  private logOrphanedGuestAccount(
    email: string,
    userId: string | null | undefined,
    reason: string,
  ): void {
    this.logger.error(
      `Compte invité orphelin — créé côté PMS sans session ouverte. email=${email} userId=${userId ?? 'inconnu'} cause=${reason}`,
    );
  }

  /** Ouvre une session serveur pour un enregistrement déjà validé (login et invité partagés). */
  private async openSession(
    record: SessionRecord,
  ): Promise<{ sid: string; ttlSeconds: number; user: SessionUser }> {
    const sid = generateSessionId();
    const ttlSeconds = this.sessionTtlSeconds(record);
    await this.write(sid, record, ttlSeconds);
    return { sid, ttlSeconds, user: toSessionUser(record) };
  }

  /** Lit une session ; `null` si absente/expirée (visiteur anonyme, cookie périmé). */
  async read(sid: string): Promise<SessionRecord | null> {
    const raw = await this.redisGet(SESSION_KEY_PREFIX + sid);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as SessionRecord;
    } catch {
      // Enregistrement corrompu : traité comme absent (et purgé) plutôt que de faire 500.
      this.logger.warn('Session illisible (JSON invalide) — purgée.');
      await this.destroy(sid);
      return null;
    }
  }

  async destroy(sid: string): Promise<void> {
    try {
      await this.redis.del(SESSION_KEY_PREFIX + sid);
    } catch (err) {
      throw this.redisUnavailable(err);
    }
  }

  /**
   * Déconnexion : révocation PMS puis destruction locale.
   *
   * L'access token stocké est souvent **déjà expiré** au moment du clic (60 min de durée de vie
   * contre 7 j de session) : sans rejeu après refresh, la révocation échouerait silencieusement
   * dans le cas le plus fréquent et les refresh tokens resteraient actifs côté PMS. On passe donc
   * par `withCustomerAuth` (401 → refresh → rejeu) tout en restant **best-effort** : un échec ne
   * doit jamais empêcher la sortie locale (sinon l'utilisateur reste « connecté » alors qu'il a
   * demandé à partir).
   *
   * ⚠️ `POST /auth/logout` du PMS révoque **tous** les refresh tokens de l'utilisateur (donc les
   * autres appareils). Limitation assumée au MVP — le PMS n'expose pas de révocation ciblée.
   */
  async logout(sid: string): Promise<void> {
    try {
      await this.withCustomerAuth(sid, (accessToken) =>
        this.pms.post(PMS_AUTH_ENDPOINTS.logout, undefined, {
          ...this.pmsContext(),
          bearerToken: accessToken,
        }),
      );
    } catch {
      this.logger.warn(
        'Révocation PMS impossible à la déconnexion — session locale détruite malgré tout.',
      );
    }
    await this.destroy(sid);
  }

  /**
   * Exécute un appel PMS authentifié pour le compte de la session.
   * 401 → refresh single-flight → **un seul** rejeu ; un 401 persistant détruit la session.
   * Une panne PMS (`PmsUnavailableError` → 503) est propagée **sans** détruire la session :
   * une indisponibilité transitoire ne doit pas déconnecter l'utilisateur (NFR-10).
   */
  async withCustomerAuth<T>(
    sid: string,
    fn: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const session = await this.read(sid);
    if (!session) {
      throw new UnauthorizedException('Session expirée ou invalide.');
    }

    try {
      return await fn(session.accessToken);
    } catch (err) {
      if (!isUnauthorized(err)) {
        throw err;
      }
    }

    const refreshed = await this.refresh(sid, session);
    try {
      return await fn(refreshed.accessToken);
    } catch (err) {
      if (isUnauthorized(err)) {
        // Jeton frais refusé : la session n'est plus exploitable côté PMS.
        await this.destroy(sid);
        throw new UnauthorizedException('Session expirée. Reconnectez-vous.');
      }
      throw err;
    }
  }

  /** Rafraîchit la session (single-flight in-process + verrou Redis multi-instances). */
  private async refresh(
    sid: string,
    current: SessionRecord,
  ): Promise<SessionRecord> {
    const inflight = this.inflightRefreshes.get(sid);
    if (inflight) {
      return inflight;
    }
    const pending = this.refreshOnce(sid, current).finally(() => {
      this.inflightRefreshes.delete(sid);
    });
    this.inflightRefreshes.set(sid, pending);
    return pending;
  }

  private async refreshOnce(
    sid: string,
    current: SessionRecord,
  ): Promise<SessionRecord> {
    const lockKey = REFRESH_LOCK_PREFIX + sid;
    const lockToken = randomUUID();
    const acquired = await this.redis.raw.set(
      lockKey,
      lockToken,
      'PX',
      this.options.refreshLockTtlMs,
      'NX',
    );

    if (acquired !== 'OK') {
      // Une autre instance rafraîchit : on attend SON résultat plutôt que d'émettre un second
      // refresh (qui serait rejeté — le PMS a déjà révoqué le refresh token que nous détenons).
      return this.awaitRefreshedByPeer(sid, current);
    }

    try {
      // Relecture sous verrou : une instance concurrente a pu terminer entre notre 401 et le verrou.
      const latest = await this.read(sid);
      if (!latest) {
        // La session a disparu pendant notre attente — typiquement une déconnexion concurrente.
        // Rafraîchir ici la **ressusciterait** pour toute la durée du TTL alors que l'utilisateur
        // a demandé à sortir et que son cookie est déjà expiré côté navigateur.
        throw new UnauthorizedException('Session expirée. Reconnectez-vous.');
      }
      if (latest.accessToken !== current.accessToken) {
        return latest;
      }
      const source = latest;
      const res = await this.pms.post<PmsAuthResponse>(
        PMS_AUTH_ENDPOINTS.refreshToken,
        {
          // Les DEUX jetons sont exigés : l'access token (même expiré) identifie l'utilisateur
          // côté PMS (`ValidateAccessToken` avec `ValidateLifetime = false`).
          accessToken: source.accessToken,
          refreshToken: source.refreshToken,
        },
        this.pmsContext(),
      );
      const record = this.toSessionRecord(res.data, source.role);
      await this.write(sid, record, this.sessionTtlSeconds(record));
      return record;
    } catch (err) {
      // Seul un **refus de jeton** condamne la session (400 « Invalid or expired refresh token »,
      // 401). Les autres 4xx — 429 du rate-limiting à venir, 404 d'une route déplacée — sont des
      // incidents transitoires ou de configuration : les traiter en déconnexion éjecterait des
      // voyageurs valides. Ils remontent tels quels (statut d'origine via le filtre global).
      if (err instanceof PmsRequestError && isTokenRejection(err.status)) {
        await this.destroy(sid);
        throw new UnauthorizedException('Session expirée. Reconnectez-vous.');
      }
      // Panne PMS : session conservée, l'appelant reçoit un 503 (dégradation gracieuse).
      throw err;
    } finally {
      await this.releaseLock(lockKey, lockToken);
    }
  }

  /**
   * Chemin « perdant du verrou » (multi-instances) : scrute la session jusqu'à ce que le jeton
   * change. Au-delà du délai d'attente, on renvoie 503 plutôt que 401 : la session n'est pas
   * invalide, c'est le rafraîchissement qui n'a pas abouti à temps.
   */
  private async awaitRefreshedByPeer(
    sid: string,
    current: SessionRecord,
  ): Promise<SessionRecord> {
    const deadline = Date.now() + this.options.refreshWaitTimeoutMs;
    while (Date.now() < deadline) {
      await delay(this.options.refreshPollIntervalMs);
      const latest = await this.read(sid);
      if (!latest) {
        throw new UnauthorizedException('Session expirée. Reconnectez-vous.');
      }
      if (latest.accessToken !== current.accessToken) {
        return latest;
      }
    }
    throw new ServiceUnavailableException(
      'Rafraîchissement de session momentanément indisponible.',
    );
  }

  private async releaseLock(lockKey: string, lockToken: string): Promise<void> {
    try {
      await this.redis.raw.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken);
    } catch {
      // Best-effort : le verrou expire de lui-même (PX) — ne jamais masquer l'erreur d'origine.
      this.logger.warn(
        'Libération du verrou de refresh impossible (TTL prendra le relais).',
      );
    }
  }

  private async write(
    sid: string,
    record: SessionRecord,
    ttlSeconds: number,
  ): Promise<void> {
    // Pas de best-effort ici (contrairement au cache) : sans écriture, le cookie pointerait
    // vers une session inexistante — l'échec doit remonter (en 503, pas en 500).
    try {
      await this.redis.set(
        SESSION_KEY_PREFIX + sid,
        JSON.stringify(record),
        ttlSeconds,
      );
    } catch (err) {
      throw this.redisUnavailable(err);
    }
  }

  /**
   * Lecture Redis protégée. Une panne du magasin d'état est une **indisponibilité** (503), pas une
   * erreur interne : sans cette conversion, l'exception ioredis brute tombait dans la branche par
   * défaut du filtre global → 500, et le front interprétait le 500 comme « non authentifié ».
   */
  private async redisGet(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (err) {
      throw this.redisUnavailable(err);
    }
  }

  private redisUnavailable(err: unknown): ServiceUnavailableException {
    this.logger.error(
      `Magasin de session indisponible : ${err instanceof Error ? err.message : 'erreur inconnue'}`,
    );
    return new ServiceUnavailableException(
      'Service de session momentanément indisponible.',
    );
  }

  /**
   * Normalise la réponse PMS en enregistrement de session, en validant les champs vitaux.
   *
   * `expectedRole` : au **refresh**, le PMS peut omettre `role` ; on repart alors du rôle déjà
   * validé à la connexion plutôt que de dégrader silencieusement la session en `role: 0`.
   */
  private toSessionRecord(
    data: PmsAuthResponse | undefined,
    expectedRole?: number,
  ): SessionRecord {
    const accessToken = data?.accessToken ?? '';
    const refreshToken = data?.refreshToken ?? '';
    const userId = data?.userId ?? '';
    const email = data?.email ?? '';
    const role = coerceRole(data?.role) ?? expectedRole;

    // Contrat PMS rompu : jamais de session « à moitié ». Sans jetons elle ne serait pas
    // rafraîchissable ; sans identité elle exposerait `{authenticated:true, user:{userId:""}}`
    // au navigateur et servirait de clé d'indexation aux stories suivantes.
    if (
      !accessToken ||
      !refreshToken ||
      !userId ||
      !email ||
      role === undefined
    ) {
      throw new ServiceUnavailableException(
        "Réponse d'authentification inattendue du PMS.",
      );
    }

    return {
      userId,
      email,
      firstName: data?.firstName ?? null,
      lastName: data?.lastName ?? null,
      role,
      accessToken,
      accessTokenExpiration: data?.accessTokenExpiration ?? null,
      refreshToken,
      refreshTokenExpiration: data?.refreshTokenExpiration ?? null,
    };
  }

  /**
   * TTL de session = temps restant jusqu'à l'expiration du **refresh** token (au-delà, la session
   * n'est plus rafraîchissable), borné par le plafond configuré. Expiration absente/illisible →
   * plafond (le PMS reste l'autorité : un jeton mort produira un 401 → refresh → 401 → déconnexion).
   *
   * ⚠️ Ce plafond borne **chaque écriture**, pas la durée de vie absolue d'une session : chaque
   * refresh réussi le reconduit. Un plafond absolu depuis l'authentification est une décision
   * produit, consignée dans `deferred-work.md`.
   */
  private sessionTtlSeconds(record: SessionRecord): number {
    const max = this.options.maxSessionTtlSeconds;
    if (!record.refreshTokenExpiration) {
      return max;
    }
    const expiresAt = Date.parse(record.refreshTokenExpiration);
    if (!Number.isFinite(expiresAt)) {
      return max;
    }
    const seconds = Math.floor((expiresAt - Date.now()) / 1000);
    if (seconds <= 0) {
      // Le PMS annonce une expiration déjà passée : dérive d'horloge ou contrat rompu. Sans ce
      // log, le plancher ci-dessous ramènerait toutes les sessions à 60 s en silence.
      this.logger.error(
        `refreshTokenExpiration déjà expirée (${record.refreshTokenExpiration}) — dérive d'horloge BFF/PMS ?`,
      );
    }
    // Plancher 60 s : une session immédiatement expirée serait indiscernable d'un échec de login.
    return Math.max(60, Math.min(seconds, max));
  }

  private pmsContext(): PmsRequestContext | undefined {
    const correlationId = this.correlation.getCorrelationId();
    return correlationId ? { correlationId } : undefined;
  }
}

/**
 * Statuts PMS signifiant « ce couple de jetons est refusé » — les seuls qui condamnent la session.
 * `RefreshTokenAsync` renvoie 400 (`Result.Failure`) ; 401 couvre une garde d'auth en amont.
 */
function isTokenRejection(status: number): boolean {
  return status === 400 || status === 401;
}

/** Le rôle PMS est numérique ; on tolère une sérialisation en chaîne sans jamais deviner. */
function coerceRole(
  role: number | string | null | undefined,
): number | undefined {
  if (typeof role === 'number' && Number.isInteger(role)) {
    return role;
  }
  if (typeof role === 'string' && /^\d+$/.test(role.trim())) {
    return Number(role.trim());
  }
  return undefined;
}

/** Projection publique : jamais de jeton, jamais de rôle interne, vers le navigateur. */
export function toSessionUser(record: SessionRecord): SessionUser {
  return {
    userId: record.userId,
    email: record.email,
    firstName: record.firstName,
    lastName: record.lastName,
  };
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof PmsRequestError && err.status === 401;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
