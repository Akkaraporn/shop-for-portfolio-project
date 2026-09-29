import { Module } from '@nestjs/common';

import { MockPaymentProvider } from './mock-provider.service';
import { PaymentsController, WebhooksController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { WebhookService } from './webhook.service';

@Module({
  controllers: [PaymentsController, WebhooksController],
  providers: [PaymentsService, WebhookService, MockPaymentProvider],
  exports: [MockPaymentProvider, WebhookService],
})
export class PaymentsModule {}
