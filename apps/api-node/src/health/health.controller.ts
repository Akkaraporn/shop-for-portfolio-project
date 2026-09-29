import { Controller, Get, Inject } from '@nestjs/common';

import { Public } from '../auth/decorators/public.decorator';
import { Problems } from '../common/problem/problem.exception';
import { ENV, type Env } from '../config/config.module';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';

type HealthStatus = 'ok' | 'degraded' | 'down';

/** Matches `Health` in the contract. */
interface HealthResponse {
  status: HealthStatus;
  implementation: 'nestjs';
  version: string;
}

/** Matches `Readiness` in the contract. */
interface ReadinessResponse {
  status: HealthStatus;
  implementation: 'nestjs';
  checks: {
    database: HealthStatus;
    cache: HealthStatus;
  };
}

/**
 * The probes, and the demonstration of the whole project.
 *
 * `implementation` is what makes the backend swap visible: the same request
 * through the same gateway returns `nestjs` or `spring-boot` depending only on
 * which compose profile is running, with no change on the client side at all.
 */
@Controller()
// Both probes are unauthenticated: an orchestrator has no credentials, and a
// liveness check that can fail on authentication is a liveness check that will.
@Public()
export class HealthController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Liveness. Touches nothing.
   *
   * Deliberately not a dependency check: this is what an orchestrator restarts the
   * container on, and restarting the API because the database is briefly
   * unreachable turns one outage into two. Dependency state belongs to /ready.
   */
  @Get('health')
  health(): HealthResponse {
    return {
      status: 'ok',
      implementation: 'nestjs',
      version: this.env.APP_VERSION,
    };
  }

  /**
   * Readiness. Checks dependencies, and treats them differently on purpose.
   *
   * Postgres is required: without it nothing can be served, so its absence is a
   * 503 and a load balancer should take this instance out. Redis is reported but
   * never gates readiness — the project rule is that losing the cache makes the
   * system slower and never wrong, so a cache outage yields 200 with
   * `status: degraded`. Gating on Redis would let a cache blip take down a shop
   * that is perfectly capable of serving every request from Postgres.
   */
  @Get('ready')
  async ready(): Promise<ReadinessResponse> {
    const [databaseUp, cacheUp] = await Promise.all([
      this.prisma.isReachable(),
      this.redis.ping(),
    ]);

    if (!databaseUp) {
      throw Problems.unavailable('The database is not reachable.');
    }

    return {
      status: cacheUp ? 'ok' : 'degraded',
      implementation: 'nestjs',
      checks: {
        database: 'ok',
        cache: cacheUp ? 'ok' : 'down',
      },
    };
  }
}
