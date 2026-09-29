import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GuestCartService } from './guest-cart.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * No @nestjs/jwt, and no Passport.
 *
 * @nestjs/jwt v12 is ESM-only, which a CommonJS Nest build can load only through
 * Node's require(esm) support — fine on Node 24, unavailable to Jest's runtime, and
 * a poor thing to depend on in a production image. It is a thin wrapper over
 * `jsonwebtoken` in any case, and signing one token with an explicit algorithm
 * reads more directly than configuring a module to do it. Passport was declined for
 * the same reason: a strategy registry to verify a single signature, and one more
 * layer between this and its Spring Security counterpart.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, GuestCartService],
  // Exported because the global JwtAuthGuard verifies access tokens with it.
  exports: [TokenService],
})
export class AuthModule {}
