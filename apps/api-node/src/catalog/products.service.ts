import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  buildPage,
  decodeCursor,
  encodeCursor,
  type Page,
} from '../common/pagination/cursor';
import { Problems } from '../common/problem/problem.exception';
import { PrismaService } from '../infra/prisma/prisma.service';
import {
  DEFAULT_LIMIT,
  type ListProductsQuery,
  type ProductSort,
} from './dto/list-products.query';
import type { ProductDetail, ProductSummary } from './catalog.types';

/** One row of the list query, before mapping to the contract's shape. */
interface ProductListRow {
  id: string;
  slug: string;
  name: string;
  min_price_cents: bigint;
  currency: string;
  created_at: Date;
  category_slug: string;
  image_url: string | null;
  in_stock: boolean;
}

/**
 * How each sort maps onto a column, a direction, and a cursor value.
 *
 * Every entry carries `id` as the tiebreaker. Without it, two products sharing a
 * price or a name would either both appear on consecutive pages or neither would —
 * and the missing one is silent. The indexes in V1__init.sql end in `id` to match.
 */
const SORTS: Record<
  ProductSort,
  {
    /** The column, as raw SQL. Never interpolated from user input. */
    column: Prisma.Sql;
    direction: 'ASC' | 'DESC';
    /** Renders the cursor's sortValue. Must match docs/cursor-format.md. */
    toCursorValue: (row: ProductListRow) => string;
    /** Casts the cursor's sortValue back to the column's type. */
    toSqlValue: (value: string) => Prisma.Sql;
  }
