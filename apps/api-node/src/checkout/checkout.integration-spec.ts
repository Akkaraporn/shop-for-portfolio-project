import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { configureApp } from '../bootstrap';
import { CartModule } from '../cart/cart.module';
import { LOGGER, LoggerModule } from '../common/logging/logger.module';
import { ConfigModule } from '../config/config.module';
import { PrismaModule } from '../infra/prisma/prisma.module';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisModule } from '../infra/redis/redis.module';
import { CheckoutModule } from './checkout.module';
import { ReservationSweeperService } from './reservation-sweeper.service';

/**
 * Checkout, against a real PostgreSQL. This is the task the project exists for, and
 * nothing here could be proved against a double: the `FOR UPDATE` locking, the unique
 * index behind idempotency, the `stock_reserved <= stock_on_hand` constraint, and the
 * transaction that must leave nothing behind when it rolls back are all database
 * behaviours.
 *
 *   make up-infra
 *   npm run test:integration
 */

const DATABASE_URL =
  process.env.DATABASE_URL_HOST ??
  'postgresql://shop:shop@localhost:55432/shop?schema=public';

const ADDRESS = {
  recipientName: 'สมชาย ใจดี',
  phone: '0812345678',
  line1: '123 ถนนสุขุมวิท',
  city: 'กรุงเทพมหานคร',
  province: 'กรุงเทพมหานคร',
  postalCode: '10110',
  country: 'TH',
};

const PLENTIFUL_SKU = 'TEE-CR-M';
const SCARCE_SKU = 'TOTE-M';

