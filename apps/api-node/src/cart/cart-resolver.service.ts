import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../infra/prisma/prisma.service';

/**
 * How long a guest basket survives without being touched.
 *
 * A module constant rather than an environment variable: both backends must agree
 * on it, and a value that can differ between deployments is a value the parity
 * suite cannot assert on.
 */
export const GUEST_CART_TTL_DAYS = 30;

export interface ResolvedCart {
  cartId: string;
  /**
   * The raw guest token, present only when this response should carry
   * `X-Cart-Token` — that is, when the basket is a guest basket. A signed-in user's
   * basket has no token, so none is sent.
   */
  issuedToken?: string;
}

/**
 * Finds the caller's basket, creating one when there is nothing to find.
 *
 * The resolution order is fixed and the contract depends on it:
 *
 *   1. A valid access token wins. The user's basket is returned and any
 *      `X-Cart-Token` is **ignored** — combining them is a merge, which is an
 *      explicit endpoint rather than a side effect of reading.
 *   2. Otherwise `X-Cart-Token` names a guest basket.
 *   3. Otherwise a new guest basket is created.
 *
 * Step 2 has a detail that matters more than it looks: a token that is expired,
 * unknown, or forged does **not** produce a 404. A fresh basket is created and its
 * token returned. Someone who left a tab open overnight should find an empty cart,
 * not an error they cannot act on — and a 404 here would also confirm to an attacker
 * which tokens are real.
 */
@Injectable()
export class CartResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(request: Request): Promise<ResolvedCart> {
    const user = (request as Request & { user?: AuthenticatedUser }).user;

    if (user) {
      return { cartId: await this.forUser(user.id) };
    }

    const presented = request.header('x-cart-token');

    if (presented) {
      const existing = await this.prisma.carts.findFirst({
        where: {
          token_hash: hashCartToken(presented),
          user_id: null,
          // An expired basket is treated as absent. The sweeper deletes it later;
          // until then it must not be handed back.
          expires_at: { gt: new Date() },
        },
        select: { id: true },
      });

      if (existing) {
        // Echo the token the caller already holds, so every cart response carries
        // the current one and a client only ever has to store the latest value.
        return { cartId: existing.id, issuedToken: presented };
      }
    }

    return this.createGuestCart();
  }

  /**
   * The user's basket, created on first use.
   *
   * There is no pre-flight check for whether one exists, because two concurrent
   * requests would both pass it. The partial unique index on `carts(user_id)` is the
   * only thing that can decide, so a conflict is caught and the winner's row read
   * instead. Prisma cannot see that index — it is partial — so this is the only
   * place the constraint surfaces.
   */
  private async forUser(userId: string): Promise<string> {
    const existing = await this.prisma.carts.findFirst({
      where: { user_id: userId },
      select: { id: true },
    });

    if (existing) {
      return existing.id;
    }

    try {
      const created = await this.prisma.carts.create({
        data: { user_id: userId },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.carts.findFirst({
          where: { user_id: userId },
          select: { id: true },
        });
        if (winner) {
          return winner.id;
        }
      }
      throw error;
    }
  }

  private async createGuestCart(): Promise<ResolvedCart> {
    const token = randomBytes(32).toString('base64url');

    const created = await this.prisma.carts.create({
      data: {
        token_hash: hashCartToken(token),
        expires_at: guestCartExpiry(),
      },
      select: { id: true },
    });

    return { cartId: created.id, issuedToken: token };
  }
}

export function guestCartExpiry(): Date {
  return new Date(Date.now() + GUEST_CART_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * SHA-256 hex, matching the `char(64)` column.
 *
 * Only the hash is stored, for the same reason as refresh tokens: the raw token is
 * a bearer credential for whatever is in the basket, and a database leak should not
 * hand over the ability to read or empty other people's carts.
 */
export function hashCartToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
