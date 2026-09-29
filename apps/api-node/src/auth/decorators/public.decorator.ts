import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';
export const OPTIONAL_AUTH = 'auth:optional';

/**
 * No authentication at all. The guard does not even look for a bearer token.
 *
 * Authentication is on by default — the global guard rejects anything not marked —
 * so forgetting an annotation fails closed. That is the opposite of the usual
 * `@UseGuards` arrangement, where forgetting one leaves an endpoint wide open.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC, true);

/**
 * Authentication is used when present and not required when absent.
 *
 * For the endpoints the contract marks `security: [bearerAuth, {}]`: the cart
 * works for a signed-in user and for a guest carrying `X-Cart-Token`, and logout
 * must succeed either way. An invalid token on such an endpoint is treated as no
 * token rather than as an error — a guest with a stale token should get a working
 * basket, not a 401.
 */
export const OptionalAuth = (): MethodDecorator & ClassDecorator =>
  SetMetadata(OPTIONAL_AUTH, true);
