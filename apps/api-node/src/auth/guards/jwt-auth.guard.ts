import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ProblemException } from '../../common/problem/problem.exception';
import type { AuthenticatedUser } from '../auth.types';
import { IS_PUBLIC, OPTIONAL_AUTH } from '../decorators/public.decorator';
import { TokenService } from '../token.service';

/**
 * Authentication, applied globally so it is on by default.
 *
 * Registered as an `APP_GUARD`, which means an endpoint is protected unless it
 * says otherwise with `@Public()` or `@OptionalAuth()`. Forgetting an annotation
 * therefore locks an endpoint down rather than exposing it — the failure direction
 * that matters, and the reverse of what happens with per-controller `@UseGuards`.
 *
 * No Passport. `passport-jwt` would add a strategy registry and a second
 * configuration surface to do what verifying one signature does, and the Spring
 * Security port reads more directly from this than from a Passport strategy.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, handler)) {
      return true;
    }

    const optional =
      this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH, handler) ?? false;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    const token = extractBearerToken(request.header('authorization'));

    if (!token) {
      if (optional) {
        return true;
      }
      throw new ProblemException('unauthorized', {
        detail: 'This endpoint requires an access token.',
      });
    }

    const claims = this.tokens.verifyAccessToken(token);

    if (!claims) {
      // On an optional-auth route a bad token is treated as no token. A guest
      // whose access token expired overnight should get a working basket rather
      // than a 401 they cannot act on.
      if (optional) {
        return true;
      }
      throw new ProblemException('unauthorized', {
        detail: 'The access token is missing, expired, or not valid.',
      });
    }

    // Identity comes from the token, not from a query. The cost is that a user
    // deleted or demoted mid-session keeps their old role until the access token
    // expires — at most 15 minutes. Verifying against the database on every
    // request would trade that window for a query on every authenticated call;
    // anything needing certainty (like /auth/me) reads the row itself.
    request.user = { id: claims.sub, role: claims.role };

    return true;
  }
}

/**
 * Pulls the token out of `Authorization: Bearer <token>`.
 *
 * The scheme is compared case-insensitively because RFC 7235 says it is
 * case-insensitive, and clients send `bearer` in practice.
 */
function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const [scheme, value, ...rest] = header.trim().split(/\s+/);

  if (rest.length > 0 || !scheme || !value) {
    return null;
  }

  return scheme.toLowerCase() === 'bearer' ? value : null;
}
