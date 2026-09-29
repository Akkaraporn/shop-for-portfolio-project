import { SetMetadata } from '@nestjs/common';

export const ROLES = 'auth:roles';

/**
 * Restricts an endpoint to the listed roles.
 *
 * A caller without the role gets 403, never 404. Hiding the existence of
 * `/admin/*` behind a 404 would be security theatre — the paths are in the public
 * contract — while making every genuine misconfiguration look like a typo.
 */
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES, roles);
