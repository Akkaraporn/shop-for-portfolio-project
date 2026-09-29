import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import { LOGGER } from '../common/logging/logger.module';
import { ENV, type Env } from '../config/config.module';
import { SIGNATURE_HEADER, signWebhookBody } from './webhook-signature';

/** Cards with a defined outcome, so a demo is deterministic. */
const DECLINED_CARD = '4000000000000002';

@Injectable()
export class MockPaymentProvider {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Decides the outcome the way a test card would.
   *
   * Anything other than the declined card succeeds, so the happy path is the default
   * and a demo never has to remember a magic number.
   */
  outcomeFor(cardNumber?: string): 'payment.succeeded' | 'payment.failed' {
    return cardNumber === DECLINED_CARD ? 'payment.failed' : 'payment.succeeded';
  }

  /**
   * Schedules a callback, the way a real provider would.
   *
   * Fire-and-forget on a timer, and then a genuine HTTP request back to this
   * service's own webhook endpoint — signed, over the wire, through the same handler
   * an external provider would hit. Calling the handler in-process would be simpler
   * and would exercise none of the things that actually break: the signature over the
   * raw bytes, the JSON parsing, the deduplication.
   *
   * Errors are logged and swallowed. This stands in for a third party; it must never
   * be able to fail the request that scheduled it.
   */
  scheduleCallback(paymentId: string, cardNumber?: string): void {
    const type = this.outcomeFor(cardNumber);
    const delay = this.env.PAYMENT_MOCK_DELAY_MS;

    const timer = setTimeout(() => {
      void this.deliver(paymentId, type).catch((error: unknown) => {
        this.logger.error(
          {
            paymentId,
            err: error instanceof Error ? error.message : String(error),
          },
          'mock provider callback failed',
        );
      });
    }, delay);

    // unref so a pending callback cannot hold the process open during shutdown.
    timer.unref();

    this.logger.info({ paymentId, type, delay }, 'mock provider callback scheduled');
  }

  /** Builds, signs and posts one event. Exposed so a test can deliver synchronously. */
  async deliver(
    paymentId: string,
    type: 'payment.succeeded' | 'payment.failed',
  ): Promise<void> {
    const event = {
      id: `evt_${randomUUID()}`,
      type,
      createdAt: new Date().toISOString(),
      data: {
        paymentId,
        ...(type === 'payment.failed'
          ? { failureReason: 'The card was declined.' }
          : {}),
      },
    };

    // The exact bytes that are signed are the exact bytes that are sent. Signing a
    // re-serialisation would be the same bug the handler guards against from the
    // other side.
    const body = JSON.stringify(event);
    const signature = signWebhookBody(this.env.PAYMENT_WEBHOOK_SECRET, body);

    const response = await fetch(`${this.env.SELF_BASE_URL}/api/v1/webhooks/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SIGNATURE_HEADER]: signature,
      },
      body,
    });

    this.logger.info(
      { paymentId, type, status: response.status },
      'mock provider callback delivered',
    );
  }
}
