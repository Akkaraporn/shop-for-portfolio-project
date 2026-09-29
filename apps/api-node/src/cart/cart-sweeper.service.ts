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

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A short delay after boot, so a restart loop cannot hammer the database. */
const FIRST_SWEEP_DELAY_MS = 60 * 1000;
const LOCK_KEY = 'cart:sweeper:lock';
const LOCK_TTL_SECONDS = 300;
/** Bounded per run so one sweep cannot hold a long transaction over a huge backlog. */
const BATCH_SIZE = 500;

/**
 * Deletes guest baskets whose `expires_at` has passed. Daily is ample.
 *
 * Hand-rolled rather than `@nestjs/schedule`, which is ESM-only at v12 and so cannot
 * be loaded by a CommonJS build under Jest — the same problem that ruled out
 * `@nestjs/jwt` in task 2.2. A single interval is all this needs, and it avoids a
 * dependency that would have to be worked around anyway.
 *
 * The Redis lock keeps two instances from sweeping at once. It is a courtesy, not a
 * correctness mechanism: `deleteMany` on an expired predicate is idempotent, so a
 * double sweep would waste work rather than break anything — which is exactly the
 * standard to hold a best-effort lock to. When Redis is down `acquireLock` returns
 * false and the sweep is skipped, so expired baskets simply live a day longer.
 */
@Injectable()
export class CartSweeperService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    // Tests build the module without wanting a background timer.
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);

    // unref so a pending timer cannot hold the process open during shutdown.
    this.timer.unref();

    const first = setTimeout(() => void this.sweep(), FIRST_SWEEP_DELAY_MS);
    first.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Public so a test or an operator can trigger one run directly. */
  async sweep(): Promise<number> {
    const holdsLock = await this.redis.acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);

    if (!holdsLock) {
      this.logger.debug('cart sweep skipped: lock held or cache unavailable');
      return 0;
    }

    try {
      const expired = await this.prisma.carts.findMany({
        where: { expires_at: { lt: new Date() }, user_id: null },
        select: { id: true },
        take: BATCH_SIZE,
      });

      if (expired.length === 0) {
        return 0;
      }

      // Cascades to cart_items. Nothing else references a cart, so this is a clean
      // delete rather than a soft one — an abandoned guest basket has no history
      // worth keeping, unlike an order.
      const { count } = await this.prisma.carts.deleteMany({
        where: { id: { in: expired.map((cart) => cart.id) } },
      });

      this.logger.info({ count }, 'swept expired guest carts');
      return count;
    } catch (error) {
      // A failed sweep must not crash the process: the baskets are still expired and
      // still unreachable (the resolver filters on expires_at), so the only cost is
      // rows lingering until tomorrow.
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'cart sweep failed',
      );
      return 0;
    } finally {
      await this.redis.releaseLock(LOCK_KEY);
    }
  }
}
