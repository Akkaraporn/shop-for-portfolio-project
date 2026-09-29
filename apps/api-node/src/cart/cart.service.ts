import { Injectable } from '@nestjs/common';

import { ProblemException, Problems } from '../common/problem/problem.exception';
import { PrismaService } from '../infra/prisma/prisma.service';
import { hashCartToken } from './cart-resolver.service';
import type { CartItemView, CartView } from './cart.types';

/** The contract's per-line maximum. */
export const MAX_LINE_QUANTITY = 99;

/** Everything a cart line needs in order to be rendered. */
const LINE_INCLUDE = {
  product_variants: {
    select: {
      id: true,
      sku: true,
      name: true,
      price_cents: true,
      stock_on_hand: true,
      stock_reserved: true,
      is_active: true,
      products: {
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          currency: true,
          product_images: {
            orderBy: { position: 'asc' as const },
            take: 1,
            select: { url: true },
          },
        },
      },
    },
  },
} as const;

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads the basket, recomputing every line from the variant's **current** price.
   *
   * No price is stored on `cart_items`, deliberately. Caching one would let a shopper
   * carry a stale price all the way to the payment step and discover the change
   * there, which is the worst possible moment. A basket shows live prices; only
   * `order_items` freezes them, at checkout.
   */
  async view(cartId: string): Promise<CartView> {
    const cart = await this.prisma.carts.findUnique({
      where: { id: cartId },
      select: {
        id: true,
        currency: true,
        updated_at: true,
        expires_at: true,
        user_id: true,
        cart_items: {
          orderBy: { created_at: 'desc' },
          include: LINE_INCLUDE,
        },
      },
    });

    if (!cart) {
      // The resolver just created or found it, so this is unreachable in practice —
      // unless the basket was swept between the two queries, which is survivable.
      throw Problems.notFound('The basket no longer exists.');
    }

    const items: CartItemView[] = cart.cart_items.map((line) => {
      const variant = line.product_variants;
      const product = variant.products;
      const unitPriceCents = Number(variant.price_cents);
      const image = product.product_images[0];

      return {
        id: line.id,
        variantId: variant.id,
        productId: product.id,
        slug: product.slug,
        productName: product.name,
        variantName: variant.name,
        sku: variant.sku,
        ...(image ? { imageUrl: image.url } : {}),
        unitPriceCents,
        quantity: line.quantity,
        lineTotalCents: unitPriceCents * line.quantity,
        currency: product.currency,
        availableStock: variant.stock_on_hand - variant.stock_reserved,
      };
    });

    return {
      id: cart.id,
      items,
      itemCount: items.reduce((total, item) => total + item.quantity, 0),
      subtotalCents: items.reduce((total, item) => total + item.lineTotalCents, 0),
      currency: cart.currency,
      updatedAt: cart.updated_at,
      // Omitted for a signed-in user's basket, which does not expire.
      ...(cart.expires_at ? { expiresAt: cart.expires_at } : {}),
    };
  }

  /**
   * Adds a variant, or increases the quantity of the line already holding it.
   *
   * **Nothing is reserved here.** The stock check below can return 409, but another
   * shopper can still take the item a moment later — reservation happens only at
   * checkout. Reserving on add would lock stock against people who never buy, and
   * for a small shop that is indistinguishable from being out of stock.
   */
  async addItem(
    cartId: string,
    variantId: string,
    quantity: number,
  ): Promise<CartView> {
    const variant = await this.loadSellableVariant(variantId);

    const existing = await this.prisma.cart_items.findUnique({
      where: { cart_id_variant_id: { cart_id: cartId, variant_id: variantId } },
      select: { id: true, quantity: true },
    });

    // Adding to a line that already exists sums, then caps. Capping silently rather
    // than rejecting is what the contract specifies: the shopper asked for more of
    // something they already have, and 99 of it is the most the line can hold.
    const desired = Math.min(
      (existing?.quantity ?? 0) + quantity,
      MAX_LINE_QUANTITY,
    );

    this.assertStock(variant, desired);

    await this.prisma.cart_items.upsert({
      where: { cart_id_variant_id: { cart_id: cartId, variant_id: variantId } },
      create: { cart_id: cartId, variant_id: variantId, quantity: desired },
      update: { quantity: desired, updated_at: new Date() },
    });

    await this.touch(cartId);
    return this.view(cartId);
  }

  /** Sets an absolute quantity on a line. Removal is `DELETE`, not a quantity of zero. */
  async updateItem(
    cartId: string,
    itemId: string,
    quantity: number,
  ): Promise<CartView> {
    const line = await this.prisma.cart_items.findFirst({
      // Scoped to this basket, so an id belonging to somebody else's cart is a 404
      // rather than an edit of their line.
      where: { id: itemId, cart_id: cartId },
      select: { id: true, variant_id: true },
    });

    if (!line) {
      throw Problems.notFound('No such line in this basket.');
    }

    const variant = await this.loadSellableVariant(line.variant_id);
    this.assertStock(variant, quantity);

    await this.prisma.cart_items.update({
      where: { id: line.id },
      data: { quantity, updated_at: new Date() },
    });

    await this.touch(cartId);
    return this.view(cartId);
  }

  async removeItem(cartId: string, itemId: string): Promise<CartView> {
    const deleted = await this.prisma.cart_items.deleteMany({
      where: { id: itemId, cart_id: cartId },
    });

    // Unlike logout, this is not made idempotent: there is no retry-safety argument
    // for deleting a line twice, and a silent success would hide a client bug.
    if (deleted.count === 0) {
      throw Problems.notFound('No such line in this basket.');
    }

    await this.touch(cartId);
    return this.view(cartId);
  }

  /**
   * Folds a guest basket into the signed-in user's basket.
   *
   * Idempotent on purpose, and the contract says so: a token that is unknown,
   * expired, or already merged returns the user's current basket rather than an
   * error. A client whose connection dropped mid-merge will retry, and punishing it
   * would lose the basket the whole mechanism exists to preserve.
   *
   * One transaction, because a half-merge is the worst outcome available: items
   * counted twice, or a guest basket deleted after only some of it moved.
   */
  async merge(userId: string, cartToken: string): Promise<CartView> {
    const userCartId = await this.prisma.$transaction(async (tx) => {
      const userCart = await tx.carts.findFirst({
        where: { user_id: userId },
        select: { id: true },
      });

      // The resolver guarantees this exists for an authenticated caller, since the
      // guard ran first and `GET /carts/me` creates one. Belt and braces.
      const targetId =
        userCart?.id ??
        (await tx.carts.create({ data: { user_id: userId }, select: { id: true } }))
          .id;

      const guestCart = await tx.carts.findFirst({
        where: { token_hash: hashCartToken(cartToken), user_id: null },
        select: {
          id: true,
          cart_items: { select: { variant_id: true, quantity: true } },
        },
      });

      if (!guestCart || guestCart.id === targetId) {
        return targetId;
      }

      const targetLines = await tx.cart_items.findMany({
        where: { cart_id: targetId },
        select: { id: true, variant_id: true, quantity: true },
      });
      const byVariant = new Map(targetLines.map((line) => [line.variant_id, line]));

      for (const guestLine of guestCart.cart_items) {
        const existing = byVariant.get(guestLine.variant_id);

        if (existing) {
          await tx.cart_items.update({
            where: { id: existing.id },
            data: {
              // Summed, then capped. Not stock-checked: the merge must not fail
              // because something sold out while the shopper was signing in. The
              // basket is allowed to hold more than is available — checkout is where
              // that becomes a 409, with every short line named at once.
              quantity: Math.min(
                existing.quantity + guestLine.quantity,
                MAX_LINE_QUANTITY,
              ),
              updated_at: new Date(),
            },
          });
        } else {
          await tx.cart_items.create({
            data: {
              cart_id: targetId,
              variant_id: guestLine.variant_id,
              quantity: Math.min(guestLine.quantity, MAX_LINE_QUANTITY),
            },
          });
        }
      }

      // Cascades to its lines. Its items were read above, before this point.
      await tx.carts.delete({ where: { id: guestCart.id } });
      await tx.carts.update({
        where: { id: targetId },
        data: { updated_at: new Date() },
      });

      return targetId;
    });

    return this.view(userCartId);
  }

  /**
   * Loads a variant that may actually be sold.
   *
   * An inactive variant, or one belonging to a draft or archived product, is a 404 —
   * the same answer as a variant that does not exist. Anything else would let the
   * unpublished catalogue be enumerated through the cart endpoint.
   */
  private async loadSellableVariant(variantId: string): Promise<{
    id: string;
    available: number;
  }> {
    const variant = await this.prisma.product_variants.findFirst({
      where: {
        id: variantId,
        is_active: true,
        products: { status: 'active' },
      },
      select: { id: true, stock_on_hand: true, stock_reserved: true },
    });

    if (!variant) {
      throw Problems.notFound('No such variant, or it is not available.');
    }

    return {
      id: variant.id,
      available: variant.stock_on_hand - variant.stock_reserved,
    };
  }

  private assertStock(
    variant: { id: string; available: number },
    requested: number,
  ): void {
    if (requested <= variant.available) {
      return;
    }

    throw new ProblemException('insufficient-stock', {
      detail:
        variant.available === 0
          ? 'That variant is out of stock.'
          : `Only ${variant.available} left.`,
      errors: [
        {
          field: 'quantity',
          message:
            variant.available === 0 ? 'Out of stock' : `Only ${variant.available} left`,
          variantId: variant.id,
          requested,
          available: variant.available,
        },
      ],
    });
  }

  /**
   * Bumps `updated_at`.
   *
   * Explicit because the schema has no triggers — by design, so that neither backend
   * can rely on the database doing something the other's ORM would do differently.
   */
  private async touch(cartId: string): Promise<void> {
    await this.prisma.carts.update({
      where: { id: cartId },
      data: { updated_at: new Date() },
    });
  }
}
