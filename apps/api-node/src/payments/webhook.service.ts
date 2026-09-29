import { Injectable, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Logger } from 'pino';

import { LOGGER } from '../common/logging/logger.module';
import { PrismaService } from '../infra/prisma/prisma.service';

export const PROVIDER = 'mock';

export interface PaymentWebhookEvent {
  id: string;
  type: string;
  createdAt?: string;
  data: { paymentId: string; failureReason?: string };
}

export interface WebhookAck {
  received: true;
  applied: boolean;
}

/**
 * Inbound provider callbacks. **This is where stock actually moves.**
 *
 * Everything before this point is a promise: checkout reserves, confirm hands the
 * payment to the provider. Only a `payment.succeeded` callback turns a reservation
 * into a sale and decrements `stock_on_hand`.
 *
 * Keeping that asymmetry is the whole reason this path is worth writing. If `confirm`
 * settled the order directly, the webhook would never be exercised by any test or
 * demo, and swapping in a real provider — where settlement genuinely is asynchronous
 * — would break on the first payment.
 */
@Injectable()
export class WebhookService {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Applies an event, exactly once.
   *
   * Returns rather than throws for every outcome a provider could retry on. The caller
   * answers 200 regardless — see the controller for why.
   */
  async handle(event: PaymentWebhookEvent): Promise<WebhookAck> {
    // Dedupe first, and in its own statement. `ON CONFLICT DO NOTHING` returns zero
    // rows when the event has been seen, which is the entire deduplication mechanism:
    // providers redeliver, and stock must move exactly once.
    const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO webhook_events (provider, event_id, event_type, payload)
      VALUES (${PROVIDER}, ${event.id}, ${event.type}, ${JSON.stringify(event)}::jsonb)
      ON CONFLICT (provider, event_id) DO NOTHING
      RETURNING id
    `;

    if (inserted.length === 0) {
      this.logger.info(
        { eventId: event.id, type: event.type },
        'webhook already processed, ignoring redelivery',
      );
      return { received: true, applied: false };
    }

    const webhookEventId = inserted[0].id;

    try {
      const applied = await this.apply(event);

      await this.prisma.webhook_events.update({
        where: { id: webhookEventId },
        data: { processed_at: new Date() },
      });

      return { received: true, applied };
    } catch (error) {
      // The event row stays, unprocessed. That is deliberate: a redelivery will be
      // deduplicated rather than retried, so a genuine processing failure needs a
      // human. Logging it with the traceId is how they find it — and answering 200
      // stops the provider retrying something that will fail identically.
      this.logger.error(
        {
          eventId: event.id,
          type: event.type,
          err: error instanceof Error ? error.message : String(error),
        },
        'webhook accepted but could not be processed',
      );
      return { received: true, applied: false };
    }
  }

  private async apply(event: PaymentWebhookEvent): Promise<boolean> {
    switch (event.type) {
      case 'payment.succeeded':
        return this.settle(event.data.paymentId);
      case 'payment.failed':
        return this.fail(event.data.paymentId, event.data.failureReason);
      default:
        // An unrecognised type is normal, not an error: a provider adds event types
        // without asking. Acknowledged and ignored.
        this.logger.info({ type: event.type }, 'ignoring unrecognised webhook type');
        return false;
    }
  }

  /**
   * Commits the reservation: the moment a promise becomes a sale.
   *
   * `stock_on_hand` and `stock_reserved` both decrease by the same amount. Decrementing
   * only `stock_on_hand` would leave the units permanently reserved; only
   * `stock_reserved` would give the stock back while also selling it.
   */
  private async settle(paymentId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payments.findUnique({
        where: { id: paymentId },
        select: { id: true, status: true, order_id: true },
      });

      if (!payment) {
        this.logger.warn({ paymentId }, 'webhook references an unknown payment');
        return false;
      }

      if (payment.status === 'succeeded') {
        // Already settled by an earlier delivery whose dedupe row was rolled back, or
        // by a manual intervention. Nothing to do, and doing it again would double
        // count.
        return false;
      }

      const reservations = await tx.stock_reservations.findMany({
        where: { order_id: payment.order_id, status: 'held' },
        select: { id: true, variant_id: true, quantity: true },
      });

      // Ascending variant id, like everything else that locks variants (ADR-004).
      for (const reservation of [...reservations].sort((a, b) =>
        a.variant_id < b.variant_id ? -1 : a.variant_id > b.variant_id ? 1 : 0,
      )) {
        await tx.$queryRaw`
          SELECT id FROM product_variants WHERE id = ${reservation.variant_id}::uuid FOR UPDATE
        `;

        await tx.product_variants.update({
          where: { id: reservation.variant_id },
          data: {
            stock_on_hand: { decrement: reservation.quantity },
            stock_reserved: { decrement: reservation.quantity },
          },
        });

        await tx.stock_reservations.update({
          where: { id: reservation.id },
          data: { status: 'committed', resolved_at: new Date() },
        });
      }

      const paidAt = new Date();

      await tx.payments.update({
        where: { id: payment.id },
        data: { status: 'succeeded', updated_at: paidAt },
      });

      // Only an order still awaiting payment becomes paid. One cancelled or expired in
      // the meantime keeps the status it earned; the stock movement above is still
      // right, because its reservations would already be released and the loop a no-op.
      await tx.orders.updateMany({
        where: { id: payment.order_id, status: 'pending_payment' },
        data: { status: 'paid', paid_at: paidAt, updated_at: paidAt },
      });

      await tx.outbox_events.create({
        data: {
          aggregate_type: 'order',
          aggregate_id: payment.order_id,
          event_type: 'order.paid',
          payload: { orderId: payment.order_id, paymentId: payment.id },
        },
      });

      return true;
    });
  }

  /** Releases the hold and marks the order `payment_failed`. The stock goes back. */
  private async fail(paymentId: string, reason?: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payments.findUnique({
        where: { id: paymentId },
        select: { id: true, status: true, order_id: true },
      });

      if (!payment || payment.status === 'succeeded' || payment.status === 'failed') {
        return false;
      }

      const reservations = await tx.stock_reservations.findMany({
        where: { order_id: payment.order_id, status: 'held' },
        select: { id: true, variant_id: true, quantity: true },
      });

      for (const reservation of [...reservations].sort((a, b) =>
        a.variant_id < b.variant_id ? -1 : a.variant_id > b.variant_id ? 1 : 0,
      )) {
        await tx.$queryRaw`
          SELECT id FROM product_variants WHERE id = ${reservation.variant_id}::uuid FOR UPDATE
        `;

        await tx.product_variants.update({
          where: { id: reservation.variant_id },
          data: { stock_reserved: { decrement: reservation.quantity } },
        });

        await tx.stock_reservations.update({
          where: { id: reservation.id },
          data: { status: 'released', resolved_at: new Date() },
        });
      }

      await tx.payments.update({
        where: { id: payment.id },
        data: {
          status: 'failed',
          // The column only accepts a reason on a failed row (payments_failure_reason_check).
          failure_reason: (reason ?? 'Payment declined').slice(0, 200),
          updated_at: new Date(),
        },
      });

      await tx.orders.updateMany({
        where: { id: payment.order_id, status: 'pending_payment' },
        data: { status: 'payment_failed', updated_at: new Date() },
      });

      await tx.outbox_events.create({
        data: {
          aggregate_type: 'order',
          aggregate_id: payment.order_id,
          event_type: 'order.payment_failed',
          payload: {
            orderId: payment.order_id,
            paymentId: payment.id,
          } as Prisma.InputJsonValue,
        },
      });

      return true;
    });
  }
}
