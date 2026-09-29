import { Module } from '@nestjs/common';

import { CartModule } from '../cart/cart.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { IdempotencyService } from './idempotency.service';
import { ReservationSweeperService } from './reservation-sweeper.service';

@Module({
  // For CartResolverService: checkout reads the caller's basket the same way every
  // cart endpoint does, rather than re-deriving which basket is theirs.
  imports: [CartModule],
  controllers: [CheckoutController],
  providers: [CheckoutService, IdempotencyService, ReservationSweeperService],
  // IdempotencyService is exported because task 2.6's cancel and 2.7's admin writes
  // are the next candidates for the same guard.
  exports: [IdempotencyService],
})
export class CheckoutModule {}
