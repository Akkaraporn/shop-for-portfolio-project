import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { configureApp } from '../bootstrap';
import { LOGGER, LoggerModule } from '../common/logging/logger.module';
import { ConfigModule } from '../config/config.module';
import { PrismaModule } from '../infra/prisma/prisma.module';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisModule } from '../infra/redis/redis.module';
import { CartModule } from './cart.module';
import { CartSweeperService } from './cart-sweeper.service';
import { guestCartExpiry, hashCartToken } from './cart-resolver.service';

/**
 * The basket, against a real PostgreSQL with the V2 seed applied.
 *
 * Needs a database, and everything here is why: the partial unique index that makes
 * one basket per user enforceable, the composite unique that makes add-to-cart an
 * upsert rather than a duplicate line, the cascade that cleans up a merged basket's
 * items, and the `carts_single_owner_check` constraint that a wrong claim would trip.
 *
 *   make up-infra
 *   npm run test:integration
 */

const DATABASE_URL =
  process.env.DATABASE_URL_HOST ??
  'postgresql://shop:shop@localhost:55432/shop?schema=public';

/** A variant with plenty of stock: the crewneck tee in medium, 40 on hand. */
const PLENTIFUL_SKU = 'TEE-CR-M';
/** The single-unit variant the concurrency demo uses. */
const SCARCE_SKU = 'TOTE-M';
/** Fully sold out. */
const SOLD_OUT_SKU = 'KNF-ST-3P';
/** Belongs to a draft product, so it must not be sellable. */
const DRAFT_SKU = 'TEE-LS-M';

