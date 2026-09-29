/** Matches `Address` in the contract. Stored on the order as a JSONB snapshot. */
export interface AddressView {
  recipientName: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
}

export type OrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'fulfilled'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'payment_failed';

export type PaymentStatus =
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed';

export type PaymentMethod = 'card' | 'promptpay';

/** Matches `OrderItem`. Every descriptive field is a snapshot, not a join. */
export interface OrderItemView {
  id: string;
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  sku: string;
  imageUrl?: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

/** Matches `Payment`. One per order, so the contract embeds it unconditionally. */
export interface PaymentView {
  id: string;
  status: PaymentStatus;
  method: PaymentMethod;
  amountCents: number;
  currency: string;
  createdAt: Date;
  failureReason?: string;
}

/** Matches `Order`. */
export interface OrderView {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  /**
   * Computed by the server so no client carries its own copy of the state machine.
   * Three implementations of one rule is three places to fix it.
   */
  cancellable: boolean;
  items: OrderItemView[];
  shippingAddress: AddressView;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: string;
  payment: PaymentView;
  note?: string;
  placedAt: Date;
  paidAt?: Date;
  reservationExpiresAt?: Date;
}
