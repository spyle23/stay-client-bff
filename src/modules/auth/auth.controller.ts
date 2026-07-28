import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiResponse } from '../../integration/pms/api-response.types';
import { PmsRequestError } from '../../integration/pms/pms-errors';
import { AUTH_OPTIONS, type AuthOptions } from './auth.constants';
import { GuestCheckoutRequestDto } from './dto/guest-checkout.request.dto';
import { LoginRequestDto } from './dto/login.request.dto';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  readSessionId,
  type SessionCookieOptions,
} from './session-cookie';
import {
  GuestEmailConflictError,
  SessionService,
  type SessionUser,
  toSessionUser,
} from './session.service';

/**
 * Frontière HTTP du domaine `auth` (stories 2.1 et 2.3 — FR-19 / FR-8 / AR-9 / NFR-8) :
 * - `POST /api/v1/auth/login`   — proxy de connexion PMS → session serveur + cookie opaque ;
 * - `POST /api/v1/auth/guest`   — Checkout invité : `Customer` léger provisionné → même session ;
 * - `GET  /api/v1/auth/session` — état de session (snapshot Redis, **sans appel PMS**) ;
 * - `POST /api/v1/auth/logout`  — révocation PMS best-effort + destruction + cookie expiré.
 *
 * **Invariant de sécurité** : aucune réponse ne contient de jeton. Le navigateur ne reçoit que
 * l'identité affichable (`SessionUser`) et un cookie **opaque** `HttpOnly/Secure/SameSite=Lax`.
 *
 * `GET /auth/session` répond **200 avec `authenticated:false`** pour un visiteur anonyme (et non
 * 401) : c'est une lecture d'état publique, appelée sur chaque page ; un 401 générerait du bruit
 * d'erreur permanent côté front et empêcherait de distinguer « anonyme » d'un vrai échec.
 *
 * L'inscription explicite (avec mot de passe choisi) et le mot de passe oublié **ne sont pas ici** :
 * story 4.1. Le lien de gestion signé (FR-18) est du périmètre Epic 4.
 *
 * ⚠️ Aucune de ces routes n'est encore limitée en débit (`@nestjs/throttler` installé, non câblé —
 * story 6.1). `POST /auth/guest` est une écriture publique **créant des comptes PMS** : elle doit
 * rejoindre la même politique que la création de réservation (story 2.4).
 */

/** État de session exposé au navigateur — jamais de jeton, jamais de rôle interne. */
export interface SessionStateDto {
  authenticated: boolean;
  user: SessionUser | null;
}

