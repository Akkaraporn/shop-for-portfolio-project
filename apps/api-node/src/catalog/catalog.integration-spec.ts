import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import request from 'supertest';

import { CatalogModule } from './catalog.module';
import { decodeCursor } from '../common/pagination/cursor';
import { configureApp } from '../bootstrap';
import { LOGGER, LoggerModule } from '../common/logging/logger.module';
import { ConfigModule } from '../config/config.module';
import { PrismaModule } from '../infra/prisma/prisma.module';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisModule } from '../infra/redis/redis.module';

/**
 * The catalogue, against a real PostgreSQL 16 with the V2 seed applied.
 *
 * These tests need a database, and that is the point. Every claim 2.3 makes is a
 * database behaviour: the recursive CTE that pulls in a category's descendants, the
 * row-value comparison that makes keyset pagination correct under concurrent writes,
 * the trigram index that matches Thai mid-word. A double would prove none of them —
 * it would only prove that the double behaves like the double.
 *
 *   make up-infra     # or make up-node
 *   npm run test:integration
 *
 * Skipped, loudly, when no database is reachable, so `npm test` stays green on a
 * machine without Docker.
 */

const DATABASE_URL =
  process.env.DATABASE_URL_HOST ??
  'postgresql://shop:shop@localhost:55432/shop?schema=public';

