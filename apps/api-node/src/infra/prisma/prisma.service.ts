import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { ENV, type Env } from '../../config/config.module';

/**
 * The Prisma client, as a Nest provider.
 *
 * `prisma migrate` is never run here and `prisma/migrations` does not exist:
 * Flyway owns the schema and `schema.prisma` is generated *from* the database by
 * `make gen-prisma`. See docs/adr/001.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(@Inject(ENV) env: Env) {
    super({
      datasources: { db: { url: withConnectionLimit(env.DATABASE_URL, env.DB_POOL_SIZE) } },
      // Queries are logged through the application logger, not Prisma's own
      // stdout writer, so they carry the request id like everything else.
      log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit(): Promise<void> {
    // Connect eagerly. Prisma would otherwise connect on first use, which turns a
    // misconfigured DATABASE_URL into a failed request rather than a failed boot —
    // and a container that starts successfully and then 500s is much harder to
    // spot in an orchestrator than one that never reports ready.
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Cheapest possible liveness probe for the readiness endpoint. Deliberately not
   * a query against a real table: this must report on the connection, not on
   * whether the migrations happen to have run.
   */
  async isReachable(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Pins the pool size in the connection string.
 *
 * Prisma's default is `cpu * 2 + 1`, which on a developer machine can be 25 or
 * more. Running both backends at once then opens 50+ connections against a
 * Postgres whose default `max_connections` is 100, and the failure looks like a
 * random "too many clients" error rather than a configuration problem. HikariCP
 * defaults to 10, so both sides are pinned to 10 and behave alike.
 */
function withConnectionLimit(url: string, poolSize: number): string {
  if (url.includes('connection_limit=')) {
    return url;
  }
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${poolSize}`;
}
