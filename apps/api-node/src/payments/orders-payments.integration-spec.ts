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
import { CheckoutModule } from '../checkout/checkout.module';
import { LOGGER, LoggerModule } from '../common/logging/logger.module';
import { ConfigModule } from '../config/config.module';
import { PrismaModule } from '../infra/prisma/prisma.module';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisModule } from '../infra/redis/redis.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from './payments.module';
import { SIGNATURE_HEADER, signWebhookBody } from './webhook-signature';

/**
 * Orders, payments and the webhook, against a real PostgreSQL.
 *
 * The centre of this suite is the asymmetry the design insists on: confirming a
 * payment moves nothing, and the webhook is the only thing that decrements stock.
 * Both halves are asserted, because collapsing them is the obvious "simplification"
 * that would leave the webhook path untested.
 */

const DATABASE_URL =
  process.env.DATABASE_URL_HOST ??
  'postgresql://shop:shop@localhost:55432/shop?schema=public';

const WEBHOOK_SECRET = 'test-webhook-secret-value';

const ADDRESS = {
  recipientName: 'สมชาย ใจดี',
  phone: '0812345678',
  line1: '123 ถนนสุขุมวิท',
  city: 'กรุงเทพมหานคร',
  province: 'กรุงเทพมหานคร',
  postalCode: '10110',
  country: 'TH',
};

const SKU = 'TEE-CR-M';

