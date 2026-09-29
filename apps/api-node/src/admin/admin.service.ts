import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { CategoriesService } from '../catalog/categories.service';
import {
  PRODUCT_DETAIL_SELECT,
  toProductDetail,
  type ProductDetailRow,
} from '../catalog/products.service';
import type {
  ProductDetail,
  ProductVariantView,
} from '../catalog/catalog.types';
import {
  buildPage,
  decodeCursor,
  type Page,
} from '../common/pagination/cursor';
import {
  ProblemException,
  Problems,
} from '../common/problem/problem.exception';
import { PrismaService } from '../infra/prisma/prisma.service';
import type { OrderStatus, OrderView } from '../orders/order.types';
import { OrdersService } from '../orders/orders.service';
import type {
  CreateProductDto,
  ListAdminOrdersQuery,
  ListAdminProductsQuery,
  StockAdjustmentDto,
  UpdateProductDto,
} from './dto/admin.dto';
import { assertTransition } from './order-transitions';
import { adjust } from './stock-math';

/** Matches `AdminVariant`: the customer view plus the raw stock columns. */
export interface AdminVariantView extends ProductVariantView {
  stockOnHand: number;
  stockReserved: number;
}

/** Matches `AdminProduct`. */
export interface AdminProductView extends Omit<ProductDetail, 'variants'> {
  categoryId: string;
  variants: AdminVariantView[];
}

const DEFAULT_LIMIT = 20;

function toAdminProduct(row: ProductDetailRow): AdminProductView {
  const detail = toProductDetail(row);
  const raw = new Map(
    row.product_variants.map((variant) => [variant.id, variant]),
  );
  return {
    ...detail,
    categoryId: row.category_id,
    variants: detail.variants.map((variant) => ({
      ...variant,
      stockOnHand: raw.get(variant.id)!.stock_on_hand,
      stockReserved: raw.get(variant.id)!.stock_reserved,
    })),
  };
}

