import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '../../modules/auth/session.service';

/**
 * Session résolue par `SessionGuard` et attachée à la requête (story 2.1).
 *
 * ⚠️ Ne contient **aucun jeton** : les JWT restent en Redis, accessibles uniquement via
 * `SessionService.withCustomerAuth(sid, …)`. Un contrôleur ne doit jamais manipuler de jeton.
 */
export interface RequestSession {
  /** Identifiant opaque de session — clé d'appel de `withCustomerAuth`. */
  sid: string;
  user: SessionUser;
}

export interface RequestWithSession extends Request {
  clientSession?: RequestSession;
}

/**
 * Injecte la session courante dans un handler protégé par `SessionGuard`.
 * L'absence de session ici signale un oubli de garde (erreur de programmation) → 500 explicite
 * plutôt qu'un `undefined` propagé silencieusement.
 */
export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestSession => {
    const request = ctx.switchToHttp().getRequest<RequestWithSession>();
    if (!request.clientSession) {
      throw new InternalServerErrorException(
        'Session absente : la route doit être protégée par SessionGuard.',
      );
    }
    return request.clientSession;
  },
);
