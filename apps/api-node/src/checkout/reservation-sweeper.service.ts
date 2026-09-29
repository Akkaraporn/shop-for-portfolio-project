import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Logger } from 'pino';

import { LOGGER } from '../common/logging/logger.module';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';

const SWEEP_INTERVAL_MS = 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 15 * 1000;
const LOCK_KEY = 'reservations:sweeper:lock';
/** Shorter than the interval, so a crashed sweeper's lock frees before the next run. */
const LOCK_TTL_SECONDS = 50;
/** Bounded per run, so one sweep cannot hold locks across a huge backlog. */
const BATCH_SIZE = 100;

interface ExpiredReservation {
  id: string;
  order_id: string;
  variant_id: string;
  quantity: number;
}

/**
 * Releases stock held by checkouts that were never paid for.
 *
 * Without this, one abandoned checkout takes its stock out of circulation forever.
 * With it, the reservation is the only thing standing between "promised" and
 * "available", and it has a deadline.
 *
 * Runs every minute — the reservation TTL is 15 minutes, so a minute of lateness is
 * immaterial, and a short interval keeps each batch small.
 *
 * Hand-rolled rather than `@nestjs/schedule`, which is ESM-only at v12 and unusable
 * from a CommonJS build under Jest. One interval is all this needs.
 */
@Injectable()
export class ReservationSweeperService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();

    const first = setTimeout(() => void this.sweep(), FIRST_SWEEP_DELAY_MS);
    first.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /**
   * Releases every reservation whose hold has lapsed. Returns how many.
   *
   * The Redis lock keeps two instances from sweeping the same rows at once. It is a
   * throughput optimisation rather than a correctness mechanism: each order is
   * released in its own transaction that re-reads the reservation under a row lock and
   * does nothing if it is no longer `held`, so a double sweep is a no-op. When Redis is
   * unreachable `acquireLock` returns false and the run is skipped — stock is released
   * a minute later instead, which is the safe direction.
   */
  async sweep(): Promise<number> {
    const holdsLock = await this.redis.acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);

    if (!holdsLock) {
      this.logger.debug('reservation sweep skipped: lock held or cache unavailable');
      return 0;
    }

    try {
      const expired = await this.prisma.$queryRaw<ExpiredReservation[]>`
        SELECT id, order_id, variant_id, quantity
        FROM stock_reservations
        WHERE status = 'held' AND expires_at < now()
        ORDER BY expires_at
        LIMIT ${BATCH_SIZE}
      `;

      if (expired.length === 0) {
        return 0;
      }

      // Grouped by order, because an order is the unit that expires: releasing half
      // an order's lines would leave it neither payable nor fully released.
      const byOrder = new Map<string, ExpiredReservation[]>();
      for (const reservation of expired) {
        const group = byOrder.get(reservation.order_id) ?? [];
        group.push(reservation);
        byOrder.set(reservation.order_id, group);
      }

      let released = 0;

      for (const [orderId, reservations] of byOrder) {
        released += await this.releaseOrder(orderId, reservations);
      }

      if (released > 0) {
        this.logger.info(
          { reservations: released, orders: byOrder.size },
          'released expired stock reservations',
        );
      }

      return released;
    } catch (error) {
      // A failed sweep must not crash the process. The reservations are still
      // expired and will be picked up next minute.
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'reservation sweep failed',
      );
      return 0;
    } finally {
      await this.redis.releaseLock(LOCK_KEY);
    }
  }

  /**
   * Releases one order's reservations, in its own transaction.
   *
   * Variants are locked in ascending id order, exactly as checkout does. The sweeper
   * and a checkout can touch the same variant at the same moment, and if they took
   * locks in different orders they would deadlock — so the rule is not "checkout sorts
   * its locks", it is "everything that locks variants sorts them the same way".
   */
  private async releaseOrder(
    orderId: string,
    reservations: ExpiredReservation[],
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      let released = 0;

      for (const reservation of [...reservations].sort((a, b) =>
        a.variant_id < b.variant_id ? -1 : a.variant_id > b.variant_id ? 1 : 0,
      )) {
        await tx.$queryRaw`
          SELECT id FROM product_variants WHERE id = ${reservation.variant_id}::uuid FOR UPDATE
        `;

        // Re-read under the lock. A webhook may have committed this reservation in
        // the moment between the batch query and here, in which case the stock is
        // already accounted for and touching it would double-count.
        const current = await tx.stock_reservations.findFirst({
          where: { id: reservation.id, status: 'held' },
          select: { id: true, quantity: true, variant_id: true },
        });

        if (!current) {
          continue;
        }

        await tx.product_variants.update({
          where: { id: current.variant_id },
          data: { stock_reserved: { decrement: current.quantity } },
        });

        await tx.stock_reservations.update({
          where: { id: current.id },
          data: { status: 'released', resolved_at: new Date() },
        });

        released += 1;
      }

      if (released > 0) {
        // Only an order still awaiting payment expires. One that was paid or
        // cancelled in the meantime keeps the status it earned.
        await tx.orders.updateMany({
          where: { id: orderId, status: 'pending_payment' },
          data: { status: 'expired', updated_at: new Date() },
        });

        await tx.outbox_events.create({
          data: {
            aggregate_type: 'order',
            aggregate_id: orderId,
            event_type: 'order.expired',
            payload: { orderId },
          },
        });
      }

      return released;
    });
  }
}
