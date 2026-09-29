import type {
  AddressView,
  OrderItemView,
  OrderStatus,
  OrderView,
  PaymentMethod,
  PaymentStatus,
  PaymentView,
} from './order.types';

/**
 * The statuses from which an order may still be cancelled.
 *
 * Exported because `cancellable` on every order response is computed from it, and
 * because task 2.6's cancel endpoint must agree with what it advertised. One
 * definition, read in both places — a second copy would drift the moment the rule
 * changed.
 */
export const CANCELLABLE_STATUSES: ReadonlySet<string> = new Set([
  'pending_payment',
]);

/** The row shape the mapper needs: an order with its lines, payment and reservations. */
export interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  subtotal_cents: bigint;
  shipping_cents: bigint;
  total_cents: bigint;
  currency: string;
  shipping_address: unknown;
  note: string | null;
  placed_at: Date;
  paid_at: Date | null;
  order_items: OrderItemRow[];
  /**
   * A single row, not a list: the unique index on payments(order_id) makes this a
   * one-to-one relation, and Prisma models it as a nullable object accordingly.
   */
  payments: PaymentRow | null;
  stock_reservations?: { expires_at: Date }[];
}

interface OrderItemRow {
  id: string;
  variant_id: string;
  product_id: string;
  product_name: string;
  variant_name: string;
  sku: string;
  image_url: string | null;
  unit_price_cents: bigint;
  quantity: number;
  line_total_cents: bigint;
}

interface PaymentRow {
  id: string;
  status: string;
  method: string;
  amount_cents: bigint;
  currency: string;
  created_at: Date;
  failure_reason: string | null;
}

/**
 * Maps a database row onto the contract's `Order`.
 *
 * Shared by checkout, the order endpoints (task 2.6) and the admin list (2.7), so
 * every one of them emits the identical shape. Three hand-written mappers would be
 * three chances to diverge — and the parity suite compares these responses field by
 * field against the Java port.
 *
 * `BIGINT` columns arrive as `bigint`, which `JSON.stringify` cannot serialise, so
 * every money field is narrowed to `number` here. Safe: satang stays far inside
 * `Number.MAX_SAFE_INTEGER` (ADR-002).
 */
export function toOrderView(row: OrderRow): OrderView {
  const payment = row.payments;

  if (!payment) {
    // The unique index on payments(order_id) and the checkout transaction together
    // make this unreachable; failing loudly beats emitting an order with no payment,
    // which the contract declares required.
    throw new Error(`order ${row.order_number} has no payment row`);
  }

  const heldReservation = row.stock_reservations?.[0];

  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status as OrderStatus,
    // Computed server-side so no client reimplements the state machine.
    cancellable: CANCELLABLE_STATUSES.has(row.status),
    items: row.order_items.map(toOrderItemView),
    shippingAddress: row.shipping_address as AddressView,
    subtotalCents: Number(row.subtotal_cents),
    shippingCents: Number(row.shipping_cents),
    totalCents: Number(row.total_cents),
    currency: row.currency,
    payment: toPaymentView(payment),
    ...(row.note ? { note: row.note } : {}),
    placedAt: row.placed_at,
    ...(row.paid_at ? { paidAt: row.paid_at } : {}),
    // Only meaningful while the order is still awaiting payment.
    ...(heldReservation ? { reservationExpiresAt: heldReservation.expires_at } : {}),
  };
}

function toOrderItemView(row: OrderItemRow): OrderItemView {
  return {
    id: row.id,
    variantId: row.variant_id,
    productId: row.product_id,
    productName: row.product_name,
    variantName: row.variant_name,
    sku: row.sku,
    ...(row.image_url ? { imageUrl: row.image_url } : {}),
    unitPriceCents: Number(row.unit_price_cents),
    quantity: row.quantity,
    lineTotalCents: Number(row.line_total_cents),
  };
}

function toPaymentView(row: PaymentRow): PaymentView {
  return {
    id: row.id,
    status: row.status as PaymentStatus,
    method: row.method as PaymentMethod,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    createdAt: row.created_at,
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
  };
}