describe('cart (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reachable = false;
  let variantIds: Record<string, string> = {};
  let createdUserIds: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.REDIS_URL ??= 'redis://localhost:56379';
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        LoggerModule,
        PrismaModule,
        RedisModule,
        AuthModule,
        CartModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
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
        `\n  SKIPPING cart integration tests: no database at ${DATABASE_URL}.` +
          '\n  Start one with `make up-infra` and re-run.\n',
      );
      return;
    }

    const variants = await prisma.product_variants.findMany({
      where: {
        sku: { in: [PLENTIFUL_SKU, SCARCE_SKU, SOLD_OUT_SKU, DRAFT_SKU] },
      },
      select: { id: true, sku: true },
    });
    variantIds = Object.fromEntries(variants.map((v) => [v.sku, v.id]));
  }, 60_000);

  afterAll(async () => {
    if (reachable && prisma) {
      // Only what these tests created. The seed is left exactly as it was.
      await prisma.carts.deleteMany({ where: { user_id: { in: createdUserIds } } });
      await prisma.refresh_tokens.deleteMany({
        where: { user_id: { in: createdUserIds } },
      });
      await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
      await prisma.carts.deleteMany({ where: { user_id: null } });
    }
    if (app) {
      await app.close();
    }
  });

  const dbIt = (name: string, fn: () => Promise<void>, timeout?: number): void => {
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

  /** Runs a body with a variant's stock temporarily changed, then restores the seed. */
  const withStock = async (
    sku: string,
    stockOnHand: number,
    body: () => Promise<void>,
  ): Promise<void> => {
    const original = await prisma.product_variants.findFirst({
      where: { sku },
      select: { id: true, stock_on_hand: true },
    });
    await prisma.product_variants.update({
      where: { id: original!.id },
      data: { stock_on_hand: stockOnHand },
    });
    try {
      await body();
    } finally {
      await prisma.product_variants.update({
        where: { id: original!.id },
        data: { stock_on_hand: original!.stock_on_hand },
      });
    }
  };

  let userSeq = 0;
  /** Registers a throwaway account and returns its tokens. */
  const signUp = async (): Promise<{ accessToken: string; userId: string }> => {
    userSeq += 1;
    const email = `cart-test-${Date.now()}-${userSeq}@example.com`;
    const response = await http()
      .post('/api/v1/auth/register')
      .send({ email, password: 'DemoPass123!', fullName: 'ผู้ทดสอบ' });

    expect(response.status).toBe(201);
    createdUserIds.push(response.body.user.id);
    return {
      accessToken: response.body.tokens.accessToken,
      userId: response.body.user.id,
    };
  };

  describe('resolution', () => {
    dbIt('creates a guest basket and returns its token when nothing is presented', async () => {
      const response = await http().get('/api/v1/carts/me');

      expect(response.status).toBe(200);
      expect(response.headers['x-cart-token']).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(response.body).toMatchObject({
        items: [],
        itemCount: 0,
        subtotalCents: 0,
        currency: 'THB',
      });
      // Guest baskets expire; a user's does not.
      expect(response.body.expiresAt).toBeDefined();
    });

    dbIt('stores only a hash of the guest token', async () => {
      const response = await http().get('/api/v1/carts/me');
      const token = response.headers['x-cart-token'] as string;

      const row = await prisma.carts.findUnique({
        where: { id: response.body.id },
        select: { token_hash: true },
      });

      expect(row!.token_hash).toBe(hashCartToken(token));
      expect(row!.token_hash).not.toBe(token);
    });

    dbIt('returns the same basket for the same token', async () => {
      const first = await http().get('/api/v1/carts/me');
      const token = first.headers['x-cart-token'] as string;

      const second = await http().get('/api/v1/carts/me').set('X-Cart-Token', token);

      expect(second.body.id).toBe(first.body.id);
      // Echoed even when unchanged, so a client stores only the latest value it saw.
      expect(second.headers['x-cart-token']).toBe(token);
    });

    dbIt('silently issues a new basket for an unknown token, rather than 404', async () => {
      // Someone who left a tab open overnight should find an empty cart, not an
      // error. A 404 would also confirm to an attacker which tokens are real.
      const response = await http()
        .get('/api/v1/carts/me')
        .set('X-Cart-Token', 'a'.repeat(43));

      expect(response.status).toBe(200);
      expect(response.headers['x-cart-token']).not.toBe('a'.repeat(43));
      expect(response.body.items).toEqual([]);
    });

    dbIt('treats an expired basket as absent', async () => {
      const created = await http().get('/api/v1/carts/me');
      const token = created.headers['x-cart-token'] as string;

      await prisma.carts.update({
        where: { id: created.body.id },
        data: { expires_at: new Date(Date.now() - 1000) },
      });

      const response = await http().get('/api/v1/carts/me').set('X-Cart-Token', token);

      expect(response.status).toBe(200);
      expect(response.body.id).not.toBe(created.body.id);
    });

    dbIt('gives a signed-in user their own basket, and no token', async () => {
      const { accessToken } = await signUp();

      const response = await http()
        .get('/api/v1/carts/me')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      // A user's basket has no guest token, so none is sent.
      expect(response.headers['x-cart-token']).toBeUndefined();
      expect(response.body.expiresAt).toBeUndefined();
    });

    dbIt('ignores X-Cart-Token entirely when a valid access token is present', async () => {
      // Combining them is a merge, which is an explicit endpoint rather than a side
      // effect of reading the basket.
      const guest = await http().get('/api/v1/carts/me');
      const guestToken = guest.headers['x-cart-token'] as string;
      await http()
        .post('/api/v1/carts/me/items')
        .set('X-Cart-Token', guestToken)
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 2 });

      const { accessToken } = await signUp();

      const response = await http()
        .get('/api/v1/carts/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Cart-Token', guestToken);

      expect(response.body.id).not.toBe(guest.body.id);
      expect(response.body.items).toEqual([]);
    });

    dbIt('keeps exactly one basket per user under concurrent first requests', async () => {
      // The partial unique index on carts(user_id) is the only thing that can decide
      // this; a pre-flight check would let both requests through.
      const { accessToken, userId } = await signUp();

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          http().get('/api/v1/carts/me').set('Authorization', `Bearer ${accessToken}`),
        ),
      );

      for (const response of responses) {
        expect(response.status).toBe(200);
      }
      expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
      expect(
        await prisma.carts.count({ where: { user_id: userId } }),
      ).toBe(1);
    });
  });

  describe('POST /carts/me/items', () => {
    dbIt('adds a line with live pricing', async () => {
      const response = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 2 });

      expect(response.status).toBe(200);
      const [line] = response.body.items;
      expect(line).toMatchObject({
        sku: PLENTIFUL_SKU,
        quantity: 2,
        unitPriceCents: 39000,
        lineTotalCents: 78000,
        currency: 'THB',
      });
      expect(response.body.subtotalCents).toBe(78000);
      expect(response.body.itemCount).toBe(2);
      expect(line.imageUrl).toContain('picsum.photos');
    });

    dbIt('sums into the existing line instead of creating a second one', async () => {
      const first = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 2 });
      const token = first.headers['x-cart-token'] as string;

      const second = await http()
        .post('/api/v1/carts/me/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 3 });

      // The composite unique on (cart_id, variant_id) is what makes this an upsert.
      expect(second.body.items).toHaveLength(1);
      expect(second.body.items[0].quantity).toBe(5);
      expect(second.body.itemCount).toBe(5);
    });

    dbIt('caps a summed line at 99 rather than rejecting it', async () => {
      // The cap is 99, so proving it needs more than 99 in stock. The seed gives this
      // variant 40 — a realistic figure — so it is raised for the duration and put
      // back afterwards.
      await withStock(PLENTIFUL_SKU, 150, async () => {
        const first = await http()
          .post('/api/v1/carts/me/items')
          .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 95 });
        const token = first.headers['x-cart-token'] as string;

        const second = await http()
          .post('/api/v1/carts/me/items')
          .set('X-Cart-Token', token)
          .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 20 });

        expect(second.status).toBe(200);
        expect(second.body.items[0].quantity).toBe(99);
      });
    });

    dbIt('reserves nothing: stock_reserved is untouched', async () => {
      const before = await prisma.product_variants.findFirst({
        where: { sku: SCARCE_SKU },
        select: { stock_reserved: true },
      });

      await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[SCARCE_SKU], quantity: 1 });

      const after = await prisma.product_variants.findFirst({
        where: { sku: SCARCE_SKU },
        select: { stock_reserved: true },
      });

      // Adding to a basket promises nothing. Reservation happens at checkout only —
      // reserving here would lock stock against people who never buy.
      expect(after!.stock_reserved).toBe(before!.stock_reserved);
    });

    dbIt('lets two shoppers both hold the last unit', async () => {
      // A direct consequence of not reserving. Both baskets are legal; the loser
      // finds out at checkout, which is where the 409 belongs.
      const a = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[SCARCE_SKU], quantity: 1 });
      const b = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[SCARCE_SKU], quantity: 1 });

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.id).not.toBe(b.body.id);
    });

    dbIt('is 409 with every detail when the quantity exceeds available stock', async () => {
      const response = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[SCARCE_SKU], quantity: 5 });

      expect(response.status).toBe(409);
      expect(response.body.type).toBe(
        'https://errors.example.com/insufficient-stock',
      );
      expect(response.body.errors[0]).toMatchObject({
        field: 'quantity',
        variantId: variantIds[SCARCE_SKU],
        requested: 5,
        available: 1,
      });
    });

    dbIt('is 409 for a sold-out variant', async () => {
      const response = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[SOLD_OUT_SKU], quantity: 1 });

      expect(response.status).toBe(409);
      expect(response.body.errors[0].available).toBe(0);
    });

    dbIt('is 404 for a variant of a draft product', async () => {
      // Same answer as a variant that does not exist: anything else would let the
      // unpublished catalogue be enumerated through the cart endpoint.
      const response = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[DRAFT_SKU], quantity: 1 });

      expect(response.status).toBe(404);
    });

    dbIt('is 404 for a variant that does not exist', async () => {
      const response = await http()
        .post('/api/v1/carts/me/items')
        .send({
          variantId: '01930099-0000-7000-8000-000000009999',
          quantity: 1,
        });

      expect(response.status).toBe(404);
    });

    dbIt('is 422 for quantity zero, and for a non-uuid variant', async () => {
      const zero = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 0 });
      expect(zero.status).toBe(422);

      const notUuid = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: 'nope', quantity: 1 });
      expect(notUuid.status).toBe(422);
      expect(
        notUuid.body.errors.map((e: { field: string }) => e.field),
      ).toContain('variantId');
    });
  });

  describe('prices are live', () => {
    dbIt('reflects a reprice on the next read, without touching the line', async () => {
      const added = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 2 });
      const token = added.headers['x-cart-token'] as string;
      expect(added.body.subtotalCents).toBe(78000);

      await prisma.product_variants.update({
        where: { id: variantIds[PLENTIFUL_SKU] },
        data: { price_cents: 45000 },
      });

      try {
        const reread = await http()
          .get('/api/v1/carts/me')
          .set('X-Cart-Token', token);

        // A basket shows live prices. Caching one would let a shopper carry a stale
        // price to the payment step and discover the change there.
        expect(reread.body.items[0].unitPriceCents).toBe(45000);
        expect(reread.body.items[0].lineTotalCents).toBe(90000);
        expect(reread.body.subtotalCents).toBe(90000);
      } finally {
        await prisma.product_variants.update({
          where: { id: variantIds[PLENTIFUL_SKU] },
          data: { price_cents: 39000 },
        });
      }
    });

    dbIt('carries no shipping or grand total', async () => {
      const response = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 1 });

      // Those are computed at checkout, so a basket never implies a final price it
      // cannot honour.
      expect(response.body.shippingCents).toBeUndefined();
      expect(response.body.totalCents).toBeUndefined();
    });
  });

  describe('PATCH and DELETE', () => {
    const seedCart = async (): Promise<{ token: string; itemId: string }> => {
      const response = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 3 });
      return {
        token: response.headers['x-cart-token'] as string,
        itemId: response.body.items[0].id,
      };
    };

    dbIt('sets an absolute quantity', async () => {
      const { token, itemId } = await seedCart();

      const response = await http()
        .patch(`/api/v1/carts/me/items/${itemId}`)
        .set('X-Cart-Token', token)
        .send({ quantity: 7 });

      expect(response.status).toBe(200);
      expect(response.body.items[0].quantity).toBe(7);
    });

    dbIt('rejects quantity zero: removal is DELETE', async () => {
      const { token, itemId } = await seedCart();

      const response = await http()
        .patch(`/api/v1/carts/me/items/${itemId}`)
        .set('X-Cart-Token', token)
        .send({ quantity: 0 });

      expect(response.status).toBe(422);
    });

    dbIt('is 409 when the new quantity exceeds stock', async () => {
      const added = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[SCARCE_SKU], quantity: 1 });

      const response = await http()
        .patch(`/api/v1/carts/me/items/${added.body.items[0].id}`)
        .set('X-Cart-Token', added.headers['x-cart-token'] as string)
        .send({ quantity: 4 });

      expect(response.status).toBe(409);
    });

    dbIt('returns the remaining basket on delete', async () => {
      const { token, itemId } = await seedCart();

      const response = await http()
        .delete(`/api/v1/carts/me/items/${itemId}`)
        .set('X-Cart-Token', token);

      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([]);
      expect(response.body.subtotalCents).toBe(0);
    });

    dbIt('is 404 deleting the same line twice', async () => {
      const { token, itemId } = await seedCart();

      await http()
        .delete(`/api/v1/carts/me/items/${itemId}`)
        .set('X-Cart-Token', token);
      const second = await http()
        .delete(`/api/v1/carts/me/items/${itemId}`)
        .set('X-Cart-Token', token);

      expect(second.status).toBe(404);
    });

    dbIt("is 404 for a line in somebody else's basket", async () => {
      const mine = await seedCart();
      const theirs = await seedCart();

      // Scoping every lookup to the resolved basket is what makes this a 404 rather
      // than an edit of a stranger's line.
      const response = await http()
        .patch(`/api/v1/carts/me/items/${theirs.itemId}`)
        .set('X-Cart-Token', mine.token)
        .send({ quantity: 1 });

      expect(response.status).toBe(404);
    });
  });

  describe('POST /carts/me/merge', () => {
    dbIt('moves a guest basket into an empty user basket', async () => {
      const guest = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 2 });
      const guestToken = guest.headers['x-cart-token'] as string;
      const guestCartId = guest.body.id;

      const { accessToken } = await signUp();

      const merged = await http()
        .post('/api/v1/carts/me/merge')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ cartToken: guestToken });

      expect(merged.status).toBe(200);
      expect(merged.body.items).toHaveLength(1);
      expect(merged.body.items[0].quantity).toBe(2);
      // The guest row is gone, and its lines went with it via the cascade.
      expect(await prisma.carts.count({ where: { id: guestCartId } })).toBe(0);
      expect(
        await prisma.cart_items.count({ where: { cart_id: guestCartId } }),
      ).toBe(0);
    });

    dbIt('sums quantities for a variant present in both', async () => {
      const { accessToken } = await signUp();
      await http()
        .post('/api/v1/carts/me/items')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 4 });

      const guest = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 3 });

      const merged = await http()
        .post('/api/v1/carts/me/merge')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ cartToken: guest.headers['x-cart-token'] as string });

      expect(merged.body.items).toHaveLength(1);
      expect(merged.body.items[0].quantity).toBe(7);
    });

    dbIt('caps a summed line at 99', async () => {
      await withStock(PLENTIFUL_SKU, 150, async () => {
        const { accessToken } = await signUp();
        await http()
          .post('/api/v1/carts/me/items')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 90 });

        const guest = await http()
          .post('/api/v1/carts/me/items')
          .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 30 });

        const merged = await http()
          .post('/api/v1/carts/me/merge')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ cartToken: guest.headers['x-cart-token'] as string });

        expect(merged.body.items[0].quantity).toBe(99);
      });
    });

    dbIt('does not fail when the merged quantity exceeds available stock', async () => {
      // Deliberate: signing in must not lose the basket because something sold out
      // in the meantime. Checkout is where that becomes a 409, naming every short
      // line at once.
      const { accessToken } = await signUp();
      await http()
        .post('/api/v1/carts/me/items')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ variantId: variantIds[SCARCE_SKU], quantity: 1 });

      const guest = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[SCARCE_SKU], quantity: 1 });

      const merged = await http()
        .post('/api/v1/carts/me/merge')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ cartToken: guest.headers['x-cart-token'] as string });

      expect(merged.status).toBe(200);
      // Two of something with one in stock. Legal in a basket, not at checkout.
      expect(merged.body.items[0].quantity).toBe(2);
      expect(merged.body.items[0].availableStock).toBe(1);
    });

    dbIt('is idempotent: a second merge with the same token succeeds', async () => {
      const guest = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 2 });
      const token = guest.headers['x-cart-token'] as string;
      const { accessToken } = await signUp();

      const first = await http()
        .post('/api/v1/carts/me/merge')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ cartToken: token });
      const second = await http()
        .post('/api/v1/carts/me/merge')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ cartToken: token });

      expect(second.status).toBe(200);
      // Not doubled: the guest basket no longer exists, so there is nothing to add.
      expect(second.body.items[0].quantity).toBe(2);
      expect(second.body.id).toBe(first.body.id);
    });

    dbIt('returns the current basket for an unknown token', async () => {
      const { accessToken } = await signUp();
      await http()
        .post('/api/v1/carts/me/items')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 1 });

      const response = await http()
        .post('/api/v1/carts/me/merge')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ cartToken: 'z'.repeat(43) });

      expect(response.status).toBe(200);
      expect(response.body.items[0].quantity).toBe(1);
    });

    dbIt('requires authentication', async () => {
      const response = await http()
        .post('/api/v1/carts/me/merge')
        .send({ cartToken: 'z'.repeat(43) });

      expect(response.status).toBe(401);
    });
  });

  describe('the definition of done', () => {
    dbIt('guest adds two items, registers, keeps them, signs out and back in', async () => {
      // The exact flow the task specifies.
      const guest = await http()
        .post('/api/v1/carts/me/items')
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 2 });
      const guestToken = guest.headers['x-cart-token'] as string;

      await http()
        .post('/api/v1/carts/me/items')
        .set('X-Cart-Token', guestToken)
        .send({ variantId: variantIds[SCARCE_SKU], quantity: 1 });

      // Register carrying the cart token: the account has no basket yet, so task
      // 2.2's claim path re-owns the guest row outright and no merge is needed.
      userSeq += 1;
      const email = `cart-dod-${Date.now()}-${userSeq}@example.com`;
      const registered = await http()
        .post('/api/v1/auth/register')
        .set('X-Cart-Token', guestToken)
        .send({ email, password: 'DemoPass123!', fullName: 'ผู้ทดสอบ' });
      expect(registered.status).toBe(201);
      createdUserIds.push(registered.body.user.id);

      const afterRegister = await http()
        .get('/api/v1/carts/me')
        .set('Authorization', `Bearer ${registered.body.tokens.accessToken}`);

      expect(afterRegister.body.items).toHaveLength(2);
      expect(afterRegister.body.itemCount).toBe(3);
      // The claimed row is now owned by the user, so it no longer expires.
      expect(afterRegister.body.expiresAt).toBeUndefined();

      await http()
        .post('/api/v1/auth/logout')
        .send({ refreshToken: registered.body.tokens.refreshToken });

      const signedBackIn = await http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'DemoPass123!' });

      const afterLogin = await http()
        .get('/api/v1/carts/me')
        .set('Authorization', `Bearer ${signedBackIn.body.tokens.accessToken}`);

      expect(afterLogin.body.id).toBe(afterRegister.body.id);
      expect(afterLogin.body.items).toHaveLength(2);
      expect(afterLogin.body.itemCount).toBe(3);
    }, 60_000);
  });

  describe('the sweeper', () => {
    dbIt('deletes expired guest baskets and leaves live ones alone', async () => {
      const expired = await prisma.carts.create({
        data: {
          token_hash: hashCartToken(`sweeper-expired-${Date.now()}`),
          expires_at: new Date(Date.now() - 60_000),
        },
        select: { id: true },
      });
      const live = await prisma.carts.create({
        data: {
          token_hash: hashCartToken(`sweeper-live-${Date.now()}`),
          expires_at: guestCartExpiry(),
        },
        select: { id: true },
      });

      const swept = await app.get(CartSweeperService).sweep();

      expect(swept).toBeGreaterThanOrEqual(1);
      expect(await prisma.carts.count({ where: { id: expired.id } })).toBe(0);
      expect(await prisma.carts.count({ where: { id: live.id } })).toBe(1);

      await prisma.carts.deleteMany({ where: { id: live.id } });
    });

    dbIt('never deletes a user basket, which has no expiry', async () => {
      const { accessToken, userId } = await signUp();
      await http()
        .get('/api/v1/carts/me')
        .set('Authorization', `Bearer ${accessToken}`);

      await app.get(CartSweeperService).sweep();

      expect(await prisma.carts.count({ where: { user_id: userId } })).toBe(1);
    });
  });
});
