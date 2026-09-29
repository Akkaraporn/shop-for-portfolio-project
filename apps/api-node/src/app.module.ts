import { Module } from '@nestjs/common';

import { LoggerModule } from './common/logging/logger.module';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';

/**
 * Import order matters for the first two: ConfigModule validates the environment
 * and LoggerModule needs LOG_LEVEL from it. Everything after depends on one or both.
 *
 * Global filters, pipes and the request-id middleware are applied in
 * src/bootstrap.ts rather than here, so the test suite and main.ts share one
 * definition of the pipeline.
 *
 * Feature modules (auth, catalog, cart, checkout, orders, payments, admin) arrive
 * with tasks 2.2 through 2.7. This task builds only what all of them need.
 */
@Module({
  imports: [ConfigModule, LoggerModule, PrismaModule, RedisModule, HealthModule],
})
export class AppModule {}
