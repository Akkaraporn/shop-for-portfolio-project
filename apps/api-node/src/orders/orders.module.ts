import { Module } from '@nestjs/common';

import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService],
  // Exported for the payments module, which reads an order back after a webhook, and
  // for the admin list in task 2.7.
  exports: [OrdersService],
})
export class OrdersModule {}
