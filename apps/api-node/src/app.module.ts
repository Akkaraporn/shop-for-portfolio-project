import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CartModule } from './cart/cart.module';
import { CatalogModule } from './catalog/catalog.module';
import { CheckoutModule } from './checkout/checkout.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
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
 * The two guards are registered here because they need the DI container. Their
 * order is significant: JwtAuthGuard attaches the user, RolesGuard reads it.
 * Authentication being global means an endpoint is protected unless it opts out
 * with @Public() or @OptionalAuth(), so a forgotten annotation fails closed.

 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    PrismaModule,
    RedisModule,
    AuthModule,
    CatalogModule,
    CartModule,
    CheckoutModule,
    OrdersModule,
    PaymentsModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