> = {
  newest: {
    column: Prisma.sql`p.created_at`,
    direction: 'DESC',
    toCursorValue: (row) => row.created_at.toISOString(),
    toSqlValue: (value) => Prisma.sql`${value}::timestamptz`,
  },
  price_asc: {
    column: Prisma.sql`p.min_price_cents`,
    direction: 'ASC',
    toCursorValue: (row) => row.min_price_cents.toString(),
    toSqlValue: (value) => Prisma.sql`${value}::bigint`,
  },
  price_desc: {
    column: Prisma.sql`p.min_price_cents`,
    direction: 'DESC',
    toCursorValue: (row) => row.min_price_cents.toString(),
    toSqlValue: (value) => Prisma.sql`${value}::bigint`,
  },
  name_asc: {
    column: Prisma.sql`p.name`,
    direction: 'ASC',
    toCursorValue: (row) => row.name,
    toSqlValue: (value) => Prisma.sql`${value}::varchar`,
  },
};

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The catalogue listing.
   *
   * Written as one raw query rather than through the Prisma query builder, for
   * three reasons that each rule out the builder on their own:
   *
   * 1. `categorySlug` must include the whole subtree, which needs a recursive CTE.
   *    Prisma cannot express one.
   * 2. The cursor predicate is a row-value comparison, `(sort_col, id) < (:v, :i)`.
   *    Prisma would produce `sort_col < :v AND id < :i`, which is a different and
   *    wrong condition — it drops every row whose sort value ties.
   * 3. Search is a trigram `ILIKE` over a concatenation, matching the expression
   *    index in V1__init.sql. Prisma's `contains` cannot target that index.
   *
   * The Java port needs a native query here for exactly the same reasons.
   *
   * Every user-supplied value is a bound parameter. The only SQL assembled from
   * code is the sort column and direction, and those come from the `SORTS` table
   * above, keyed by a value the DTO has already restricted to four literals.
   */
  async list(query: ListProductsQuery): Promise<Page<ProductSummary>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const sort = SORTS[query.sort ?? 'newest'];

    const conditions: Prisma.Sql[] = [
      // Only active products are ever visible here, whatever else was asked for.
      Prisma.sql`p.status = 'active'`,
    ];

    if (query.categorySlug) {
      // Selecting a parent category must return products filed under its
      // descendants too. Both backends must agree on this: returning only the
      // directly-filed products is a parity failure.
      conditions.push(Prisma.sql`p.category_id IN (
        WITH RECURSIVE tree AS (
          SELECT c.id FROM categories c
          WHERE c.slug = ${query.categorySlug} AND c.is_active
          UNION ALL
          SELECT child.id FROM categories child
          JOIN tree t ON child.parent_id = t.id
          WHERE child.is_active
        )
        SELECT id FROM tree
      )`);
    }

    if (query.q) {
      // Trigram substring matching, not tsvector: Thai has no spaces between
      // words, so a tokenised index cannot match mid-word. See the comment on
      // products_search_idx in V1__init.sql.
      const pattern = `%${escapeLikePattern(query.q)}%`;
      conditions.push(
        Prisma.sql`(p.name || ' ' || p.description) ILIKE ${pattern}`,
      );
    }

    if (query.minPriceCents !== undefined) {
      conditions.push(Prisma.sql`p.min_price_cents >= ${query.minPriceCents}`);
    }

    if (query.maxPriceCents !== undefined) {
      conditions.push(Prisma.sql`p.min_price_cents <= ${query.maxPriceCents}`);
    }

    if (query.inStockOnly) {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM product_variants v
        WHERE v.product_id = p.id AND v.is_active
          AND v.stock_on_hand - v.stock_reserved > 0
      )`);
    }

    if (query.cursor) {
      const { sortValue, id } = decodeCursor(query.cursor);
      const comparison = sort.direction === 'ASC' ? Prisma.sql`>` : Prisma.sql`<`;
      // A row-value comparison, not a conjunction. `(a, b) < (x, y)` is standard
      // SQL and means "a < x, or a = x and b < y" — which is what keyset
      // pagination requires.
      conditions.push(
        Prisma.sql`(${sort.column}, p.id) ${comparison} (${sort.toSqlValue(sortValue)}, ${id}::uuid)`,
      );
    }

    const direction =
      sort.direction === 'ASC' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

    const rows = await this.prisma.$queryRaw<ProductListRow[]>`
      SELECT
        p.id,
        p.slug,
        p.name,
        p.min_price_cents,
        p.currency,
        p.created_at,
        cat.slug AS category_slug,
        img.url  AS image_url,
        EXISTS (
          SELECT 1 FROM product_variants v
          WHERE v.product_id = p.id AND v.is_active
            AND v.stock_on_hand - v.stock_reserved > 0
        ) AS in_stock
      FROM products p
      JOIN categories cat ON cat.id = p.category_id
      LEFT JOIN LATERAL (
        SELECT pi.url FROM product_images pi
        WHERE pi.product_id = p.id
        ORDER BY pi.position
        LIMIT 1
      ) img ON true
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY ${sort.column} ${direction}, p.id ${direction}
      LIMIT ${limit + 1}
    `;

    // The page is computed over the raw rows, because the cursor is built from
    // columns the summary does not expose (created_at for the newest sort).
    const page = buildPage(rows, limit, (row) => ({
      sortValue: sort.toCursorValue(row),
      id: row.id,
    }));

    return {
      items: page.items.map(toSummary),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async findBySlug(slug: string): Promise<ProductDetail> {
    const product = await this.prisma.products.findFirst({
      where: { slug, status: 'active' },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        status: true,
        min_price_cents: true,
        currency: true,
        created_at: true,
        categories: { select: { slug: true } },
        product_variants: {
          where: { is_active: true },
          orderBy: [{ price_cents: 'asc' }, { position: 'asc' }],
          select: {
            id: true,
            sku: true,
            name: true,
            price_cents: true,
            stock_on_hand: true,
            stock_reserved: true,
          },
        },
        product_images: {
          orderBy: { position: 'asc' },
          select: { id: true, url: true, alt: true, position: true },
        },
      },
    });

    // A draft or archived product is indistinguishable from one that never
    // existed. Saying "this exists but you cannot see it" would leak the
    // catalogue's unpublished contents.
    if (!product) {
      throw Problems.notFound(`No product with slug '${slug}'.`);
    }

    const variants = product.product_variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      priceCents: Number(variant.price_cents),
      currency: product.currency,
      // Computed at read time, and advisory only. It may already be stale by the
      // time this response is rendered; checkout re-verifies under a row lock.
      // Never make a sell/no-sell decision from this value.
      availableStock: variant.stock_on_hand - variant.stock_reserved,
    }));

    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      minPriceCents: Number(product.min_price_cents),
      currency: product.currency,
      inStock: variants.some((variant) => variant.availableStock > 0),
      ...(product.product_images[0]
        ? { imageUrl: product.product_images[0].url }
        : {}),
      categorySlug: product.categories.slug,
      description: product.description,
      status: product.status as ProductDetail['status'],
      variants,
      images: product.product_images.map((image) => ({
        id: image.id,
        url: image.url,
        ...(image.alt ? { alt: image.alt } : {}),
        position: image.position,
      })),
      createdAt: product.created_at,
    };
  }

  /** Exposed for the integration tests, which assert on cursor values directly. */
  static cursorFor(sort: ProductSort, row: ProductListRow): string {
    return encodeCursor({
      sortValue: SORTS[sort].toCursorValue(row),
      id: row.id,
    });
  }
}

function toSummary(row: ProductListRow): ProductSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    // BIGINT arrives as a bigint from a raw query. JSON.stringify cannot serialise
    // one, so it is narrowed here — safe because satang stays far inside
    // Number.MAX_SAFE_INTEGER (see ADR-002).
    minPriceCents: Number(row.min_price_cents),
    currency: row.currency,
    inStock: row.in_stock,
    ...(row.image_url ? { imageUrl: row.image_url } : {}),
    categorySlug: row.category_slug,
  };
}

/**
 * Escapes the wildcards `ILIKE` would otherwise interpret.
 *
 * Without this, searching for `50%` matches everything, and `_` matches any single
 * character. This is not an injection defence — the pattern is a bound parameter —
 * it is about the search meaning what the user typed.
 */
function escapeLikePattern(input: string): string {
  return input.replace(/([\\%_])/g, '\\$1');
}
