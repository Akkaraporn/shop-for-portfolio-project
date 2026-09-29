import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  buildPage,
  decodeCursor,
  type Page,
} from '../common/pagination/cursor';
import { ProblemException, Problems } from '../common/problem/problem.exception';
import { PrismaService } from '../infra/prisma/prisma.service';
import { CANCELLABLE_STATUSES, toOrderView, type OrderRow } from './order.mapper';
import type { OrderView } from './order.types';

/** Everything `toOrderView` needs, in one include. */
const ORDER_INCLUDE = {
  order_items: { orderBy: { sku: 'asc' as const } },
  payments: true,
  stock_reservations: {
    where: { status: 'held' as const },
    orderBy: { expires_at: 'asc' as const },
    take: 1,
  },
} as const;

export const DEFAULT_ORDER_LIMIT = 20;

export { ORDER_INCLUDE };

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's order history, newest first.
   *
   * Paged with the same cursor codec as the catalogue: the ids are selected in a raw
   * query, because the keyset predicate is a row-value comparison the query builder
   * renders wrongly, and the rows are then loaded with their relations. Two queries
   * rather than one join that would have to be un-flattened by hand.
   */
  async list(
    userId: string,
    options: {
      cursor?: string;
      limit?: number;
      status?: string;
      allUsers?: boolean;
      /** With `allUsers`, restricts the admin list to one customer. */
      filterUserId?: string;
    },
  ): Promise<Page<OrderView>> {
    const limit = options.limit ?? DEFAULT_ORDER_LIMIT;

    const conditions: Prisma.Sql[] = [];

    // An admin listing every order is the same query without the ownership filter.
    // Sharing it keeps the two `Page` envelopes identical, which the contract requires.
    if (!options.allUsers) {
      conditions.push(Prisma.sql`o.user_id = ${userId}::uuid`);
    }

    if (options.filterUserId) {
      conditions.push(Prisma.sql`o.user_id = ${options.filterUserId}::uuid`);
    }

    if (options.status) {
      conditions.push(Prisma.sql`o.status = ${options.status}`);
    }

    if (options.cursor) {
      const { sortValue, id } = decodeCursor(options.cursor);
      conditions.push(
        Prisma.sql`(o.placed_at, o.id) < (${sortValue}::timestamptz, ${id}::uuid)`,
      );
    }

    const where =
      conditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<{ id: string; placed_at: Date }[]>`
      SELECT o.id, o.placed_at
      FROM orders o
      ${where}
      ORDER BY o.placed_at DESC, o.id DESC
      LIMIT ${limit + 1}
    `;

    const page = buildPage(rows, limit, (row) => ({
      sortValue: row.placed_at.toISOString(),
      id: row.id,
    }));

    if (page.items.length === 0) {
      return { items: [], hasMore: false };
    }

    const orders = await this.prisma.orders.findMany({
      where: { id: { in: page.items.map((row) => row.id) } },
      include: ORDER_INCLUDE,
    });

    // findMany does not preserve the `in` order, so the page's order is reimposed.
    const byId = new Map(orders.map((order) => [order.id, order]));

    return {
      items: page.items
        .map((row) => byId.get(row.id))
        .filter((order): order is NonNullable<typeof order> => order !== undefined)
        .map((order) => toOrderView(order as unknown as OrderRow)),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /**
   * One order, by its human-facing number.
   *
   * 403 when it exists and belongs to someone else, 404 when there is no such order.
   * The distinction is deliberate: the caller asked about a real thing and is simply
   * not allowed to see it, and order numbers are sequential enough that hiding behind
   * a 404 would be theatre while making every genuine permission problem look like a
   * typo.
   */
  async findForUser(
    orderNumber: string,
    userId: string,
    options: { isAdmin?: boolean } = {},
  ): Promise<OrderView> {
    const order = await this.prisma.orders.findUnique({
      where: { order_number: orderNumber },
      include: ORDER_INCLUDE,
    });

    if (!order) {
      throw Problems.notFound(`No order numbered ${orderNumber}.`);
    }

    if (!options.isAdmin && order.user_id !== userId) {
      throw Problems.forbidden('This order belongs to someone else.');
    }

    return toOrderView(order as unknown as OrderRow);
  }

  /**
   * Cancels an unpaid order and returns its stock to circulation.
   *
   * Idempotent: cancelling an order that is already cancelled returns 200 with the
   * order rather than a 409, because a double-click must not look like a failure.
   * Cancelling a *paid* order is a genuine 409 — that is a refund, which this project
   * does not implement.
   *
   * Releasing the stock and changing the status happen in one transaction. Separately,
   * a crash between them would leave an order cancelled with its stock still held, and
   * nothing would ever release it: the sweeper only looks at expiry, and this
   * reservation's expiry is in the future.
   */
  async cancel(orderNumber: string, userId: string): Promise<OrderView> {
    const orderId = await this.prisma.$transaction(async (tx) => {
      const order = await tx.orders.findUnique({
        where: { order_number: orderNumber },
        select: { id: true, user_id: true, status: true },
      });

      if (!order) {
        throw Problems.notFound(`No order numbered ${orderNumber}.`);
      }

      if (order.user_id !== userId) {
        throw Problems.forbidden('This order belongs to someone else.');
      }

      if (order.status === 'cancelled') {
        return order.id;
      }

      if (!CANCELLABLE_STATUSES.has(order.status)) {
        throw new ProblemException('order-not-cancellable', {
          detail:
            order.status === 'paid'
              ? 'This order has already been paid for. Cancelling a paid order would be a refund, which this shop does not handle automatically.'
              : `An order in state '${order.status}' cannot be cancelled.`,
          errors: [
            {
              field: 'status',
              message: `cannot cancel from '${order.status}'`,
            },
          ],
        });
      }

      const reservations = await tx.stock_reservations.findMany({
        where: { order_id: order.id, status: 'held' },
        select: { id: true, variant_id: true, quantity: true },
      });

      // Ascending variant id, exactly as checkout and the sweeper do. Everything that
      // locks variants sorts them the same way, or two of them deadlock (ADR-004).
      for (const reservation of [...reservations].sort((a, b) =>
        a.variant_id < b.variant_id ? -1 : a.variant_id > b.variant_id ? 1 : 0,
      )) {
        await tx.$queryRaw`
          SELECT id FROM product_variants WHERE id = ${reservation.variant_id}::uuid FOR UPDATE
        `;

        await tx.product_variants.update({
          where: { id: reservation.variant_id },
          data: { stock_reserved: { decrement: reservation.quantity } },
        });

        await tx.stock_reservations.update({
          where: { id: reservation.id },
          data: { status: 'released', resolved_at: new Date() },
        });
      }

      await tx.orders.update({
        where: { id: order.id },
        data: {
          status: 'cancelled',
          cancelled_at: new Date(),
          updated_at: new Date(),
        },
      });

      // The payment is abandoned with the order. It was never charged — it has been
      // sitting in requires_action or processing — so there is nothing to reverse.
      await tx.payments.updateMany({
        where: { order_id: order.id, status: { in: ['requires_action', 'processing'] } },
        data: { status: 'failed', failure_reason: 'Order cancelled', updated_at: new Date() },
      });

      await tx.outbox_events.create({
        data: {
          aggregate_type: 'order',
          aggregate_id: order.id,
          event_type: 'order.cancelled',
          payload: { orderId: order.id, userId },
        },
      });

      return order.id;
    });

    const cancelled = await this.prisma.orders.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });

    return toOrderView(cancelled as unknown as OrderRow);
  }
}
