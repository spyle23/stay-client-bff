import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AUTH_OPTIONS,
  type AuthOptions,
} from '../../modules/auth/auth.constants';
import { readSessionId } from '../../modules/auth/session-cookie';
import {
  SessionService,
  toSessionUser,
} from '../../modules/auth/session.service';
import type { RequestWithSession } from '../decorators/current-session.decorator';

/**
 * Garde de session (story 2.1 — AR-9). Résout le cookie opaque → session Redis, et attache
 * `{ sid, user }` à la requête (sans aucun jeton — cf. `CurrentSession`).
 *
 * Deux niveaux de rejet, tous deux en 401 :
 * 1. cookie absent, malformé ou **signature invalide** (forgeage) → aucun accès Redis ;
 * 2. signature valide mais session absente/expirée côté Redis.
 *
 * Consommateurs : `POST /auth/logout` aujourd'hui ; création de réservation (2.4), espace
 * client et annulation (Epic 4) ensuite.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const sid = readSessionId(request.headers.cookie, {
      cookieName: this.options.cookieName,
      sessionSecret: this.options.sessionSecret,
      cookieSecure: this.options.cookieSecure,
    });
    if (!sid) {
      throw new UnauthorizedException('Authentification requise.');
    }

    const session = await this.sessions.read(sid);
    if (!session) {
      throw new UnauthorizedException('Session expirée ou invalide.');
    }

    request.clientSession = { sid, user: toSessionUser(session) };
    return true;
  }
}
