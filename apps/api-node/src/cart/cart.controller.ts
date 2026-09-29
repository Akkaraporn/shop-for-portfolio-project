import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalAuth } from '../auth/decorators/public.decorator';
import { CartResolverService } from './cart-resolver.service';
import { CartService } from './cart.service';
import type { CartView } from './cart.types';
import { AddItemDto } from './dto/add-item.dto';
import { ItemIdParam } from './dto/item-id.param';
import { MergeCartDto } from './dto/merge-cart.dto';
import { UpdateItemDto } from './dto/update-item.dto';

/**
 * The basket. Works for a guest and for a signed-in user.
 *
 * Every endpoint except merge is `@OptionalAuth`: shopping happens before signing in,
 * and an expired access token must degrade to "guest with a cart token" rather than
 * to a 401 the shopper cannot act on.
 *
 * Each handler resolves the basket first and writes `X-Cart-Token` on the way out.
 * `@Res({ passthrough: true })` is used rather than returning the response directly,
 * so Nest still serialises the body and the global filter still handles throws — a
 * handler that takes over the response loses both.
 */
@Controller('carts/me')
export class CartController {
  constructor(
    private readonly resolver: CartResolverService,
    private readonly carts: CartService,
  ) {}

  @Get()
  @OptionalAuth()
  async get(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CartView> {
    const cartId = await this.resolveAndEcho(request, response);
    return this.carts.view(cartId);
  }

  // 200, not Nest's default 201 for POST. The contract is explicit: this returns the
  // updated basket rather than creating a resource the client can address, and there
  // is no Location header to go with a 201.
  @Post('items')
  @OptionalAuth()
  @HttpCode(HttpStatus.OK)
  async addItem(
    @Body() dto: AddItemDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CartView> {
    const cartId = await this.resolveAndEcho(request, response);
    return this.carts.addItem(cartId, dto.variantId, dto.quantity);
  }

  @Patch('items/:itemId')
  @OptionalAuth()
  async updateItem(
    @Param() params: ItemIdParam,
    @Body() dto: UpdateItemDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CartView> {
    const cartId = await this.resolveAndEcho(request, response);
    return this.carts.updateItem(cartId, params.itemId, dto.quantity);
  }

  /**
   * Returns the remaining basket rather than 204, so the client can render new
   * totals without a second round trip.
   */
  @Delete('items/:itemId')
  @OptionalAuth()
  async removeItem(
    @Param() params: ItemIdParam,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CartView> {
    const cartId = await this.resolveAndEcho(request, response);
    return this.carts.removeItem(cartId, params.itemId);
  }

  /**
   * Absorbs a guest basket into the caller's own. Requires authentication: there is
   * no "merge into nothing", and the target basket is the caller's by definition.
   *
   * No `X-Cart-Token` is echoed afterwards — the guest basket is gone, and handing
   * back a token for a deleted row would invite the client to keep using it.
   */
  @Post('merge')
  @HttpCode(HttpStatus.OK)
  mergeCart(
    @Body() dto: MergeCartDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CartView> {
    return this.carts.merge(user.id, dto.cartToken);
  }

  /**
   * Resolves the basket and, when it is a guest basket, sets `X-Cart-Token`.
   *
   * The header is sent on every guest response, including ones where the token did
   * not change, so a client only ever has to store the latest value it saw. It is
   * omitted for a signed-in user's basket, which has no token.
   */
  private async resolveAndEcho(
    request: Request,
    response: Response,
  ): Promise<string> {
    const { cartId, issuedToken } = await this.resolver.resolve(request);

    if (issuedToken) {
      response.setHeader('X-Cart-Token', issuedToken);
    }

    return cartId;
  }
}
