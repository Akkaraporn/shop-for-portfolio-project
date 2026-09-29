import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import type { Logger } from 'pino';

import { ENV, type Env } from '../../config/config.module';
import { LOGGER } from '../../common/logging/logger.module';

/**
 * Redis, treated as optional infrastructure throughout.
 *
 * The project rule is that losing Redis entirely makes the system slower and
 * never wrong: it caches the category tree, backs rate limiting, and holds the
 * sweeper's lock, and nothing lives here and nowhere else. So every method
 * degrades rather than throws — a cache miss and a dead cache are the same thing
 * to a caller, and forcing each one to handle a Redis exception is how an outage
 * in a cache becomes an outage in a shop.
 *
 * `enableOfflineQueue: false` is what makes that real. With ioredis's default,
 * commands issued while disconnected are buffered and their promises hang until
 * the connection returns, so a Redis outage would present as request timeouts
 * rather than as cache misses.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: Redis;
  private connected = false;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      // Reconnect with backoff, forever. A cache that gives up permanently after
      // a blip would silently halve the application's performance until someone
      // noticed and restarted it.
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });

    this.client.on('ready', () => {
      this.connected = true;
      this.logger.info('redis connected');
    });

    this.client.on('end', () => {
      this.connected = false;
    });

    // Without a handler ioredis emits an unhandled 'error' event, which in Node
    // terminates the process — a dead cache would take the whole API down.
    this.client.on('error', (error: Error) => {
      if (this.connected) {
        this.logger.warn({ err: error.message }, 'redis error, degrading to no cache');
      }
      this.connected = false;
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      // Boot succeeds without Redis, on purpose. The readiness probe reports the
      // cache as down and the application serves every request from Postgres.
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'redis unavailable at startup, continuing without cache',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    // quit() waits for a reply, which never comes if the server is already gone.
    this.client.disconnect();
  }

  async ping(): Promise<boolean> {
    if (!this.connected) {
      return false;
    }
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.connected) {
      return null;
    }
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  /** Sets a key with a TTL in seconds. Returns whether it was actually stored. */
  async set(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (!this.connected) {
      return false;
    }
    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
      return true;
    } catch {
      return false;
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.connected || keys.length === 0) {
      return;
    }
    try {
      await this.client.del(...keys);
    } catch {
      // Losing an invalidation is survivable: the key still expires on its TTL.
    }
  }

  /**
   * Best-effort mutual exclusion via `SET NX EX`, for the reservation sweeper in
   * task 2.5.
   *
   * Returns false when the lock is held *and* when Redis is unreachable. The
   * caller must treat "no lock" as "do not run": for the sweeper that means an
   * expired reservation is collected a minute later instead of twice at once,
   * which is the safe direction. This is not a correctness primitive — the
   * sweeper's own updates are what have to be idempotent.
   */
  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    if (!this.connected) {
      return false;
    }
    try {
      const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch {
      return false;
    }
  }

  async releaseLock(key: string): Promise<void> {
    await this.del(key);
  }
}
