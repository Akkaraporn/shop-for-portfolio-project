import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ProblemException } from '../../common/problem/problem.exception';
import type { AuthenticatedUser } from '../auth.types';
import { ROLES } from '../decorators/roles.decorator';

/**
 * Authorisation, applied globally after JwtAuthGuard.
 *
 * Only acts where `@Roles(...)` is present, so it is inert on everything else.
 * Registration order in AppModule matters: this guard reads the user that
 * JwtAuthGuard attached, so it must run second.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    // Unauthenticated on a role-restricted route is 401, not 403: the caller has
    // not been told to authenticate yet, and 403 would imply they had.
    if (!request.user) {
      throw new ProblemException('unauthorized', {
        detail: 'This endpoint requires an access token.',
      });
    }

    if (!required.includes(request.user.role)) {
      // 403, never 404. The admin paths are in the published contract, so hiding
      // them would be theatre while making every real misconfiguration look like
      // a typo.
      throw new ProblemException('forbidden', {
        detail: 'This endpoint requires a different role.',
      });
    }

    return true;
  }
}
