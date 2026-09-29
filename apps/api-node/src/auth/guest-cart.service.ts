import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';

import { hashToken } from './token.service';
import { LOGGER } from '../common/logging/logger.module';
import { PrismaService } from '../infra/prisma/prisma.service';

/**
 * Attaches a guest basket to an account at register or login.
 *
 * Deliberately narrow. This only handles the case where the account has **no**
 * basket yet, which it can do by re-owning the guest row: set `user_id`, clear
 * `token_hash` and `expires_at`. Those three have to move together to satisfy the
 * `carts_single_owner_check` constraint — a basket belongs to a user or to a guest
 * token, never both and never neither.
 *
 * When the account already has a basket, the two have to be **merged**: quantities
 * summed per variant, capped at 99, guest row deleted. That is
 * `POST /carts/me/merge`, and it belongs to task 2.4 along with the rest of the
 * cart logic. Doing half of it here would leave two implementations of the same
 * rule.
 *
 * Every failure is swallowed. A basket that fails to follow someone through
 * registration is a disappointment; a registration that fails because of it is a
 * lost account.
 */
@Injectable()
export class GuestCartService {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly prisma: PrismaService,
  ) {}

  async claimForUser(userId: string, cartToken: string | undefined): Promise<void> {
    if (!cartToken) {
      return;
    }

    try {
      const guestCart = await this.prisma.carts.findFirst({
        where: {
          token_hash: hashToken(cartToken),
          user_id: null,
        },
        select: { id: true },
      });

      if (!guestCart) {
        // Expired, already claimed, or never existed. Not an error: a client that
        // holds a stale token should simply end up with an empty basket.
        return;
      }

      const existing = await this.prisma.carts.findFirst({
        where: { user_id: userId },
        select: { id: true },
      });

      if (existing) {
        // The merge case. Left for the client to request explicitly via
        // POST /carts/me/merge, which is idempotent and safe to call always.
        this.logger.debug(
          { userId },
          'guest cart not claimed: the account already has one, merge required',
        );
        return;
      }

      await this.prisma.carts.update({
        where: { id: guestCart.id },
        data: { user_id: userId, token_hash: null, expires_at: null },
      });

      this.logger.info({ userId, cartId: guestCart.id }, 'guest cart claimed');
    } catch (error) {
      // Includes the race where two requests claim the same guest cart, or where
      // the account acquired a basket between the two queries above: the partial
      // unique index on carts(user_id) rejects the second writer with P2002.
      this.logger.warn(
        { userId, err: error instanceof Error ? error.message : String(error) },
        'guest cart claim failed, continuing without it',
      );
    }
  }
}
