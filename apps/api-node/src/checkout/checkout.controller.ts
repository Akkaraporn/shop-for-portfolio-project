import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CartResolverService } from '../cart/cart-resolver.service';
import { ProblemException } from '../common/problem/problem.exception';
import type { OrderView } from '../orders/order.types';
import { CheckoutService } from './checkout.service';
import { CheckoutDto } from './dto/checkout.dto';
import { IdempotencyService } from './idempotency.service';

/** Scopes idempotency keys, so a key used here cannot collide with a future endpoint. */
const ENDPOINT = 'POST /checkout';

@Controller('checkout')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly idempotency: IdempotencyService,
    private readonly carts: CartResolverService,
  ) {}

  /**
   * Places an order.
   *
   * Authentication is required — an order belongs to a user. A guest signs in first
   * and brings their basket across with `POST /carts/me/merge`.
   *
   * `Idempotency-Key` is mandatory rather than optional. Checkout is the one operation
   * here that a duplicate of is genuinely expensive, and a client that has to opt in
   * to safety will forget on the path that matters: the retry after a timeout, where
   * it cannot tell whether the first attempt succeeded.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async placeOrder(
    @Body() dto: CheckoutDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderView> {
    const key = requireIdempotencyKey(idempotencyKey);

    // The hash is taken over the parsed and validated body rather than the raw bytes:
    // whitespace and key order must not matter, which is the whole point of
    // canonicalising. See docs/idempotency.md.
    const outcome = await this.idempotency.begin(user.id, ENDPOINT, key, {
      shippingAddress: { ...dto.shippingAddress },
      paymentMethod: dto.paymentMethod,
      ...(dto.note === undefined ? {} : { note: dto.note }),
    });

    if (outcome.kind === 'replay') {
      // The header is how a client tells a replay from a fresh order, which matters
      // when it is reconciling what it thinks it sent against what exists.
      response.setHeader('Idempotency-Replayed', 'true');
      response.status(outcome.status);
      return outcome.body as OrderView;
    }

    try {
      const { cartId } = await this.carts.resolve(request);

      // The key is completed inside the checkout transaction, so the stored response
      // and the order commit atomically.
      const { order } = await this.checkout.checkout(user.id, cartId, dto, {
        endpoint: ENDPOINT,
        key,
        status: HttpStatus.CREATED,
      });

      return order;
    } catch (error) {
      // Release the key so a retry is a genuine fresh attempt. Only successful
      // responses are ever replayed — a failed checkout committed nothing, and stock
      // may well have changed by the time the client tries again.
      await this.idempotency.release(user.id, ENDPOINT, key);
      throw error;
    }
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  if (!value || value.trim().length < 16) {
    throw new ProblemException('validation-failed', {
      detail:
        'Idempotency-Key is required and must be at least 16 characters. A UUID is the obvious choice.',
      errors: [
        {
          field: 'Idempotency-Key',
          message: 'required, at least 16 characters',
        },
      ],
    });
  }

  if (value.length > 128) {
    throw new ProblemException('validation-failed', {
      detail: 'Idempotency-Key must be at most 128 characters.',
      errors: [{ field: 'Idempotency-Key', message: 'at most 128 characters' }],
    });
  }

  return value;
}