describe('checkout (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reachable = false;
  let variantIds: Record<string, string> = {};
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.REDIS_URL ??= 'redis://localhost:56379';
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret';
    process.env.SHIPPING_FLAT_CENTS = '5000';
    process.env.RESERVATION_TTL_MINUTES = '15';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        LoggerModule,
        PrismaModule,
        RedisModule,
        AuthModule,
        CartModule,
        CheckoutModule,
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
        `\n  SKIPPING checkout integration tests: no database at ${DATABASE_URL}.\n`,
      );
      return;
    }

    const variants = await prisma.product_variants.findMany({
      where: { sku: { in: [PLENTIFUL_SKU, SCARCE_SKU] } },
      select: { id: true, sku: true },
    });
    variantIds = Object.fromEntries(variants.map((v) => [v.sku, v.id]));
  }, 60_000);

  afterAll(async () => {
    if (reachable && prisma && createdUserIds.length > 0) {
      // Orders reference variants with ON DELETE RESTRICT, so the teardown order
      // matters: reservations and items before orders, orders before users.
      const orders = await prisma.orders.findMany({
        where: { user_id: { in: createdUserIds } },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);

      await prisma.stock_reservations.deleteMany({
        where: { order_id: { in: orderIds } },
      });
      await prisma.payments.deleteMany({ where: { order_id: { in: orderIds } } });
      await prisma.order_items.deleteMany({ where: { order_id: { in: orderIds } } });
      await prisma.outbox_events.deleteMany({
        where: { aggregate_id: { in: orderIds } },
      });
      await prisma.orders.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.idempotency_keys.deleteMany({
        where: { user_id: { in: createdUserIds } },
      });
      await prisma.carts.deleteMany({ where: { user_id: { in: createdUserIds } } });
      await prisma.refresh_tokens.deleteMany({
        where: { user_id: { in: createdUserIds } },
      });
      await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
      await prisma.carts.deleteMany({ where: { user_id: null } });

      // Put every variant's reserved stock back to zero, so a failure in one test
      // cannot quietly change what the next one sees.
      await prisma.product_variants.updateMany({ data: { stock_reserved: 0 } });
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

  let seq = 0;
  const signUp = async (): Promise<string> => {
    seq += 1;
    const response = await http()
      .post('/api/v1/auth/register')
      .send({
        email: `checkout-${Date.now()}-${seq}@example.com`,
        password: 'DemoPass123!',
        fullName: 'ผู้ทดสอบ',
      });
    expect(response.status).toBe(201);
    createdUserIds.push(response.body.user.id);
    return response.body.tokens.accessToken;
  };

  /** Signs up and puts one line in the basket. */
  const shopperWith = async (
    sku: string,
    quantity: number,
  ): Promise<string> => {
    const accessToken = await signUp();
    const added = await http()
      .post('/api/v1/carts/me/items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ variantId: variantIds[sku], quantity });
    expect(added.status).toBe(200);
    return accessToken;
  };

  const placeOrder = (accessToken: string, key = randomUUID(), body = {}) =>
    http()
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key)
      .send({ shippingAddress: ADDRESS, paymentMethod: 'card', ...body });

  describe('placing an order', () => {
    dbIt('creates the order, the payment and the reservation together', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 2);

      const response = await placeOrder(token);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        status: 'pending_payment',
        cancellable: true,
        currency: 'THB',
        subtotalCents: 78000,
        shippingCents: 5000,
        totalCents: 83000,
      });
      expect(response.body.orderNumber).toMatch(/^ORD-\d{4}-\d{7}$/);
      expect(response.body.payment).toMatchObject({
        status: 'requires_action',
        method: 'card',
        amountCents: 83000,
      });
      expect(response.body.reservationExpiresAt).toBeDefined();
    });

    dbIt('snapshots every descriptive field on the line', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 1);
      const response = await placeOrder(token);

      const [line] = response.body.items;
      expect(line).toMatchObject({
        sku: PLENTIFUL_SKU,
        variantName: 'ขาว / M',
        unitPriceCents: 39000,
        quantity: 1,
        lineTotalCents: 39000,
      });
      expect(line.productName).toContain('เสื้อยืด');
    });

    dbIt('freezes the price: repricing afterwards does not change the order', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 1);
      const order = await placeOrder(token);

      await prisma.product_variants.update({
        where: { id: variantIds[PLENTIFUL_SKU] },
        data: { price_cents: 99000 },
      });

      try {
        const stored = await prisma.order_items.findFirst({
          where: { order_id: order.body.id },
          select: { unit_price_cents: true },
        });
        // A basket shows live prices; an order freezes them. This is the whole
        // reason order_items snapshots rather than joins.
        expect(Number(stored!.unit_price_cents)).toBe(39000);
      } finally {
        await prisma.product_variants.update({
          where: { id: variantIds[PLENTIFUL_SKU] },
          data: { price_cents: 39000 },
        });
      }
    });

    dbIt('reserves stock without decrementing it', async () => {
      const before = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantIds[PLENTIFUL_SKU] },
        select: { stock_on_hand: true, stock_reserved: true },
      });

      const token = await shopperWith(PLENTIFUL_SKU, 3);
      await placeOrder(token);

      const after = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantIds[PLENTIFUL_SKU] },
        select: { stock_on_hand: true, stock_reserved: true },
      });

      // A reservation is a promise. The webhook is what makes it real.
      expect(after.stock_on_hand).toBe(before.stock_on_hand);
      expect(after.stock_reserved).toBe(before.stock_reserved + 3);
    });

    dbIt('empties the basket but keeps it', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 1);
      await placeOrder(token);

      const cart = await http()
        .get('/api/v1/carts/me')
        .set('Authorization', `Bearer ${token}`);

      expect(cart.body.items).toEqual([]);
      expect(cart.body.subtotalCents).toBe(0);
    });

    dbIt('writes an order.placed outbox event in the same transaction', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 1);
      const order = await placeOrder(token);

      const events = await prisma.outbox_events.findMany({
        where: { aggregate_id: order.body.id },
        select: { event_type: true, published_at: true },
      });

      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('order.placed');
      // Nothing consumes it: the table is evidence the design accounts for async
      // delivery, and a real broker is deliberately out of scope.
      expect(events[0].published_at).toBeNull();
    });

    dbIt('issues sequential order numbers', async () => {
      const first = await placeOrder(await shopperWith(PLENTIFUL_SKU, 1));
      const second = await placeOrder(await shopperWith(PLENTIFUL_SKU, 1));

      const seqOf = (n: string) => Number(n.split('-')[2]);
      expect(seqOf(second.body.orderNumber)).toBe(
        seqOf(first.body.orderNumber) + 1,
      );
    });

    dbIt('rejects an empty basket with 422', async () => {
      const token = await signUp();
      const response = await placeOrder(token);

      expect(response.status).toBe(422);
      expect(response.body.errors[0].field).toBe('cart');
    });

    dbIt('requires authentication', async () => {
      const response = await http()
        .post('/api/v1/checkout')
        .set('Idempotency-Key', randomUUID())
        .send({ shippingAddress: ADDRESS, paymentMethod: 'card' });

      expect(response.status).toBe(401);
    });

    dbIt('rejects an invalid address with 422 naming each bad field', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 1);

      const response = await http()
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          shippingAddress: { ...ADDRESS, postalCode: 'ABC', country: 'Thailand' },
          paymentMethod: 'bitcoin',
        });

      expect(response.status).toBe(422);
      const fields = response.body.errors.map((e: { field: string }) => e.field);
      expect(fields).toContain('shippingAddress.postalCode');
      expect(fields).toContain('shippingAddress.country');
      expect(fields).toContain('paymentMethod');
    });
  });

  describe('Idempotency-Key', () => {
    dbIt('is required', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 1);

      const response = await http()
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${token}`)
        .send({ shippingAddress: ADDRESS, paymentMethod: 'card' });

      expect(response.status).toBe(422);
      expect(response.body.errors[0].field).toBe('Idempotency-Key');
    });

    dbIt('replays the original response instead of placing a second order', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 2);
      const key = randomUUID();

      const first = await placeOrder(token, key);
      const second = await placeOrder(token, key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers['idempotency-replayed']).toBe('true');
      expect(first.headers['idempotency-replayed']).toBeUndefined();
      expect(second.body.orderNumber).toBe(first.body.orderNumber);

      // The decisive check: one order, not two.
      const orders = await prisma.orders.count({
        where: { order_number: first.body.orderNumber },
      });
      expect(orders).toBe(1);
    });

    dbIt('replays without reserving stock a second time', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 2);
      const key = randomUUID();

      await placeOrder(token, key);
      const afterFirst = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantIds[PLENTIFUL_SKU] },
        select: { stock_reserved: true },
      });

      await placeOrder(token, key);
      const afterReplay = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantIds[PLENTIFUL_SKU] },
        select: { stock_reserved: true },
      });

      expect(afterReplay.stock_reserved).toBe(afterFirst.stock_reserved);
    });

    dbIt('ignores key order and whitespace in the body', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 1);
      const key = randomUUID();

      const first = await placeOrder(token, key);

      // Same content, different key order. Canonicalisation is what makes these the
      // same request.
      const reordered = await http()
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({
            paymentMethod: 'card',
            shippingAddress: {
              country: ADDRESS.country,
              postalCode: ADDRESS.postalCode,
              province: ADDRESS.province,
              city: ADDRESS.city,
              line1: ADDRESS.line1,
              phone: ADDRESS.phone,
              recipientName: ADDRESS.recipientName,
            },
          }),
        );

      expect(reordered.status).toBe(201);
      expect(reordered.headers['idempotency-replayed']).toBe('true');
      expect(reordered.body.orderNumber).toBe(first.body.orderNumber);
    });

    dbIt('refuses the same key with a different body', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 1);
      const key = randomUUID();

      await placeOrder(token, key);
      const different = await placeOrder(token, key, {
        paymentMethod: 'promptpay',
      });

      // Neither answer is safe: replaying returns an order for a request that was
      // not made, and proceeding lets one key stand for two requests.
      expect(different.status).toBe(422);
      expect(different.body.type).toBe(
        'https://errors.example.com/idempotency-key-reused',
      );
    });

    dbIt('scopes keys per user, so two shoppers may use the same one', async () => {
      const key = randomUUID();
      const a = await shopperWith(PLENTIFUL_SKU, 1);
      const b = await shopperWith(PLENTIFUL_SKU, 1);

      const first = await placeOrder(a, key);
      const second = await placeOrder(b, key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.orderNumber).not.toBe(first.body.orderNumber);
    });

    dbIt('releases the key after a failure, so a retry is a fresh attempt', async () => {
      const token = await signUp();
      const key = randomUUID();

      // Fails: the basket is empty.
      const failed = await placeOrder(token, key);
      expect(failed.status).toBe(422);

      // Now fill the basket and retry with the same key. A key held from the failed
      // attempt would answer 409 in-progress or replay the failure; neither is useful.
      await http()
        .post('/api/v1/carts/me/items')
        .set('Authorization', `Bearer ${token}`)
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 1 });

      const retried = await placeOrder(token, key);
      expect(retried.status).toBe(201);
    });
  });

  describe('stock', () => {
    dbIt('reports every short line in one 409, not just the first', async () => {
      const token = await signUp();

      // Two lines, both impossible: one scarce, one over-ordered.
      await http()
        .post('/api/v1/carts/me/items')
        .set('Authorization', `Bearer ${token}`)
        .send({ variantId: variantIds[SCARCE_SKU], quantity: 1 });
      await http()
        .post('/api/v1/carts/me/items')
        .set('Authorization', `Bearer ${token}`)
        .send({ variantId: variantIds[PLENTIFUL_SKU], quantity: 5 });

      // Take everything away underneath the basket.
      await prisma.product_variants.updateMany({
        where: { sku: { in: [SCARCE_SKU, PLENTIFUL_SKU] } },
        data: { stock_reserved: 0 },
      });
      await prisma.$executeRaw`
        UPDATE product_variants SET stock_reserved = stock_on_hand
        WHERE sku IN (${SCARCE_SKU}, ${PLENTIFUL_SKU})
      `;

      try {
        const response = await placeOrder(token);

        expect(response.status).toBe(409);
        expect(response.body.type).toBe(
          'https://errors.example.com/insufficient-stock',
        );
        // Both lines named at once. Reporting one at a time would make the shopper
        // fix the basket, retry, and be told about the next one.
        expect(response.body.errors).toHaveLength(2);
        for (const error of response.body.errors) {
          expect(error).toMatchObject({ available: 0 });
          expect(error.field).toMatch(/^items\[\d\]$/);
          expect(error.variantId).toBeDefined();
          expect(error.requested).toBeGreaterThan(0);
        }
      } finally {
        await prisma.product_variants.updateMany({
          where: { sku: { in: [SCARCE_SKU, PLENTIFUL_SKU] } },
          data: { stock_reserved: 0 },
        });
      }
    });

    dbIt('leaves nothing behind when it fails', async () => {
      const token = await shopperWith(SCARCE_SKU, 1);

      await prisma.$executeRaw`
        UPDATE product_variants SET stock_reserved = stock_on_hand WHERE sku = ${SCARCE_SKU}
      `;

      try {
        const ordersBefore = await prisma.orders.count();
        const response = await placeOrder(token);

        expect(response.status).toBe(409);
        // The transaction rolled back: no order, no reservation, and the basket is
        // still intact so the shopper can fix it.
        expect(await prisma.orders.count()).toBe(ordersBefore);

        const cart = await http()
          .get('/api/v1/carts/me')
          .set('Authorization', `Bearer ${token}`);
        expect(cart.body.items).toHaveLength(1);
      } finally {
        await prisma.product_variants.updateMany({
          where: { sku: SCARCE_SKU },
          data: { stock_reserved: 0 },
        });
      }
    });

    dbIt('never lets stock_reserved exceed stock_on_hand', async () => {
      const violations = await prisma.$queryRaw<{ sku: string }[]>`
        SELECT sku FROM product_variants WHERE stock_reserved > stock_on_hand
      `;
      // The database constraint makes this impossible, but asserting it here means a
      // concurrency bug shows up as a test failure rather than a rejected write in a log.
      expect(violations).toEqual([]);
    });
  });

  describe('the definition of done', () => {
    dbIt(
      '20 concurrent checkouts on one remaining unit: exactly one succeeds',
      async () => {
        await prisma.product_variants.updateMany({
          where: { sku: SCARCE_SKU },
          data: { stock_on_hand: 1, stock_reserved: 0 },
        });

        // Twenty separate shoppers, each holding the same last unit in their basket.
        // Legal, because adding to a basket reserves nothing (task 2.4).
        const tokens = await Promise.all(
          Array.from({ length: 20 }, () => shopperWith(SCARCE_SKU, 1)),
        );

        const responses = await Promise.all(
          tokens.map((token) => placeOrder(token)),
        );

        const created = responses.filter((r) => r.status === 201);
        const conflicted = responses.filter((r) => r.status === 409);

        expect(created).toHaveLength(1);
        expect(conflicted).toHaveLength(19);
        for (const response of conflicted) {
          expect(response.body.type).toBe(
            'https://errors.example.com/insufficient-stock',
          );
        }

        // And the database agrees: one unit, one reservation, nothing oversold.
        const variant = await prisma.product_variants.findUniqueOrThrow({
          where: { id: variantIds[SCARCE_SKU] },
          select: { stock_on_hand: true, stock_reserved: true },
        });
        expect(variant.stock_on_hand).toBe(1);
        expect(variant.stock_reserved).toBe(1);
        expect(variant.stock_reserved).toBeLessThanOrEqual(variant.stock_on_hand);

        const held = await prisma.stock_reservations.count({
          where: { variant_id: variantIds[SCARCE_SKU], status: 'held' },
        });
        expect(held).toBe(1);
      },
      120_000,
    );

    dbIt(
      'concurrent baskets sharing items in opposite orders do not deadlock',
      async () => {
        // Without ascending-id lock ordering, A holds X and waits for Y while B holds
        // Y and waits for X, and Postgres kills one of them with a deadlock error —
        // which would surface as a 500, not a 409.
        await prisma.product_variants.updateMany({
          where: { sku: { in: [PLENTIFUL_SKU, SCARCE_SKU] } },
          data: { stock_on_hand: 100, stock_reserved: 0 },
        });

        const makeShopper = async (order: string[]) => {
          const token = await signUp();
          for (const sku of order) {
            await http()
              .post('/api/v1/carts/me/items')
              .set('Authorization', `Bearer ${token}`)
              .send({ variantId: variantIds[sku], quantity: 1 });
          }
          return token;
        };

        const pairs = await Promise.all([
          ...Array.from({ length: 6 }, () =>
            makeShopper([PLENTIFUL_SKU, SCARCE_SKU]),
          ),
          ...Array.from({ length: 6 }, () =>
            makeShopper([SCARCE_SKU, PLENTIFUL_SKU]),
          ),
        ]);

        const responses = await Promise.all(pairs.map((t) => placeOrder(t)));

        // Every one of them succeeds. A deadlock would show as a 500.
        expect(responses.filter((r) => r.status === 201)).toHaveLength(12);
        expect(responses.filter((r) => r.status >= 500)).toHaveLength(0);

        await prisma.product_variants.updateMany({
          where: { sku: SCARCE_SKU },
          data: { stock_on_hand: 1, stock_reserved: 0 },
        });
        await prisma.product_variants.updateMany({
          where: { sku: PLENTIFUL_SKU },
          data: { stock_on_hand: 40, stock_reserved: 0 },
        });
      },
      120_000,
    );

    dbIt(
      'concurrent retries of one key place exactly one order',
      async () => {
        const token = await shopperWith(PLENTIFUL_SKU, 1);
        const key = randomUUID();

        const responses = await Promise.all(
          Array.from({ length: 8 }, () => placeOrder(token, key)),
        );

        const created = responses.filter((r) => r.status === 201);
        const inProgress = responses.filter(
          (r) =>
            r.status === 409 &&
            r.body.type === 'https://errors.example.com/checkout-in-progress',
        );

        // Whoever wins the unique index does the work; the rest are told to retry, or
        // replay if the winner already finished. Never two orders.
        expect(created.length).toBeGreaterThanOrEqual(1);
        expect(created.length + inProgress.length).toBe(8);

        const numbers = new Set(created.map((r) => r.body.orderNumber));
        expect(numbers.size).toBe(1);
      },
      120_000,
    );
  });

  describe('the reservation sweeper', () => {
    dbIt('releases an expired hold and expires the order', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 2);
      const order = await placeOrder(token);

      const reserved = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantIds[PLENTIFUL_SKU] },
        select: { stock_reserved: true },
      });

      await prisma.stock_reservations.updateMany({
        where: { order_id: order.body.id },
        data: { expires_at: new Date(Date.now() - 60_000) },
      });

      const released = await app.get(ReservationSweeperService).sweep();
      expect(released).toBeGreaterThanOrEqual(1);

      const after = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantIds[PLENTIFUL_SKU] },
        select: { stock_reserved: true },
      });
      expect(after.stock_reserved).toBe(reserved.stock_reserved - 2);

      const swept = await prisma.orders.findUniqueOrThrow({
        where: { id: order.body.id },
        select: { status: true },
      });
      expect(swept.status).toBe('expired');

      const reservation = await prisma.stock_reservations.findFirst({
        where: { order_id: order.body.id },
        select: { status: true, resolved_at: true },
      });
      expect(reservation!.status).toBe('released');
      expect(reservation!.resolved_at).not.toBeNull();
    });

    dbIt('leaves a hold that has not expired alone', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 1);
      const order = await placeOrder(token);

      await app.get(ReservationSweeperService).sweep();

      const untouched = await prisma.orders.findUniqueOrThrow({
        where: { id: order.body.id },
        select: { status: true },
      });
      expect(untouched.status).toBe('pending_payment');
    });

    dbIt('is idempotent: sweeping twice releases the stock once', async () => {
      const token = await shopperWith(PLENTIFUL_SKU, 3);
      const order = await placeOrder(token);

      await prisma.stock_reservations.updateMany({
        where: { order_id: order.body.id },
        data: { expires_at: new Date(Date.now() - 60_000) },
      });

      const sweeper = app.get(ReservationSweeperService);
      await sweeper.sweep();
      const afterFirst = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantIds[PLENTIFUL_SKU] },
        select: { stock_reserved: true },
      });

      await sweeper.sweep();
      const afterSecond = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantIds[PLENTIFUL_SKU] },
        select: { stock_reserved: true },
      });

      // The re-read under the row lock is what makes this safe: a reservation that is
      // no longer `held` is skipped rather than double-released.
      expect(afterSecond.stock_reserved).toBe(afterFirst.stock_reserved);
    });
  });
});