describe('orders and payments (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reachable = false;
  let variantId = '';
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.REDIS_URL ??= 'redis://localhost:56379';
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
    process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;
    // The provider's timer never fires in these tests; the webhook is delivered by
    // hand so its effects can be asserted synchronously.
    process.env.PAYMENT_MOCK_DELAY_MS = '600000';
    process.env.SHIPPING_FLAT_CENTS = '5000';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        LoggerModule,
        PrismaModule,
        RedisModule,
        AuthModule,
        CartModule,
        CheckoutModule,
        OrdersModule,
        PaymentsModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(LOGGER)
      .useValue(pino({ level: 'silent' }))
      .compile();

    // rawBody must be on, exactly as in main.ts: the webhook verifies its HMAC over
    // the bytes received. Without it the handler fails closed and every webhook 401s.
    app = moduleRef.createNestApplication({ rawBody: true });
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
        `\n  SKIPPING orders/payments integration tests: no database at ${DATABASE_URL}.\n`,
      );
      return;
    }

    const variant = await prisma.product_variants.findFirstOrThrow({
      where: { sku: SKU },
      select: { id: true },
    });
    variantId = variant.id;
  }, 60_000);

  afterAll(async () => {
    if (reachable && prisma && createdUserIds.length > 0) {
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
      await prisma.webhook_events.deleteMany({
        where: { event_id: { startsWith: 'evt_test_' } },
      });
      // Restore the seed's stock exactly.
      await prisma.product_variants.updateMany({
        where: { sku: SKU },
        data: { stock_on_hand: 40, stock_reserved: 0 },
      });
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
        email: `op-${Date.now()}-${seq}@example.com`,
        password: 'DemoPass123!',
        fullName: 'ผู้ทดสอบ',
      });
    expect(response.status).toBe(201);
    createdUserIds.push(response.body.user.id);
    return response.body.tokens.accessToken;
  };

  /** Signs up, fills a basket, checks out. Returns the token and the order. */
  const placeOrder = async (
    quantity = 1,
  ): Promise<{ token: string; order: Record<string, never> & any }> => {
    const token = await signUp();
    await http()
      .post('/api/v1/carts/me/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ variantId, quantity });

    const response = await http()
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ shippingAddress: ADDRESS, paymentMethod: 'card' });

    expect(response.status).toBe(201);
    return { token, order: response.body };
  };

  /** Posts a correctly signed webhook, the way the mock provider would. */
  const deliverWebhook = (
    event: Record<string, unknown>,
    options: { signature?: string } = {},
  ) => {
    const body = JSON.stringify(event);
    return http()
      .post('/api/v1/webhooks/payment')
      .set('Content-Type', 'application/json')
      .set(
        SIGNATURE_HEADER,
        options.signature ?? signWebhookBody(WEBHOOK_SECRET, body),
      )
      .send(body);
  };

  const succeededEvent = (paymentId: string, id = `evt_test_${randomUUID()}`) => ({
    id,
    type: 'payment.succeeded',
    createdAt: new Date().toISOString(),
    data: { paymentId },
  });

  describe('GET /orders', () => {
    dbIt('lists only the caller’s own orders, newest first', async () => {
      const mine = await placeOrder();
      await placeOrder(); // somebody else's

      const response = await http()
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${mine.token}`);

      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].orderNumber).toBe(mine.order.orderNumber);
      expect(response.body.hasMore).toBe(false);
    });

    dbIt('returns the Page envelope even for one item', async () => {
      const { token } = await placeOrder();
      const response = await http()
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`);

      expect(Object.keys(response.body).sort()).toEqual(['hasMore', 'items']);
    });

    dbIt('requires authentication', async () => {
      expect((await http().get('/api/v1/orders')).status).toBe(401);
    });
  });

  describe('GET /orders/{orderNumber}', () => {
    dbIt('returns the full order with its frozen lines and its payment', async () => {
      const { token, order } = await placeOrder(2);

      const response = await http()
        .get(`/api/v1/orders/${order.orderNumber}`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        orderNumber: order.orderNumber,
        status: 'pending_payment',
        cancellable: true,
        subtotalCents: 78000,
        shippingCents: 5000,
        totalCents: 83000,
      });
      expect(response.body.items[0].sku).toBe(SKU);
      expect(response.body.payment.status).toBe('requires_action');
      expect(response.body.shippingAddress.postalCode).toBe('10110');
    });

    dbIt('is 403, not 404, for an order that exists but is someone else’s', async () => {
      const { order } = await placeOrder();
      const intruder = await signUp();

      const response = await http()
        .get(`/api/v1/orders/${order.orderNumber}`)
        .set('Authorization', `Bearer ${intruder}`);

      // The caller asked about a real thing and simply may not see it. A 404 would be
      // theatre — order numbers are sequential — while making every genuine
      // permission problem look like a typo.
      expect(response.status).toBe(403);
      expect(response.body.type).toBe('https://errors.example.com/forbidden');
    });

    dbIt('is 404 for an order number that does not exist', async () => {
      const token = await signUp();
      const response = await http()
        .get('/api/v1/orders/ORD-2026-9999999')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
    });

    dbIt('is 422 for a malformed order number', async () => {
      const token = await signUp();
      const response = await http()
        .get('/api/v1/orders/not-an-order')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(422);
    });
  });

  describe('POST /orders/{orderNumber}/cancel', () => {
    dbIt('cancels an unpaid order and gives the stock back', async () => {
      const { token, order } = await placeOrder(3);

      const before = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock_on_hand: true, stock_reserved: true },
      });

      const response = await http()
        .post(`/api/v1/orders/${order.orderNumber}/cancel`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('cancelled');
      expect(response.body.cancellable).toBe(false);

      const after = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock_on_hand: true, stock_reserved: true },
      });
      // Reserved goes back; on_hand never moved, because nothing was ever sold.
      expect(after.stock_reserved).toBe(before.stock_reserved - 3);
      expect(after.stock_on_hand).toBe(before.stock_on_hand);

      const reservation = await prisma.stock_reservations.findFirst({
        where: { order_id: order.id },
        select: { status: true, resolved_at: true },
      });
      expect(reservation!.status).toBe('released');
      expect(reservation!.resolved_at).not.toBeNull();
    });

    dbIt('is idempotent: cancelling twice returns 200 both times', async () => {
      const { token, order } = await placeOrder();

      const first = await http()
        .post(`/api/v1/orders/${order.orderNumber}/cancel`)
        .set('Authorization', `Bearer ${token}`);
      const second = await http()
        .post(`/api/v1/orders/${order.orderNumber}/cancel`)
        .set('Authorization', `Bearer ${token}`);

      // A double-click must not look like a failure.
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.status).toBe('cancelled');
    });

    dbIt('does not release the stock twice on a repeated cancel', async () => {
      const { token, order } = await placeOrder(2);

      await http()
        .post(`/api/v1/orders/${order.orderNumber}/cancel`)
        .set('Authorization', `Bearer ${token}`);
      const afterFirst = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock_reserved: true },
      });

      await http()
        .post(`/api/v1/orders/${order.orderNumber}/cancel`)
        .set('Authorization', `Bearer ${token}`);
      const afterSecond = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock_reserved: true },
      });

      expect(afterSecond.stock_reserved).toBe(afterFirst.stock_reserved);
    });

    dbIt('is 409 for a paid order, because that would be a refund', async () => {
      const { token, order } = await placeOrder();

      await http()
        .post(`/api/v1/payments/${order.payment.id}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ cardNumber: '4242424242424242' });
      await deliverWebhook(succeededEvent(order.payment.id));

      const response = await http()
        .post(`/api/v1/orders/${order.orderNumber}/cancel`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(409);
      expect(response.body.type).toBe(
        'https://errors.example.com/order-not-cancellable',
      );
    });

    dbIt('is 403 for someone else’s order', async () => {
      const { order } = await placeOrder();
      const intruder = await signUp();

      const response = await http()
        .post(`/api/v1/orders/${order.orderNumber}/cancel`)
        .set('Authorization', `Bearer ${intruder}`);

      expect(response.status).toBe(403);
    });
  });

  describe('POST /payments/{id}/confirm', () => {
    dbIt('marks the payment processing and fulfils nothing', async () => {
      const { token, order } = await placeOrder(2);

      const before = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock_on_hand: true, stock_reserved: true },
      });

      const response = await http()
        .post(`/api/v1/payments/${order.payment.id}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ cardNumber: '4242424242424242' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('processing');

      // The heart of the design: confirming moves no stock and does not pay the
      // order. Collapsing this into the webhook's job would leave the webhook path
      // untested, and a real provider would break on the first payment.
      const after = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock_on_hand: true, stock_reserved: true },
      });
      expect(after).toEqual(before);

      const stillPending = await prisma.orders.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true, paid_at: true },
      });
      expect(stillPending.status).toBe('pending_payment');
      expect(stillPending.paid_at).toBeNull();
    });

    dbIt('is harmless to double-click', async () => {
      const { token, order } = await placeOrder();

      const first = await http()
        .post(`/api/v1/payments/${order.payment.id}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      const second = await http()
        .post(`/api/v1/payments/${order.payment.id}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.status).toBe('processing');
    });

    dbIt('is 403 for someone else’s payment', async () => {
      const { order } = await placeOrder();
      const intruder = await signUp();

      const response = await http()
        .post(`/api/v1/payments/${order.payment.id}/confirm`)
        .set('Authorization', `Bearer ${intruder}`)
        .send({});

      expect(response.status).toBe(403);
    });

    dbIt('is 409 once the order is cancelled', async () => {
      const { token, order } = await placeOrder();
      await http()
        .post(`/api/v1/orders/${order.orderNumber}/cancel`)
        .set('Authorization', `Bearer ${token}`);

      const response = await http()
        .post(`/api/v1/payments/${order.payment.id}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(409);
      expect(response.body.type).toBe(
        'https://errors.example.com/payment-not-confirmable',
      );
    });

    dbIt('is 404 for a payment that does not exist', async () => {
      const token = await signUp();
      const response = await http()
        .post(`/api/v1/payments/${randomUUID()}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(404);
    });
  });

  describe('POST /webhooks/payment', () => {
    dbIt('decrements stock and pays the order on payment.succeeded', async () => {
      const { token, order } = await placeOrder(2);
      await http()
        .post(`/api/v1/payments/${order.payment.id}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      const before = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock_on_hand: true, stock_reserved: true },
      });

      const response = await deliverWebhook(succeededEvent(order.payment.id));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, applied: true });

      const after = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock_on_hand: true, stock_reserved: true },
      });
      // Both decrease by the same amount. Only on_hand would leave the units
      // reserved forever; only reserved would give the stock back while selling it.
      expect(after.stock_on_hand).toBe(before.stock_on_hand - 2);
      expect(after.stock_reserved).toBe(before.stock_reserved - 2);

      const paid = await prisma.orders.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true, paid_at: true },
      });
      expect(paid.status).toBe('paid');
      expect(paid.paid_at).not.toBeNull();

      const reservation = await prisma.stock_reservations.findFirstOrThrow({
        where: { order_id: order.id },
        select: { status: true },
      });
      expect(reservation.status).toBe('committed');
    });

    dbIt('reports the order as paid and no longer cancellable', async () => {
      const { token, order } = await placeOrder();
      await deliverWebhook(succeededEvent(order.payment.id));

      const response = await http()
        .get(`/api/v1/orders/${order.orderNumber}`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.body.status).toBe('paid');
      expect(response.body.cancellable).toBe(false);
      expect(response.body.payment.status).toBe('succeeded');
      expect(response.body.paidAt).toBeDefined();
    });

    dbIt('decrements stock exactly once when the same event is delivered five times', async () => {
      const { order } = await placeOrder(2);
      const event = succeededEvent(order.payment.id);

      const before = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock_on_hand: true },
      });

      const responses = [];
      for (let i = 0; i < 5; i += 1) {
        responses.push(await deliverWebhook(event));
      }

      // Every delivery is acknowledged; only the first is applied. The unique index
      // on (provider, event_id) is the whole deduplication mechanism.
      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(responses.filter((r) => r.body.applied === true)).toHaveLength(1);
      expect(responses.filter((r) => r.body.applied === false)).toHaveLength(4);

      const after = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock_on_hand: true },
      });
      expect(after.stock_on_hand).toBe(before.stock_on_hand - 2);
    });

    dbIt('releases the hold and fails the order on payment.failed', async () => {
      const { order } = await placeOrder(2);

      const before = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock_on_hand: true, stock_reserved: true },
      });

      const response = await deliverWebhook({
        id: `evt_test_${randomUUID()}`,
        type: 'payment.failed',
        createdAt: new Date().toISOString(),
        data: { paymentId: order.payment.id, failureReason: 'Card declined' },
      });

      expect(response.status).toBe(200);
      expect(response.body.applied).toBe(true);

      const after = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock_on_hand: true, stock_reserved: true },
      });
      // The stock goes back untouched: nothing was sold.
      expect(after.stock_on_hand).toBe(before.stock_on_hand);
      expect(after.stock_reserved).toBe(before.stock_reserved - 2);

      const failed = await prisma.orders.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      expect(failed.status).toBe('payment_failed');

      const payment = await prisma.payments.findUniqueOrThrow({
        where: { id: order.payment.id },
        select: { status: true, failure_reason: true },
      });
      expect(payment.status).toBe('failed');
      expect(payment.failure_reason).toBe('Card declined');
    });

    dbIt('answers 200 for an unrecognised event type, applying nothing', async () => {
      const { order } = await placeOrder();

      const response = await deliverWebhook({
        id: `evt_test_${randomUUID()}`,
        type: 'payment.some_future_thing',
        createdAt: new Date().toISOString(),
        data: { paymentId: order.payment.id },
      });

      // A provider adds event types without asking. A non-2xx would make it retry
      // forever for something that will never be handled.
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, applied: false });

      const untouched = await prisma.orders.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      expect(untouched.status).toBe('pending_payment');
    });

    dbIt('answers 200 for an unknown payment id', async () => {
      const response = await deliverWebhook(succeededEvent(randomUUID()));

      expect(response.status).toBe(200);
      expect(response.body.applied).toBe(false);
    });

    dbIt('is 401 with no signature', async () => {
      const { order } = await placeOrder();
      const event = succeededEvent(order.payment.id);

      const response = await http()
        .post('/api/v1/webhooks/payment')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      // The one case that is not a 200: an unsigned request is not from the provider.
      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
    });

    dbIt('is 401 with a wrong signature, and applies nothing', async () => {
      const { order } = await placeOrder();

      const response = await deliverWebhook(succeededEvent(order.payment.id), {
        signature: 'f'.repeat(64),
      });

      expect(response.status).toBe(401);

      const untouched = await prisma.orders.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      expect(untouched.status).toBe('pending_payment');
    });

    dbIt('is 401 when the body is altered after signing', async () => {
      // The reason the signature is computed over the raw bytes. A handler that
      // re-serialised the parsed body before verifying would accept this.
      const { order } = await placeOrder();
      const signed = JSON.stringify(succeededEvent(order.payment.id));
      const tampered = signed.replace(
        '"payment.succeeded"',
        '"payment.succeeded" ',
      );

      const response = await http()
        .post('/api/v1/webhooks/payment')
        .set('Content-Type', 'application/json')
        .set(SIGNATURE_HEADER, signWebhookBody(WEBHOOK_SECRET, signed))
        .send(tampered);

      expect(response.status).toBe(401);
    });

    dbIt('needs no bearer token: it is authenticated by HMAC', async () => {
      const { order } = await placeOrder();
      const response = await deliverWebhook(succeededEvent(order.payment.id));

      expect(response.status).toBe(200);
    });

    dbIt('records the event with a processed_at once applied', async () => {
      const { order } = await placeOrder();
      const event = succeededEvent(order.payment.id);
      await deliverWebhook(event);

      const stored = await prisma.webhook_events.findFirstOrThrow({
        where: { event_id: event.id },
        select: { provider: true, event_type: true, processed_at: true },
      });
      expect(stored.provider).toBe('mock');
      expect(stored.event_type).toBe('payment.succeeded');
      expect(stored.processed_at).not.toBeNull();
    });
  });

  describe('the definition of done', () => {
    dbIt(
      'checkout, confirm, webhook: the order is paid and stock really drops',
      async () => {
        const { token, order } = await placeOrder(2);

        const atCheckout = await prisma.product_variants.findUniqueOrThrow({
          where: { id: variantId },
          select: { stock_on_hand: true, stock_reserved: true },
        });
        // Reserved, not sold.
        expect(atCheckout.stock_reserved).toBeGreaterThanOrEqual(2);

        const confirmed = await http()
          .post(`/api/v1/payments/${order.payment.id}/confirm`)
          .set('Authorization', `Bearer ${token}`)
          .send({ cardNumber: '4242424242424242' });
        expect(confirmed.body.status).toBe('processing');

        await deliverWebhook(succeededEvent(order.payment.id));

        const final = await http()
          .get(`/api/v1/orders/${order.orderNumber}`)
          .set('Authorization', `Bearer ${token}`);

        expect(final.body.status).toBe('paid');
        expect(final.body.payment.status).toBe('succeeded');

        const afterSale = await prisma.product_variants.findUniqueOrThrow({
          where: { id: variantId },
          select: { stock_on_hand: true, stock_reserved: true },
        });
        expect(afterSale.stock_on_hand).toBe(atCheckout.stock_on_hand - 2);
        expect(afterSale.stock_reserved).toBe(atCheckout.stock_reserved - 2);
      },
      60_000,
    );

    dbIt('writes order.placed then order.paid to the outbox', async () => {
      const { order } = await placeOrder();
      await deliverWebhook(succeededEvent(order.payment.id));

      const events = await prisma.outbox_events.findMany({
        where: { aggregate_id: order.id },
        orderBy: { created_at: 'asc' },
        select: { event_type: true },
      });

      expect(events.map((e) => e.event_type)).toEqual([
        'order.placed',
        'order.paid',
      ]);
    });
  });
});
