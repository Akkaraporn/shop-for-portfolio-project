import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { Page } from '../common/pagination/cursor';
import { ListOrdersQuery } from './dto/list-orders.query';
import { OrderNumberParam } from './dto/order-number.param';
import type { OrderView } from './order.types';
import { OrdersService } from './orders.service';

/**
 * Order history and cancellation. Every endpoint requires authentication — the
 * global guard protects anything not marked otherwise.
 */
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * The caller's own orders.
   *
   * An admin calling this sees their own orders, not everyone's: the back-office list
   * is `GET /admin/orders` (task 2.7). Overloading this one on role would make the
   * same URL mean two different things depending on who asks.
   */
  @Get()
  list(
    @Query() query: ListOrdersQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<OrderView>> {
    return this.orders.list(user.id, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get(':orderNumber')
  get(
    @Param() params: OrderNumberParam,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderView> {
    return this.orders.findForUser(params.orderNumber, user.id);
  }

  /** 200, not Nest's default 201: nothing is created, an existing order changes state. */
  @Post(':orderNumber/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param() params: OrderNumberParam,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderView> {
    return this.orders.cancel(params.orderNumber, user.id);
  }
}
