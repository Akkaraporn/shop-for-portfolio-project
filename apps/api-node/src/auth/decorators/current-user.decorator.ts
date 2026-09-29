import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth.types';

/**
 * The authenticated user, or undefined on a `@Public` or `@OptionalAuth` route.
 *
 * Typed as possibly-undefined on purpose: a handler on an optional-auth route has
 * to handle the guest case, and a type that pretended otherwise would push that
 * mistake to runtime.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined => {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    return request.user;
  },
);