/**
 * The back office. Every method here is reached only through `@Roles('admin')`.
 *
 * Nothing in here writes a stock level or an order status taken from what the client
 * read earlier: stock moves by a signed delta under a row lock, and a status moves
 * only along the forward table in order-transitions.ts.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoriesService,
    private readonly orders: OrdersService,
  ) {}

  // --- products ------------------------------------------------------------------

  /** Every product in any status, newest first, on the shared cursor codec. */
  async listProducts(
    query: ListAdminProductsQuery,
  ): Promise<Page<AdminProductView>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const conditions: Prisma.Sql[] = [];

    if (query.status) {
      conditions.push(Prisma.sql`p.status = ${query.status}`);
    }
    if (query.cursor) {
      const { sortValue, id } = decodeCursor(query.cursor);
      conditions.push(
        Prisma.sql`(p.created_at, p.id) < (${sortValue}::timestamptz, ${id}::uuid)`,
      );
    }

    const where =
      conditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      { id: string; created_at: Date }[]
    >`
      SELECT p.id, p.created_at
      FROM products p
      ${where}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${limit + 1}
    `;

    const page = buildPage(rows, limit, (row) => ({
      sortValue: row.created_at.toISOString(),
      id: row.id,
    }));

    const products = await this.prisma.products.findMany({
      where: { id: { in: page.items.map((row) => row.id) } },
      select: PRODUCT_DETAIL_SELECT,
    });
    const byId = new Map(products.map((product) => [product.id, product]));

    return {
      items: page.items
        .map((row) => byId.get(row.id))
        .filter((row): row is ProductDetailRow => row !== undefined)
        .map(toAdminProduct),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /**
   * A product and all its variants in one transaction — a product with nothing to
   * sell is not a state worth allowing, even for a moment.
   *
   * A slug or SKU that already exists fails on its unique index, which the problem
   * filter turns into a 409. Two SKUs repeated *within* the request are caught here
   * first, as a 422 naming the line: that is a mistake in the form, not a conflict
   * with anything stored.
   */
  async createProduct(dto: CreateProductDto): Promise<AdminProductView> {
    const seen = new Map<string, number>();
    const duplicates: { field: string; message: string }[] = [];
    dto.variants.forEach((variant, index) => {
      const first = seen.get(variant.sku);
      if (first !== undefined) {
        duplicates.push({
          field: `variants[${index}].sku`,
          message: `repeats the SKU of variants[${first}]`,
        });
      } else {
        seen.set(variant.sku, index);
      }
    });
    if (duplicates.length > 0) {
      throw Problems.validationFailed(
        duplicates,
        'Each variant needs its own SKU.',
      );
    }

    await this.assertCategoryExists(dto.categoryId);

    // Maintained on write, never computed on read: sort=price_asc reads this column.
    const minPrice = Math.min(
      ...dto.variants.map((variant) => variant.priceCents),
    );

    const id = await this.prisma.$transaction(async (tx) => {
      const product = await tx.products.create({
        data: {
          slug: dto.slug,
          name: dto.name,
          description: dto.description,
          category_id: dto.categoryId,
          ...(dto.status ? { status: dto.status } : {}),
          min_price_cents: BigInt(minPrice),
        },
        select: { id: true },
      });

      await tx.product_variants.createMany({
        data: dto.variants.map((variant, position) => ({
          product_id: product.id,
          sku: variant.sku,
          name: variant.name,
          price_cents: BigInt(variant.priceCents),
          stock_on_hand: variant.stockOnHand,
          position,
        })),
      });

      if (dto.imageUrls && dto.imageUrls.length > 0) {
        await tx.product_images.createMany({
          data: dto.imageUrls.map((url, position) => ({
            product_id: product.id,
            url,
            position,
          })),
        });
      }

      return product.id;
    });

    // Category product counts are cached, and a new product changes one.
    await this.categories.invalidate();
    return this.loadProduct(id);
  }

  /** Partial update. Archiving hides a product; nothing is ever deleted. */
  async updateProduct(
    id: string,
    dto: UpdateProductDto,
  ): Promise<AdminProductView> {
    const existing = await this.prisma.products.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw Problems.notFound(`No product with id '${id}'.`);
    }
    if (dto.categoryId) {
      await this.assertCategoryExists(dto.categoryId);
    }

    await this.prisma.products.update({
      where: { id },
      data: {
        ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.categoryId !== undefined
          ? { category_id: dto.categoryId }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        updated_at: new Date(),
      },
    });

    await this.categories.invalidate();
    return this.loadProduct(id);
  }

  // --- inventory -----------------------------------------------------------------

  /**
   * Moves stock by a signed delta, under the variant's row lock.
   *
   * The lock and the check sit in one transaction so two concurrent adjustments
   * serialise: each sees the other's result, and both land. The refusal is a 409,
   * not a 422 — the request is well-formed; it conflicts with units already
   * promised to shoppers' orders.
   */
  async adjustStock(
    variantId: string,
    dto: StockAdjustmentDto,
    adminId: string,
  ): Promise<AdminVariantView> {
    await this.prisma.$transaction(async (tx) => {
      const [variant] = await tx.$queryRaw<
        { stock_on_hand: number; stock_reserved: number }[]
      >`
        SELECT stock_on_hand, stock_reserved
        FROM product_variants
        WHERE id = ${variantId}::uuid
        FOR UPDATE
      `;
      if (!variant) {
        throw Problems.notFound(`No variant with id '${variantId}'.`);
      }

      const outcome = adjust(
        { onHand: variant.stock_on_hand, reserved: variant.stock_reserved },
        dto.delta,
      );
      if (!outcome.ok) {
        throw new ProblemException('conflict', {
          detail: `Adjusting by ${dto.delta} ${outcome.reason}. Stock on hand may not fall below stock already reserved for orders.`,
          errors: [
            {
              field: 'delta',
              message: `must be at least ${variant.stock_reserved - variant.stock_on_hand}`,
            },
          ],
        });
      }

      await tx.product_variants.update({
        where: { id: variantId },
        data: {
          stock_on_hand: { increment: dto.delta },
          updated_at: new Date(),
        },
      });

      // The audit trail for the `reason` the contract asks for. The outbox is already
      // the record of what changed and why; a separate table would be a second place
      // to look.
      await tx.outbox_events.create({
        data: {
          aggregate_type: 'product_variant',
          aggregate_id: variantId,
          event_type: 'stock.adjusted',
          payload: {
            variantId,
            delta: dto.delta,
            reason: dto.reason,
            adminId,
            stockOnHand: outcome.levels.onHand,
          },
        },
      });
    });

    const variant = await this.prisma.product_variants.findUniqueOrThrow({
      where: { id: variantId },
      select: {
        id: true,
        sku: true,
        name: true,
        price_cents: true,
        stock_on_hand: true,
        stock_reserved: true,
        products: { select: { currency: true } },
      },
    });

    return {
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      priceCents: Number(variant.price_cents),
      currency: variant.products.currency,
      availableStock: variant.stock_on_hand - variant.stock_reserved,
      stockOnHand: variant.stock_on_hand,
      stockReserved: variant.stock_reserved,
    };
  }

  // --- orders --------------------------------------------------------------------

  listOrders(
    query: ListAdminOrdersQuery,
    adminId: string,
  ): Promise<Page<OrderView>> {
    return this.orders.list(adminId, {
      allUsers: true,
      status: query.status,
      filterUserId: query.userId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  /**
   * Advances an order along the forward-only table.
   *
   * The row is locked before the check, so two admins pressing "fulfilled" at once
   * cannot both pass it: the second waits, then sees `fulfilled` and gets the 409
   * that tells it where the order can go now.
   */
  async updateOrderStatus(
    orderNumber: string,
    to: OrderStatus,
    adminId: string,
  ): Promise<OrderView> {
    await this.prisma.$transaction(async (tx) => {
      const [order] = await tx.$queryRaw<{ id: string; status: OrderStatus }[]>`
        SELECT id, status FROM orders WHERE order_number = ${orderNumber} FOR UPDATE
      `;
      if (!order) {
        throw Problems.notFound(`No order numbered ${orderNumber}.`);
      }

      assertTransition(order.status, to);

      await tx.orders.update({
        where: { id: order.id },
        data: { status: to, updated_at: new Date() },
      });

      await tx.outbox_events.create({
        data: {
          aggregate_type: 'order',
          aggregate_id: order.id,
          event_type: `order.${to}`,
          payload: { orderId: order.id, from: order.status, to, adminId },
        },
      });
    });

    return this.orders.findForUser(orderNumber, adminId, { isAdmin: true });
  }

  // --- helpers -------------------------------------------------------------------

  private async loadProduct(id: string): Promise<AdminProductView> {
    const row = await this.prisma.products.findUniqueOrThrow({
      where: { id },
      select: PRODUCT_DETAIL_SELECT,
    });
    return toAdminProduct(row);
  }

  /**
   * A missing category is a 422 on the field, not the 409 its foreign key would
   * otherwise produce: the form named something that does not exist.
   */
  private async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await this.prisma.categories.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) {
      throw Problems.validationFailed([
        { field: 'categoryId', message: 'no such category' },
      ]);
    }
  }
}
