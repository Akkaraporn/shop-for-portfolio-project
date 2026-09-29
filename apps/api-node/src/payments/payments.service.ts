import { Injectable } from '@nestjs/common';

import { ProblemException, Problems } from '../common/problem/problem.exception';
import { PrismaService } from '../infra/prisma/prisma.service';
import type { PaymentView } from '../orders/order.types';
import { MockPaymentProvider } from './mock-provider.service';

/** Statuses from which confirming is meaningful. */
const CONFIRMABLE = new Set(['requires_action']);

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: MockPaymentProvider,
  ) {}

  /**
   * Hands a payment to the provider. **Does not fulfil the order.**
   *
   * This marks the payment `processing` and schedules a callback, and that is all.
   * Stock is decremented by the webhook, never here.
   *
   * The asymmetry is the point. Settling the order directly would be less code and
   * would mean the webhook path is never exercised by a test or a demo — so the day a
   * real provider is plugged in, where settlement genuinely is asynchronous, nothing
   * would work and nothing would have warned us.
   */
  async confirm(
    paymentId: string,
    userId: string,
    cardNumber?: string,
  ): Promise<PaymentView> {
    const payment = await this.prisma.payments.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        status: true,
        method: true,
        amount_cents: true,
        currency: true,
        created_at: true,
        failure_reason: true,
        orders: { select: { user_id: true, status: true, order_number: true } },
      },
    });

    if (!payment) {
      throw Problems.notFound('No such payment.');
    }

    // 403, not 404: the payment exists and simply is not theirs.
    if (payment.orders.user_id !== userId) {
      throw Problems.forbidden('This payment belongs to someone else.');
    }

    // Already handed over, or already settled. Returning the current state rather
    // than erroring makes a double-click harmless, which matters on a payment button
    // above all others.
    if (payment.status === 'processing' || payment.status === 'succeeded') {
      return toView(payment);
    }

    if (!CONFIRMABLE.has(payment.status)) {
      throw new ProblemException('payment-not-confirmable', {
        detail: `A payment in state '${payment.status}' cannot be confirmed.`,
        errors: [
          { field: 'status', message: `cannot confirm from '${payment.status}'` },
        ],
      });
    }

    if (payment.orders.status !== 'pending_payment') {
      throw new ProblemException('payment-not-confirmable', {
        detail: `Order ${payment.orders.order_number} is ${payment.orders.status} and is no longer awaiting payment.`,
        errors: [
          { field: 'status', message: `order is '${payment.orders.status}'` },
        ],
      });
    }

    const updated = await this.prisma.payments.update({
      where: { id: payment.id },
      data: { status: 'processing', updated_at: new Date() },
      select: {
        id: true,
        status: true,
        method: true,
        amount_cents: true,
        currency: true,
        created_at: true,
        failure_reason: true,
      },
    });

    // Scheduled after the row is committed, so the callback cannot arrive before the
    // state it is responding to exists.
    this.provider.scheduleCallback(payment.id, cardNumber);

    return toView(updated);
  }
}

function toView(row: {
  id: string;
  status: string;
  method: string;
  amount_cents: bigint;
  currency: string;
  created_at: Date;
  failure_reason: string | null;
}): PaymentView {
  return {
    id: row.id,
    status: row.status as PaymentView['status'],
    method: row.method as PaymentView['method'],
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    createdAt: row.created_at,
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
  };
}
