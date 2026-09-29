import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ProblemException, type FieldError } from '../common/problem/problem.exception';
import { ENV, type Env } from '../config/config.module';
import { PrismaService } from '../infra/prisma/prisma.service';
import { toOrderView } from '../orders/order.mapper';
import type { OrderView } from '../orders/order.types';
import type { CheckoutDto } from './dto/checkout.dto';
import { IdempotencyService } from './idempotency.service';

/** A variant row as returned by the locking read. */
interface LockedVariant {
  id: string;
  price_cents: bigint;
  stock_on_hand: number;
  stock_reserved: number;
  is_active: boolean;
  product_id: string;
  product_name: string;
  product_status: string;
  variant_name: string;
  sku: string;
  image_url: string | null;
}

@Injectable()
export class CheckoutService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Turns a basket into an order, reserving stock against it.
   *
   * The whole body is one transaction and the step order is not negotiable:
   *
   *   1. lock every variant, in ascending id order   (deadlock avoidance)
   *   2. re-verify stock for every line              (collect all failures)
   *   3. increment stock_reserved
   *   4. insert the reservations
   *   5. insert the order and its snapshotted lines
   *   6. insert the payment
   *   7. insert the outbox event
   *   8. clear the basket
   *
   * Nothing is charged here and no stock is decremented. A reservation is a promise;
   * the webhook is what makes it real (task 2.6).
   *
   * The idempotency key is claimed *before* this runs and completed *inside* it — see
   * IdempotencyService for why the two phases cannot be merged.
   */
  async checkout(
    userId: string,
    cartId: string,
    dto: CheckoutDto,
    idempotency: { endpoint: string; key: string; status: number },
  ): Promise<{ order: OrderView; orderId: string }> {
    return this.prisma.$transaction(
      async (tx) => {
        const lines = await tx.cart_items.findMany({
          where: { cart_id: cartId },
          select: { variant_id: true, quantity: true },
        });

        if (lines.length === 0) {
          throw new ProblemException('validation-failed', {
            detail: 'The basket is empty.',
            errors: [{ field: 'cart', message: 'is empty' }],
          });
        }

        const variants = await this.lockVariantsInIdOrder(
          tx,
          lines.map((line) => line.variant_id),
        );

        const priced = this.verifyStock(lines, variants);

        // --- 3 & 4: reserve -------------------------------------------------
        const reservationExpiry = new Date(
          Date.now() + this.env.RESERVATION_TTL_MINUTES * 60 * 1000,
        );

        // --- 5: the order ---------------------------------------------------
        const subtotalCents = priced.reduce(
          (total, line) => total + line.lineTotalCents,
          0,
        );
        const shippingCents = this.env.SHIPPING_FLAT_CENTS;

        const order = await tx.orders.create({
          data: {
            order_number: await nextOrderNumber(tx),
            user_id: userId,
            status: 'pending_payment',
            subtotal_cents: subtotalCents,
            shipping_cents: shippingCents,
            total_cents: subtotalCents + shippingCents,
            currency: this.env.CURRENCY,
            shipping_address: dto.shippingAddress as unknown as Prisma.InputJsonValue,
            ...(dto.note ? { note: dto.note } : {}),
            order_items: {
              create: priced.map((line) => ({
                variant_id: line.variantId,
                product_id: line.productId,
                // Every descriptive field is copied, not referenced. Repricing or
                // archiving a product must never change what someone was charged.
                product_name: line.productName,
                variant_name: line.variantName,
                sku: line.sku,
                image_url: line.imageUrl,
                unit_price_cents: line.unitPriceCents,
                quantity: line.quantity,
                line_total_cents: line.lineTotalCents,
              })),
            },
          },
          select: { id: true },
        });

        for (const line of priced) {
          await tx.product_variants.update({
            where: { id: line.variantId },
            data: { stock_reserved: { increment: line.quantity } },
          });

          await tx.stock_reservations.create({
            data: {
              order_id: order.id,
              variant_id: line.variantId,
              quantity: line.quantity,
              status: 'held',
              expires_at: reservationExpiry,
            },
          });
        }

        // --- 6: the payment -------------------------------------------------
        await tx.payments.create({
          data: {
            order_id: order.id,
            status: 'requires_action',
            method: dto.paymentMethod,
            amount_cents: subtotalCents + shippingCents,
            currency: this.env.CURRENCY,
            provider: 'mock',
          },
        });

        // --- 7: the outbox --------------------------------------------------
        // Written in the same transaction as the state change it describes, which is
        // the entire point of the pattern: there is no window where the order exists
        // and the event does not. Nothing consumes it — the table is evidence the
        // design accounts for async delivery, and a real broker is out of scope.
        await tx.outbox_events.create({
          data: {
            aggregate_type: 'order',
            aggregate_id: order.id,
            event_type: 'order.placed',
            payload: {
              orderId: order.id,
              userId,
              totalCents: subtotalCents + shippingCents,
            } as Prisma.InputJsonValue,
          },
        });

        // --- 8: empty the basket ---------------------------------------------
        // The basket row survives; only its lines go. The shopper keeps the same
        // basket id, and a guest's token stays valid.
        await tx.cart_items.deleteMany({ where: { cart_id: cartId } });
        await tx.carts.update({
          where: { id: cartId },
          data: { updated_at: new Date() },
        });

        const view = await loadOrderView(tx, order.id);

        // Inside the transaction, deliberately. The stored response and the order it
        // describes commit together or not at all — recorded outside, a response could
        // survive a rollback and replay an order that does not exist.
        await this.idempotency.complete(
          tx,
          userId,
          idempotency.endpoint,
          idempotency.key,
          idempotency.status,
          view,
        );

        return { order: view, orderId: order.id };
      },
      {
        // Longer than the default 5s: this holds row locks while it works, and a
        // timeout mid-flight would roll back an order the client may already believe
        // in. Still bounded, so a pathological case cannot hold locks indefinitely.
        timeout: 15_000,
        maxWait: 10_000,
      },
    );
  }

  /**
   * Locks the variants, one at a time, in ascending id order.
   *
   * The ordering is the deadlock defence. Two baskets sharing items in opposite
   * orders would otherwise take locks in opposite orders — A holds X and waits for Y
   * while B holds Y and waits for X — and Postgres would kill one of them. Sorting
   * first means every transaction takes the same locks in the same sequence, so the
   * later one simply waits.
   *
   * One query per id rather than `WHERE id = ANY(...) ORDER BY id FOR UPDATE`. That
   * single-query form looks equivalent and usually behaves, but PostgreSQL does not
   * guarantee that rows are *locked* in the order they are returned — the planner is
   * free to use a bitmap scan and lock in physical order, which would silently
   * reintroduce the deadlock under exactly the concurrency this is protecting. A
   * handful of round trips inside one transaction is a small price for a guarantee.
   *
   * **The Java port must sort identically**, on the canonical lowercase string form
   * (ADR-008), or the cross-backend concurrency test fails against one of them.
   */
  private async lockVariantsInIdOrder(
    tx: Prisma.TransactionClient,
    variantIds: string[],
  ): Promise<Map<string, LockedVariant>> {
    const ordered = [...new Set(variantIds)].sort();
    const locked = new Map<string, LockedVariant>();

    for (const id of ordered) {
      const rows = await tx.$queryRaw<LockedVariant[]>`
        SELECT
          v.id,
          v.price_cents,
          v.stock_on_hand,
          v.stock_reserved,
          v.is_active,
          v.name        AS variant_name,
          v.sku,
          p.id          AS product_id,
          p.name        AS product_name,
          p.status      AS product_status,
          (
            SELECT pi.url FROM product_images pi
            WHERE pi.product_id = p.id ORDER BY pi.position LIMIT 1
          ) AS image_url
        FROM product_variants v
        JOIN products p ON p.id = v.product_id
        WHERE v.id = ${id}::uuid
        FOR UPDATE OF v
      `;

      const row = rows[0];
      if (row) {
        locked.set(row.id, row);
      }
    }

    return locked;
  }

  /**
   * Re-verifies every line under the lock, and reports **all** the failures at once.
   *
   * The availability shown while browsing is computed at read time and is explicitly
   * advisory; this is the only check that decides anything. Reporting one short line
   * at a time would make a shopper fix their basket, retry, and be told about the next
   * one — so every failure goes into a single 409.
   */
  private verifyStock(
    lines: { variant_id: string; quantity: number }[],
    variants: Map<string, LockedVariant>,
  ): {
    variantId: string;
    productId: string;
    productName: string;
    variantName: string;
    sku: string;
    imageUrl: string | null;
    unitPriceCents: number;
    quantity: number;
    lineTotalCents: number;
  }[] {
    const errors: FieldError[] = [];
    const priced: ReturnType<CheckoutService['verifyStock']> = [];

    lines.forEach((line, index) => {
      const variant = variants.get(line.variant_id);

      // Disappeared, deactivated, or its product was archived while it sat in the
      // basket. Reported as a short line rather than a 404, because the caller's
      // request was fine — the catalogue moved underneath it, and the fix is the same.
      if (!variant || !variant.is_active || variant.product_status !== 'active') {
        errors.push({
          field: `items[${index}]`,
          message: 'No longer available',
          variantId: line.variant_id,
          requested: line.quantity,
          available: 0,
        });
        return;
      }

      const available = variant.stock_on_hand - variant.stock_reserved;

      if (available < line.quantity) {
        errors.push({
          field: `items[${index}]`,
          message: available === 0 ? 'Out of stock' : `Only ${available} left`,
          variantId: line.variant_id,
          requested: line.quantity,
          available,
        });
        return;
      }

      const unitPriceCents = Number(variant.price_cents);
      priced.push({
        variantId: variant.id,
        productId: variant.product_id,
        productName: variant.product_name,
        variantName: variant.variant_name,
        sku: variant.sku,
        imageUrl: variant.image_url,
        // The price is read under the lock, so the amount charged is the amount that
        // was true at the instant the order was created.
        unitPriceCents,
        quantity: line.quantity,
        lineTotalCents: unitPriceCents * line.quantity,
      });
    });

    if (errors.length > 0) {
      throw new ProblemException('insufficient-stock', {
        detail: `${errors.length} item${errors.length === 1 ? '' : 's'} in your basket cannot be fulfilled.`,
        errors,
      });
    }

    return priced;
  }
}

/**
 * `ORD-<year>-<7 digits>`, from a shared sequence.
 *
 * The sequence is global rather than per-year, so the numbers do not restart each
 * January — a per-year reset would need either a counter table (contention on every
 * checkout) or a trigger (banned by ADR-003's reasoning). The year is therefore
 * decorative, which is fine for something whose only jobs are to be unique and
 * readable. Both backends must call the same sequence.
 */
async function nextOrderNumber(tx: Prisma.TransactionClient): Promise<string> {
  const [{ nextval }] = await tx.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('order_number_seq') AS nextval
  `;

  const year = new Date().getUTCFullYear();
  return `ORD-${year}-${nextval.toString().padStart(7, '0')}`;
}

/** Reads a freshly written order back in the contract's shape. */
async function loadOrderView(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<OrderView> {
  const order = await tx.orders.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      order_items: true,
      payments: true,
      stock_reservations: { where: { status: 'held' }, take: 1 },
    },
  });

  return toOrderView(order);
}