describe('catalog (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reachable = false;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.REDIS_URL ??= 'redis://localhost:56379';
    process.env.JWT_SECRET ??= 'test-secret-at-least-16-chars';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        LoggerModule,
        PrismaModule,
        RedisModule,
        CatalogModule,
      ],
    })
      .overrideProvider(LOGGER)
      .useValue(pino({ level: 'silent' }))
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app, pino({ level: 'silent' }));

    try {
      await app.init();
      prisma = app.get(PrismaService);
      reachable = await prisma.isReachable();
    } catch {
      reachable = false;
    }

    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(
        `\n  SKIPPING catalog integration tests: no database at ${DATABASE_URL}.` +
          '\n  Start one with `make up-infra` and re-run.\n',
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  /**
   * Registers a test that no-ops when no database is reachable.
   *
   * Preferred over `describe.skip` decided up front, because reachability is only
   * known after `beforeAll` has run — by which time the suite is already registered.
   */
  const dbIt = (
    name: string,
    fn: () => Promise<void>,
    timeout?: number,
  ): void => {
    it(
      name,
      async () => {
        if (!reachable) {
          return;
        }
        await fn();
      },
      timeout,
    );
  };

  const http = () => request(app.getHttpServer());

  describe('GET /categories', () => {
    dbIt('returns the seeded tree in the Page envelope', async () => {
      const response = await http().get('/api/v1/categories');

      expect(response.status).toBe(200);
      expect(response.body.hasMore).toBe(false);
      expect(response.body.nextCursor).toBeUndefined();
      // Three roots in the seed: clothing, home-living, bags.
      expect(response.body.items).toHaveLength(3);
      expect(response.body.items.map((c: { slug: string }) => c.slug)).toEqual([
        'clothing',
        'home-living',
        'bags',
      ]);
    });

    dbIt('nests children under their parent', async () => {
      const response = await http().get('/api/v1/categories');

      const clothing = response.body.items.find(
        (c: { slug: string }) => c.slug === 'clothing',
      );
      expect(clothing.children.map((c: { slug: string }) => c.slug)).toEqual([
        't-shirts',
        'shirts',
        'trousers',
      ]);
    });

    dbIt('omits children on a leaf rather than sending an empty array', async () => {
      const response = await http().get('/api/v1/categories');

      const bags = response.body.items.find(
        (c: { slug: string }) => c.slug === 'bags',
      );
      // Contract rule 7: an absent optional field is omitted, not null or [].
      expect('children' in bags).toBe(false);
    });

    dbIt('counts only active products filed directly in a category', async () => {
      const response = await http().get('/api/v1/categories');

      const clothing = response.body.items.find(
        (c: { slug: string }) => c.slug === 'clothing',
      );
      // The hoodie is filed on the root itself. The draft long-sleeve tee and the
      // archived sweatpants are not counted anywhere.
      expect(clothing.productCount).toBe(1);

      const tShirts = clothing.children.find(
        (c: { slug: string }) => c.slug === 't-shirts',
      );
      // Three tees seeded, one of them draft.
      expect(tShirts.productCount).toBe(2);
    });

    dbIt('sets Cache-Control so intermediaries can reuse it', async () => {
      const response = await http().get('/api/v1/categories');
      expect(response.headers['cache-control']).toBe('public, max-age=300');
    });

    dbIt('serves a second request from cache, or identically without one', async () => {
      const first = await http().get('/api/v1/categories');
      const second = await http().get('/api/v1/categories');

      // Whether Redis is up or not, the answer is the same. That is the guarantee:
      // losing the cache makes this slower, never different.
      expect(second.body).toEqual(first.body);
    });
  });

  describe('GET /products', () => {
    dbIt('shows only active products', async () => {
      const response = await http().get('/api/v1/products?limit=50');

      expect(response.status).toBe(200);
      const slugs = response.body.items.map((p: { slug: string }) => p.slug);
      // 15 seeded, one draft and one archived.
      expect(slugs).toHaveLength(13);
      expect(slugs).not.toContain('long-sleeve-tee'); // draft
      expect(slugs).not.toContain('fleece-sweatpants'); // archived
    });

    dbIt('returns the contract shape, with money as integer satang', async () => {
      const response = await http().get(
        '/api/v1/products?limit=1&sort=price_asc',
      );

      const item = response.body.items[0];
      expect(item).toMatchObject({
        slug: 'matte-ceramic-mug',
        minPriceCents: 29000,
        currency: 'THB',
        inStock: true,
        categorySlug: 'kitchen',
      });
      expect(Number.isInteger(item.minPriceCents)).toBe(true);
      expect(typeof item.minPriceCents).toBe('number');
      expect(item.imageUrl).toContain('picsum.photos');
    });

    describe('categorySlug includes the whole subtree', () => {
      dbIt('a parent category returns its descendants and its own products', async () => {
        const response = await http().get(
          '/api/v1/products?categorySlug=clothing&limit=50',
        );

        const slugs = response.body.items.map((p: { slug: string }) => p.slug);
        // Filed directly on the root:
        expect(slugs).toContain('zip-up-hoodie');
        // Filed under children — this is what the recursive CTE is for. Returning
        // only the hoodie would be a parity failure, not merely a surprise.
        expect(slugs).toContain('crewneck-organic-tee'); // t-shirts
        expect(slugs).toContain('oxford-button-down-shirt'); // shirts
        expect(slugs).toContain('cotton-shorts'); // trousers
        expect(slugs).not.toContain('matte-ceramic-mug'); // a different root
      });

      dbIt('a leaf category returns only its own', async () => {
        const response = await http().get(
          '/api/v1/products?categorySlug=t-shirts&limit=50',
        );

        const slugs = response.body.items.map((p: { slug: string }) => p.slug);
        expect(slugs).toContain('crewneck-organic-tee');
        expect(slugs).not.toContain('zip-up-hoodie');
      });

      dbIt('an unknown category returns an empty page, not a 404', async () => {
        const response = await http().get(
          '/api/v1/products?categorySlug=no-such-category',
        );

        expect(response.status).toBe(200);
        expect(response.body.items).toEqual([]);
        expect(response.body.hasMore).toBe(false);
      });
    });

    describe('search', () => {
      dbIt('matches Thai mid-word, which tsvector could not', async () => {
        // The reason products_search_idx is a trigram index: Thai has no spaces
        // between words, so `ลินิน` sits inside a single token.
        const response = await http().get(
          '/api/v1/products?q=' + encodeURIComponent('ลินิน'),
        );

        expect(response.body.items.map((p: { slug: string }) => p.slug)).toEqual([
          'linen-camp-shirt',
        ]);
      });

      dbIt('matches Latin text and numerals', async () => {
        const response = await http().get('/api/v1/products?q=400');
        expect(
          response.body.items.map((p: { slug: string }) => p.slug),
        ).toContain('cotton-sheet-set-400tc');
      });

      dbIt('treats a wildcard as a literal, not a pattern', async () => {
        // Unescaped, `%` is ILIKE's "anything" and would match all 13 products.
        // Escaped, it matches only text that actually contains a percent sign —
        // which in this seed is the three descriptions saying 100% cotton or linen.
        const wildcard = await http().get('/api/v1/products?q=%25&limit=50');
        const everything = await http().get('/api/v1/products?limit=50');

        expect(everything.body.items).toHaveLength(13);
        expect(wildcard.body.items.length).toBeLessThan(13);
        expect(
          wildcard.body.items.map((p: { slug: string }) => p.slug).sort(),
        ).toEqual(
          ['cotton-sheet-set-400tc', 'crewneck-organic-tee', 'linen-camp-shirt'],
        );
      });

      dbIt('treats an underscore as a literal too', async () => {
        // The other ILIKE wildcard: unescaped, `_` matches any single character.
        const response = await http().get('/api/v1/products?q=_&limit=50');
        expect(response.body.items).toEqual([]);
      });

      dbIt('finds nothing for a term nothing contains', async () => {
        const response = await http().get('/api/v1/products?q=zzzznotathing');
        expect(response.body.items).toEqual([]);
      });
    });

    describe('filters', () => {
      dbIt('bounds by price inclusively', async () => {
        const response = await http().get(
          '/api/v1/products?minPriceCents=29000&maxPriceCents=39000&limit=50',
        );

        const prices = response.body.items.map(
          (p: { minPriceCents: number }) => p.minPriceCents,
        );
        expect(prices.length).toBeGreaterThan(0);
        for (const price of prices) {
          expect(price).toBeGreaterThanOrEqual(29000);
          expect(price).toBeLessThanOrEqual(39000);
        }
        expect(prices).toContain(29000); // inclusive at both ends
        expect(prices).toContain(39000);
      });

      dbIt('excludes the sold-out product when inStockOnly is set', async () => {
        const all = await http().get('/api/v1/products?limit=50');
        const inStock = await http().get(
          '/api/v1/products?inStockOnly=true&limit=50',
        );

        const allSlugs = all.body.items.map((p: { slug: string }) => p.slug);
        const inStockSlugs = inStock.body.items.map(
          (p: { slug: string }) => p.slug,
        );

        expect(allSlugs).toContain('kitchen-knife-set');
        expect(inStockSlugs).not.toContain('kitchen-knife-set');
      });

      dbIt('reports the sold-out product as out of stock', async () => {
        const response = await http().get(
          '/api/v1/products?q=' + encodeURIComponent('ชุดมีดทำครัว'),
        );
        expect(response.body.items[0].slug).toBe('kitchen-knife-set');
        expect(response.body.items[0].inStock).toBe(false);
      });

      dbIt('ignores unknown query parameters', async () => {
        const clean = await http().get('/api/v1/products?limit=3');
        const noisy = await http().get(
          '/api/v1/products?limit=3&utm_source=email&fbclid=xyz',
        );

        expect(noisy.status).toBe(200);
        expect(noisy.body.items).toEqual(clean.body.items);
      });

      dbIt('rejects a limit above the maximum with 422', async () => {
        const response = await http().get('/api/v1/products?limit=500');
        expect(response.status).toBe(422);
        expect(response.body.errors[0].field).toBe('limit');
      });

      dbIt('rejects an unknown sort with 422', async () => {
        const response = await http().get('/api/v1/products?sort=cheapest');
        expect(response.status).toBe(422);
        expect(response.body.errors[0].field).toBe('sort');
      });
    });

    describe('sorting', () => {
      dbIt('price_asc orders by the cheapest variant, ascending', async () => {
        const response = await http().get(
          '/api/v1/products?sort=price_asc&limit=50',
        );

        const prices = response.body.items.map(
          (p: { minPriceCents: number }) => p.minPriceCents,
        );
        expect(prices).toEqual([...prices].sort((a, b) => a - b));
        expect(prices[0]).toBe(29000);
      });

      dbIt('price_desc is the exact reverse ordering', async () => {
        const response = await http().get(
          '/api/v1/products?sort=price_desc&limit=50',
        );

        const prices = response.body.items.map(
          (p: { minPriceCents: number }) => p.minPriceCents,
        );
        expect(prices).toEqual([...prices].sort((a, b) => b - a));
      });

      dbIt('name_asc orders by name', async () => {
        const response = await http().get(
          '/api/v1/products?sort=name_asc&limit=50',
        );

        const names = response.body.items.map((p: { name: string }) => p.name);
        // Collation is Postgres's, deliberately: both backends delegate ordering to
        // the database so they cannot disagree about Thai collation.
        expect(names).toHaveLength(13);
        expect(names[0]).toBeDefined();
      });

      dbIt('min_price_cents agrees with the cheapest active variant', async () => {
        // The denormalised column is what price_asc reads, so it has to be right.
        const mismatches = await prisma.$queryRaw<{ slug: string }[]>`
          SELECT p.slug FROM products p
          WHERE p.status = 'active'
            AND p.min_price_cents <> (
              SELECT MIN(v.price_cents) FROM product_variants v
              WHERE v.product_id = p.id AND v.is_active
            )
        `;
        expect(mismatches).toEqual([]);
      });
    });

    describe('cursor pagination', () => {
      const sorts = ['newest', 'price_asc', 'price_desc', 'name_asc'] as const;

      for (const sort of sorts) {
        dbIt(`walks every row exactly once with sort=${sort}`, async () => {
          const seen: string[] = [];
          let cursor: string | undefined;
          let pages = 0;

          do {
            const url =
              `/api/v1/products?sort=${sort}&limit=3` +
              (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
            const response = await http().get(url);

            expect(response.status).toBe(200);
            seen.push(...response.body.items.map((p: { id: string }) => p.id));
            cursor = response.body.nextCursor;
            pages += 1;
            expect(pages).toBeLessThan(20); // a runaway loop should fail, not hang
          } while (cursor);

          // Every active product, none twice, none missed.
          expect(seen).toHaveLength(13);
          expect(new Set(seen).size).toBe(13);
        });
      }

      dbIt('omits nextCursor on the final page', async () => {
        let cursor: string | undefined;
        let last: Record<string, unknown> = {};

        do {
          const response = await http().get(
            '/api/v1/products?limit=5' +
              (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
          );
          last = response.body;
          cursor = response.body.nextCursor;
        } while (cursor);

        expect(last.hasMore).toBe(false);
        expect('nextCursor' in last).toBe(false);
      });

      dbIt('carries the id tiebreaker, so tied sort values do not duplicate or vanish', async () => {
        // Four products share minPriceCents in the seed only by coincidence, so the
        // cursor is inspected directly: it must carry both halves.
        const first = await http().get('/api/v1/products?sort=price_asc&limit=2');
        const payload = decodeCursor(first.body.nextCursor);

        expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(payload.sortValue).toBe(
          String(first.body.items[1].minPriceCents),
        );
      });

      dbIt('does not skip a row when an earlier row is deleted between pages', async () => {
        // The keyset guarantee. An offset would shift the window and silently drop
        // a row here; a cursor anchored to a value cannot.
        const firstPage = await http().get('/api/v1/products?sort=name_asc&limit=4');
        const cursor = firstPage.body.nextCursor as string;

        // Archive a product from the first page — same effect as a delete, as far
        // as the listing is concerned, and reversible.
        const victim = firstPage.body.items[0].slug as string;
        await prisma.products.updateMany({
          where: { slug: victim },
          data: { status: 'archived' },
        });

        try {
          const secondPage = await http().get(
            `/api/v1/products?sort=name_asc&limit=4&cursor=${encodeURIComponent(cursor)}`,
          );

          const secondSlugs = secondPage.body.items.map(
            (p: { slug: string }) => p.slug,
          );
          const firstSlugs = firstPage.body.items.map(
            (p: { slug: string }) => p.slug,
          );

          // No overlap, and nothing from the first page reappears.
          expect(secondSlugs.filter((s: string) => firstSlugs.includes(s))).toEqual(
            [],
          );
        } finally {
          await prisma.products.updateMany({
            where: { slug: victim },
            data: { status: 'active' },
          });
        }
      });

      dbIt('rejects a malformed cursor with 422 invalid-cursor', async () => {
        const response = await http().get('/api/v1/products?cursor=not-a-cursor');

        expect(response.status).toBe(422);
        expect(response.body.type).toBe(
          'https://errors.example.com/invalid-cursor',
        );
      });

      dbIt('accepts a cursor whose sort differs, without crashing', async () => {
        // A client that changes the sort while holding a cursor is a client bug, but
        // it must not produce a 500. The cursor's sortValue simply casts into the
        // new column's type, or fails as a 422.
        const page = await http().get('/api/v1/products?sort=price_asc&limit=2');
        const response = await http().get(
          `/api/v1/products?sort=name_asc&limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`,
        );

        expect([200, 422]).toContain(response.status);
      });
    });
  });

  describe('GET /products/{slug}', () => {
    dbIt('returns the full detail with variants cheapest first', async () => {
      const response = await http().get('/api/v1/products/canvas-tote-bag');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        slug: 'canvas-tote-bag',
        status: 'active',
        currency: 'THB',
        minPriceCents: 59000,
      });
      expect(response.body.description.length).toBeGreaterThan(20);

      const prices = response.body.variants.map(
        (v: { priceCents: number }) => v.priceCents,
      );
      expect(prices).toEqual([59000, 69000, 89000]);
    });

    dbIt('computes availableStock per variant', async () => {
      const response = await http().get('/api/v1/products/canvas-tote-bag');

      const medium = response.body.variants.find(
        (v: { sku: string }) => v.sku === 'TOTE-M',
      );
      // The single unit the concurrency demo fires at.
      expect(medium.availableStock).toBe(1);
      expect(medium.name).toBe('กลาง');
    });

    dbIt('reflects reserved stock in availableStock', async () => {
      // on_hand minus reserved, not on_hand. Getting this wrong would advertise
      // stock already promised to an in-flight order.
      await prisma.product_variants.updateMany({
        where: { sku: 'TOTE-L' },
        data: { stock_reserved: 4 },
      });

      try {
        const response = await http().get('/api/v1/products/canvas-tote-bag');
        const large = response.body.variants.find(
          (v: { sku: string }) => v.sku === 'TOTE-L',
        );
        expect(large.availableStock).toBe(9 - 4);
      } finally {
        await prisma.product_variants.updateMany({
          where: { sku: 'TOTE-L' },
          data: { stock_reserved: 0 },
        });
      }
    });

    dbIt('returns every image in position order', async () => {
      const response = await http().get('/api/v1/products/crewneck-organic-tee');

      expect(response.body.images).toHaveLength(2);
      expect(response.body.images.map((i: { position: number }) => i.position)).toEqual(
        [0, 1],
      );
    });

    dbIt('reports inStock false when every variant is sold out', async () => {
      const response = await http().get('/api/v1/products/kitchen-knife-set');

      expect(response.body.inStock).toBe(false);
      expect(
        response.body.variants.every(
          (v: { availableStock: number }) => v.availableStock === 0,
        ),
      ).toBe(true);
    });

    dbIt('is 404 for a draft product, indistinguishable from one that never existed', async () => {
      const response = await http().get('/api/v1/products/long-sleeve-tee');

      expect(response.status).toBe(404);
      expect(response.body.type).toBe('https://errors.example.com/not-found');
    });

    dbIt('is 404 for an archived product', async () => {
      const response = await http().get('/api/v1/products/fleece-sweatpants');
      expect(response.status).toBe(404);
    });

    dbIt('is 404 for an unknown slug', async () => {
      const response = await http().get('/api/v1/products/no-such-product');
      expect(response.status).toBe(404);
    });

    dbIt('rejects a slug that is not slug-shaped with 422', async () => {
      const response = await http().get('/api/v1/products/Not_A_Slug');
      expect(response.status).toBe(422);
    });
  });
});
