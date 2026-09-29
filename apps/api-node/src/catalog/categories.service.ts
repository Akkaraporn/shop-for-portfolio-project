import { Injectable } from '@nestjs/common';

import type { Page } from '../common/pagination/cursor';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';
import type { CategoryNode } from './catalog.types';

/**
 * Versioned in the key rather than tracked elsewhere, so changing the cached shape
 * is a one-character edit that abandons every stale entry instead of needing a
 * deployment-time flush.
 */
export const CATEGORY_TREE_CACHE_KEY = 'catalog:categories:v1';
export const CATEGORY_TREE_TTL_SECONDS = 300;

interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  position: number;
  product_count: bigint;
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * The whole active category tree.
   *
   * Cached in Redis for five minutes. A cache miss, a cache outage and a cold start
   * are all the same code path — `RedisService` returns null rather than throwing —
   * so losing Redis makes this slower and never wrong, which is the project rule.
   *
   * Returned inside the standard `Page` envelope with `hasMore` always false. The
   * tree is small and always returned whole, so pagination would be meaningless;
   * the envelope is kept because every list in this API has the same shape and a
   * client should never need to know which lists can paginate.
   */
  async tree(): Promise<Page<CategoryNode>> {
    const cached = await this.redis.get(CATEGORY_TREE_CACHE_KEY);

    if (cached) {
      try {
        return { items: JSON.parse(cached) as CategoryNode[], hasMore: false };
      } catch {
        // A corrupt entry is treated as a miss. Throwing would turn a cache
        // problem into an outage for an endpoint that can answer from Postgres.
        await this.redis.del(CATEGORY_TREE_CACHE_KEY);
      }
    }

    const roots = await this.loadTree();

    await this.redis.set(
      CATEGORY_TREE_CACHE_KEY,
      JSON.stringify(roots),
      CATEGORY_TREE_TTL_SECONDS,
    );

    return { items: roots, hasMore: false };
  }

  /**
   * Drops the cached tree. Called when an admin edits a category (task 2.7).
   *
   * The tree changes rarely, so invalidation on write is cheap and keeps the TTL as
   * a backstop rather than the primary mechanism.
   */
  async invalidate(): Promise<void> {
    await this.redis.del(CATEGORY_TREE_CACHE_KEY);
  }

  /**
   * Reads every active category as flat rows and assembles the tree in memory.
   *
   * One query, not one per level: a recursive CTE would also work, but the whole
   * table is a handful of rows and fetching it flat then linking it is simpler to
   * follow and trivially portable to the Java side.
   *
   * `product_count` counts only active products filed *directly* in each category —
   * not its subtree. That is a deliberate choice and worth stating, because the
   * `categorySlug` filter on `GET /products` *does* include descendants, so the two
   * numbers differ for a parent category. Summing descendants here would double
   * count nothing but would imply the filter returns that many, which it does not
   * when a child is inactive.
   */
  private async loadTree(): Promise<CategoryNode[]> {
    const rows = await this.prisma.$queryRaw<CategoryRow[]>`
      SELECT
        c.id,
        c.slug,
        c.name,
        c.parent_id,
        c.position,
        (
          SELECT count(*) FROM products p
          WHERE p.category_id = c.id AND p.status = 'active'
        ) AS product_count
      FROM categories c
      WHERE c.is_active
      ORDER BY c.position, c.name
    `;

    const nodes = new Map<string, CategoryNode>();
    for (const row of rows) {
      nodes.set(row.id, {
        id: row.id,
        slug: row.slug,
        name: row.name,
        productCount: Number(row.product_count),
      });
    }

    const roots: CategoryNode[] = [];

    for (const row of rows) {
      const node = nodes.get(row.id)!;
      const parent = row.parent_id ? nodes.get(row.parent_id) : undefined;

      if (!parent) {
        // Either a genuine root, or a child whose parent is inactive. Promoting an
        // orphan to a root keeps its products reachable; dropping it would hide
        // them from the navigation with nothing to explain why.
        roots.push(node);
        continue;
      }

      // `children` stays absent on a leaf rather than becoming an empty array,
      // because the contract omits absent optional fields (rule 7).
      parent.children ??= [];
      parent.children.push(node);
    }

    return roots;
  }
}
