import { Module } from '@nestjs/common';

import { CartController } from './cart.controller';
import { CartResolverService } from './cart-resolver.service';
import { CartService } from './cart.service';
import { CartSweeperService } from './cart-sweeper.service';

@Module({
  controllers: [CartController],
  providers: [CartResolverService, CartService, CartSweeperService],
  // Exported for checkout (task 2.5), which needs to read and clear the basket.
  exports: [CartResolverService, CartService],
})
export class CartModule {}
