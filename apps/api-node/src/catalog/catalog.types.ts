/** Matches `ProductVariant` in the contract. */
export interface ProductVariantView {
  id: string;
  sku: string;
  name: string;
  priceCents: number;
  currency: string;
  /**
   * `stock_on_hand - stock_reserved` at read time. Display only: it may already be
   * stale, and checkout re-verifies under a row lock.
   */
  availableStock: number;
}

/** Matches `ProductImage` in the contract. */
export interface ProductImageView {
  id: string;
  url: string;
  alt?: string;
  position: number;
}

/** Matches `ProductSummary` in the contract. */
export interface ProductSummary {
  id: string;
  slug: string;
  name: string;
  minPriceCents: number;
  currency: string;
  inStock: boolean;
  imageUrl?: string;
  categorySlug?: string;
}

/** Matches `ProductDetail` in the contract: the summary plus variants and images. */
export interface ProductDetail extends ProductSummary {
  description: string;
  status: 'draft' | 'active' | 'archived';
  variants: ProductVariantView[];
  images: ProductImageView[];
  createdAt: Date;
}

/** Matches `Category` in the contract. `children` is omitted on a leaf. */
export interface CategoryNode {
  id: string;
  slug: string;
  name: string;
  productCount: number;
  children?: CategoryNode[];
}
