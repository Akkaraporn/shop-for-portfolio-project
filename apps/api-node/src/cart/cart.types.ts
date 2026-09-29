/** Matches `CartItem` in the contract. Prices here are live, not snapshots. */
export interface CartItemView {
  id: string;
  variantId: string;
  productId: string;
  slug: string;
  productName: string;
  variantName: string;
  sku: string;
  imageUrl?: string;
  /** The variant's price right now. Changes if the product is repriced. */
  unitPriceCents: number;
  quantity: number;
  /** `unitPriceCents x quantity`, recomputed on every read. */
  lineTotalCents: number;
  currency: string;
  /** Advisory. Checkout re-verifies under a row lock. */
  availableStock: number;
}

/**
 * Matches `Cart` in the contract.
 *
 * Carries a subtotal but no shipping and no grand total: those are computed at
 * checkout, so a basket never implies a final price it cannot honour.
 */
export interface CartView {
  id: string;
  items: CartItemView[];
  itemCount: number;
  subtotalCents: number;
  currency: string;
  updatedAt: Date;
  /** Guest baskets only. A signed-in user's basket does not expire. */
  expiresAt?: Date;
}