const ANONYMOUS: SessionStateDto = { authenticated: false, user: null };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionService,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
  ) {}

  /**
   * 200 + cookie de session si les identifiants sont valides **et** que le compte est un
   * `Customer` (403 sinon — AC-4). Identifiants invalides : le 4xx du PMS est relayé tel quel
   * par le filtre d'exceptions global, avec un message générique (anti-énumération de comptes).
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<SessionStateDto>> {
    noStore(res);
    try {
      const { sid, ttlSeconds, user } = await this.sessions.login(
        body.email,
        body.password,
      );
      res.setHeader(
        'Set-Cookie',
        buildSessionCookie(sid, ttlSeconds, this.cookieOptions()),
      );
      return { success: true, data: { authenticated: true, user } };
    } catch (err) {
      // Anti-énumération **côté serveur** : le PMS distingue aujourd'hui « compte inconnu » de
      // « mot de passe incorrect » dans son message, et pourrait demain ajouter « compte
      // verrouillé » / « email non vérifié ». Relayer ce texte offrirait un oracle lisible
      // directement dans la réponse HTTP — la normalisation côté React ne protège personne.
      if (err instanceof PmsRequestError && isCredentialRejection(err.status)) {
        throw new UnauthorizedException('Identifiants invalides.');
      }
      throw err;
    }
  }

  /**
   * **Checkout invité** (story 2.3 — FR-8) : provisionne un `Customer` léger rattaché à l'email
   * fourni et ouvre la session — même modèle de cookie que `login`.
   *
   * Route **publique** : l'inscription n'est jamais forcée avant de réserver (UX-DR-9.6). Aucun
   * mot de passe ne transite : il est généré côté serveur et immédiatement oublié.
   *
   * Idempotence utile (AC-10) : une session déjà ouverte **sur le même email** est réutilisée
   * telle quelle, sans appeler le PMS — c'est le cas d'une double soumission ou d'un retour
   * arrière. Une session portant un **autre** email est détruite après provisioning : deux
   * identités concurrentes dans le même tunnel mèneraient à une réservation rattachée au mauvais
   * compte, et l'ancienne clé Redis survivrait des jours avec ses JWT.
   */
  @Post('guest')
  @HttpCode(HttpStatus.OK)
  async guest(
    @Body() body: GuestCheckoutRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<SessionStateDto>> {
    noStore(res);

    const incomingSid = readSessionId(req.headers.cookie, this.cookieOptions());
    if (incomingSid) {
      const existing = await this.sessions.read(incomingSid);
      if (existing && existing.email === body.email) {
        return {
          success: true,
          data: { authenticated: true, user: toSessionUser(existing) },
        };
      }
    }

    let created: { sid: string; ttlSeconds: number; user: SessionUser };
    try {
      created = await this.sessions.provisionGuest({
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone,
      });
    } catch (err) {
      if (err instanceof GuestEmailConflictError) {
        // 409 avec le message du BFF : le texte du PMS (« Email is already registered. ») ne
        // doit pas atteindre le navigateur — même règle qu'au login.
        throw new ConflictException(err.message);
      }
      // Tout autre refus du PMS est relayé **sans son corps** : celui-ci est en anglais, technique,
      // et peut décrire l'état d'un compte tiers.
      //
      // ⚠️ Branche défensive, aujourd'hui inatteignable sur cette route : le PMS n'exécute pas ses
      // validateurs FluentValidation (cf. `guest-checkout.request.dto.ts`), si bien que le **seul**
      // 400 que `register/customer` sait produire est la collision d'email traitée juste au-dessus.
      // Un champ hors bornes ressortirait en 500 (contrainte PostgreSQL) — d'où les bornes du DTO.
      // Conservée : elle deviendra le chemin nominal le jour où le PMS câblera sa validation.
      if (err instanceof PmsRequestError && err.status < 500) {
        throw new BadRequestException(
          "Vos informations n'ont pas été acceptées. Vérifiez-les et réessayez.",
        );
      }
      throw err;
    }

    if (incomingSid) {
      try {
        await this.sessions.destroy(incomingSid);
      } catch {
        // Best-effort : ne jamais faire échouer un provisioning réussi pour un nettoyage.
        // La session orpheline expirera par son TTL, et le cookie vient d'être remplacé.
      }
    }

    res.setHeader(
      'Set-Cookie',
      buildSessionCookie(created.sid, created.ttlSeconds, this.cookieOptions()),
    );
    return {
      success: true,
      data: { authenticated: true, user: created.user },
    };
  }

  @Get('session')
  async session(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<SessionStateDto>> {
    // Réponse porteuse d'identité (userId + email) sur un GET 200 : sans directive, un cache
    // partagé (proxy d'entreprise, CDN) pourrait la resservir à un autre visiteur.
    noStore(res);

    const sid = readSessionId(req.headers.cookie, this.cookieOptions());
    if (!sid) {
      return { success: true, data: ANONYMOUS };
    }
    const session = await this.sessions.read(sid);
    if (!session) {
      // Signature valide mais session absente (TTL écoulé, refresh refusé, logout ailleurs) :
      // on efface le cookie orphelin. Sinon il subsiste jusqu'à son `Max-Age` et la garde
      // `proxy.ts` — un simple test de présence — laisse passer `/account` pendant des jours.
      res.setHeader(
        'Set-Cookie',
        buildClearedSessionCookie(this.cookieOptions()),
      );
      return { success: true, data: ANONYMOUS };
    }
    return {
      success: true,
      data: { authenticated: true, user: toSessionUser(session) },
    };
  }

  /**
   * Déconnexion — **idempotente**, et volontairement non gardée.
   *
   * Une garde renverrait 401 sur un cookie déjà périmé **sans expirer le cookie** : celui-ci
   * resterait dans le navigateur jusqu'à son `Max-Age`, et la garde `proxy.ts` (test de présence)
   * laisserait passer `/account` pendant des jours. Or c'est précisément le cas où l'on veut
   * *garantir* la suppression. On efface donc toujours, et on répond toujours 200 : l'invariant
   * « une session détruite n'est plus exploitable » reste vérifié par `GET /auth/session`
   * (`authenticated:false`) et par la garde des futures routes protégées (`SessionGuard`).
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<SessionStateDto>> {
    noStore(res);
    const sid = readSessionId(req.headers.cookie, this.cookieOptions());
    if (sid) {
      await this.sessions.logout(sid);
    }
    res.setHeader(
      'Set-Cookie',
      buildClearedSessionCookie(this.cookieOptions()),
    );
    return { success: true, data: ANONYMOUS };
  }

  private cookieOptions(): SessionCookieOptions {
    return {
      cookieName: this.options.cookieName,
      sessionSecret: this.options.sessionSecret,
      cookieSecure: this.options.cookieSecure,
    };
  }
}

/** Aucune réponse d'auth ne doit être mise en cache (identité + cookie de session). */
function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Vary', 'Cookie');
}

/** Statuts PMS traduisant un refus d'identifiants — normalisés en 401 générique. */
function isCredentialRejection(status: number): boolean {
  return status === 400 || status === 401;
}
