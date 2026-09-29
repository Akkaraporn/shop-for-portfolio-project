import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { configureApp } from '../bootstrap';
import { CatalogModule } from '../catalog/catalog.module';
import { LOGGER, LoggerModule } from '../common/logging/logger.module';
import { ConfigModule } from '../config/config.module';
import { PrismaModule } from '../infra/prisma/prisma.module';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisModule } from '../infra/redis/redis.module';
import { AdminModule } from './admin.module';

/**
 * The back office against a real PostgreSQL: task 2.7's definition of done, plus the
 * row-lock and forward-only guarantees that only a database can prove.
 */

const DATABASE_URL =
  process.env.DATABASE_URL_HOST ??
  'postgresql://shop:shop@localhost:55432/shop?schema=public';

const RUN = Date.now().toString(36);

describe('admin (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reachable = false;
  let adminToken = '';
  let customerToken = '';
  let customerId = '';
  let categoryId = '';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.REDIS_URL ??= 'redis://localhost:56379';
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret-value';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        LoggerModule,
        PrismaModule,
        RedisModule,
        AuthModule,
        CatalogModule,
        AdminModule,
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
      console.warn(`\n  SKIPPING admin integration tests: no database at ${DATABASE_URL}.\n`);
      return;
    }

    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'admin@vibecode.shop', password: 'DemoPass123!' });
    adminToken = login.body.tokens.accessToken;

    const register = await http()
      .post('/api/v1/auth/register')
      .send({
        email: `admin-it-${RUN}@example.com`,
        password: 'DemoPass123!',
        fullName: 'ลูกค้าทดสอบ',
      });
    customerToken = register.body.tokens.accessToken;
    customerId = register.body.user.id;

    categoryId = (
      await prisma.categories.findFirstOrThrow({ where: { slug: 'clothing' } })
    ).id;
  }, 60_000);

  afterAll(async () => {
    if (reachable && prisma) {
      const products = await prisma.products.findMany({
        where: { slug: { startsWith: `it-${RUN}` } },
        select: { id: true },
      });
      const productIds = products.map((p) => p.id);
      const variants = await prisma.product_variants.findMany({
        where: { product_id: { in: productIds } },
        select: { id: true },
      });
      const variantIds = variants.map((v) => v.id);

      const orders = await prisma.orders.findMany({
        where: { user_id: customerId },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);

      await prisma.outbox_events.deleteMany({
        where: { aggregate_id: { in: [...variantIds, ...orderIds] } },
      });
      await prisma.payments.deleteMany({ where: { order_id: { in: orderIds } } });
      await prisma.orders.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.product_images.deleteMany({ where: { product_id: { in: productIds } } });
      await prisma.product_variants.deleteMany({ where: { id: { in: variantIds } } });
      await prisma.products.deleteMany({ where: { id: { in: productIds } } });
      await prisma.refresh_tokens.deleteMany({ where: { user_id: customerId } });
      await prisma.carts.deleteMany({ where: { user_id: customerId } });
      await prisma.users.deleteMany({ where: { id: customerId } });
    }
    if (app) {
      await app.close();
    }
  });

  const dbIt = (name: string, fn: () => Promise<void>): void => {
    it(name, async () => {
      if (!reachable) return;
      await fn();
    });
  };

  const http = () => request(app.getHttpServer());
  const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer ${adminToken}`);

  let seq = 0;
  const newProduct = (overrides: Record<string, unknown> = {}) => {
    seq += 1;
    return {
      slug: `it-${RUN}-${seq}`,
      name: `สินค้าทดสอบ ${seq}`,
      description: 'สร้างโดย integration test',
      categoryId,
      status: 'active',
      variants: [
        { sku: `IT-${RUN}-${seq}-A`, name: 'เล็ก', priceCents: 45000, stockOnHand: 5 },
        { sku: `IT-${RUN}-${seq}-B`, name: 'ใหญ่', priceCents: 39000, stockOnHand: 3 },
      ],
      ...overrides,
    };
  };

  /** An order already paid for, as the webhook would leave it. */
  const paidOrder = async (): Promise<string> => {
    seq += 1;
    const orderNumber = `ORD-2099-${String(Date.now() % 10_000_000).padStart(7, '0')}`;
    const order = await prisma.orders.create({
      data: {
        order_number: orderNumber,
        user_id: customerId,
        status: 'paid',
        subtotal_cents: 10000n,
        shipping_cents: 5000n,
        total_cents: 15000n,
        shipping_address: {
          recipientName: 'สมชาย ใจดี',
          phone: '0812345678',
          line1: '1 ถนนสุขุมวิท',
          city: 'คลองเตย',
          province: 'กรุงเทพมหานคร',
          postalCode: '10110',
          country: 'TH',
        },
        paid_at: new Date(),
      },
    });
    await prisma.payments.create({
      data: { order_id: order.id, status: 'succeeded', method: 'card', amount_cents: 15000n },
    });
    // Order numbers are unique; make the next one differ even within a millisecond.
    await new Promise((resolve) => setTimeout(resolve, 2));
    return orderNumber;
  };

  describe('who may call it', () => {
    dbIt('a customer token is 403, not 404', async () => {
      const response = await http()
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(response.status).toBe(403);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    dbIt('no token is 401', async () => {
      expect((await http().post('/api/v1/admin/products').send(newProduct())).status).toBe(401);
    });
  });

  describe('products', () => {
    dbIt('a created product is in the catalogue at once, cheapest variant first', async () => {
      const body = newProduct();
      const created = await asAdmin(http().post('/api/v1/admin/products')).send(body);
      expect(created.status).toBe(201);
      expect(created.body.minPriceCents).toBe(39000);
      expect(created.body.variants[0]).toMatchObject({ stockOnHand: 3, stockReserved: 0 });

      const page = await http().get(`/api/v1/products/${body.slug}`);
      expect(page.status).toBe(200);
      expect(page.body.variants.map((v: { sku: string }) => v.sku)).toEqual([
        body.variants[1].sku,
        body.variants[0].sku,
      ]);
      // The customer view never shows raw stock.
      expect(page.body.variants[0].stockOnHand).toBeUndefined();
    });

    dbIt('a draft is hidden from the catalogue but listed for the admin', async () => {
      const body = newProduct({ status: 'draft' });
      await asAdmin(http().post('/api/v1/admin/products')).send(body);

      expect((await http().get(`/api/v1/products/${body.slug}`)).status).toBe(404);

      const list = await asAdmin(http().get('/api/v1/admin/products?status=draft'));
      expect(list.status).toBe(200);
      expect(list.body.items.map((p: { slug: string }) => p.slug)).toContain(body.slug);
    });

    dbIt('a duplicate slug is 409, never 500', async () => {
      const body = newProduct();
      await asAdmin(http().post('/api/v1/admin/products')).send(body);
      const again = await asAdmin(http().post('/api/v1/admin/products')).send({
        ...newProduct(),
        slug: body.slug,
      });
      expect(again.status).toBe(409);
    });

    dbIt('the same SKU twice in one request is a 422 naming the line', async () => {
      const body = newProduct();
      body.variants[1].sku = body.variants[0].sku;
      const response = await asAdmin(http().post('/api/v1/admin/products')).send(body);
      expect(response.status).toBe(422);
      expect(response.body.errors[0].field).toBe('variants[1].sku');
    });

    dbIt('archiving hides a product without deleting it', async () => {
      const body = newProduct();
      const created = await asAdmin(http().post('/api/v1/admin/products')).send(body);

      const archived = await asAdmin(
        http().patch(`/api/v1/admin/products/${created.body.id}`),
      ).send({ status: 'archived' });
      expect(archived.status).toBe(200);
      expect(archived.body.status).toBe('archived');
      expect(archived.body.name).toBe(body.name); // omitted fields untouched

      expect((await http().get(`/api/v1/products/${body.slug}`)).status).toBe(404);
      expect(await prisma.products.count({ where: { id: created.body.id } })).toBe(1);
    });
  });

  describe('stock', () => {
    const variantOf = async () => {
      const created = await asAdmin(http().post('/api/v1/admin/products')).send(newProduct());
      return created.body.variants[0].id as string;
    };

    dbIt('delta: -999 is 409', async () => {
      const variantId = await variantOf();
      const response = await asAdmin(
        http().patch(`/api/v1/admin/variants/${variantId}/stock`),
      ).send({ delta: -999, reason: 'test' });
      expect(response.status).toBe(409);
      expect(response.body.errors[0].field).toBe('delta');
    });

    dbIt('refuses to dip below reserved stock', async () => {
      const variantId = await variantOf();
      await prisma.product_variants.update({
        where: { id: variantId },
        data: { stock_reserved: 2 },
      });
      // 3 on hand, 2 reserved: -1 lands, -2 would promise a unit that is not there.
      const ok = await asAdmin(http().patch(`/api/v1/admin/variants/${variantId}/stock`)).send({
        delta: -1,
        reason: 'damaged',
      });
      expect(ok.body).toMatchObject({ stockOnHand: 2, stockReserved: 2, availableStock: 0 });
      const refused = await asAdmin(
        http().patch(`/api/v1/admin/variants/${variantId}/stock`),
      ).send({ delta: -1, reason: 'damaged' });
      expect(refused.status).toBe(409);
      await prisma.product_variants.update({
        where: { id: variantId },
        data: { stock_reserved: 0 },
      });
    });

    dbIt('ten concurrent +10s all land', async () => {
      const variantId = await variantOf();
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          asAdmin(http().patch(`/api/v1/admin/variants/${variantId}/stock`)).send({
            delta: 10,
            reason: 'restock',
          }),
        ),
      );
      expect(responses.every((r) => r.status === 200)).toBe(true);
      const variant = await prisma.product_variants.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(variant.stock_on_hand).toBe(3 + 100);
    });

    dbIt('an absolute value is not accepted', async () => {
      const variantId = await variantOf();
      const response = await asAdmin(
        http().patch(`/api/v1/admin/variants/${variantId}/stock`),
      ).send({ stockOnHand: 50, reason: 'set' });
      expect(response.status).toBe(422);
    });
  });

  describe('order status', () => {
    const advance = (orderNumber: string, status: string) =>
      asAdmin(http().patch(`/api/v1/admin/orders/${orderNumber}/status`)).send({ status });

    dbIt('walks paid → fulfilled → completed', async () => {
      const orderNumber = await paidOrder();
      expect((await advance(orderNumber, 'fulfilled')).body.status).toBe('fulfilled');
      expect((await advance(orderNumber, 'completed')).body.status).toBe('completed');
    });

    dbIt('a skipped step is 409 and names where it can go', async () => {
      const orderNumber = await paidOrder();
      const response = await advance(orderNumber, 'completed');
      expect(response.status).toBe(409);
      expect(response.body.type).toMatch(/invalid-transition$/);
      expect(response.body.errors).toEqual([{ field: 'status', message: 'fulfilled' }]);
    });

    dbIt('two admins pressing the same button: one wins, one is told the new state', async () => {
      const orderNumber = await paidOrder();
      const [a, b] = await Promise.all([
        advance(orderNumber, 'fulfilled'),
        advance(orderNumber, 'fulfilled'),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.errors).toEqual([{ field: 'status', message: 'completed' }]);
    });

    dbIt('lists every customer, filtered by status and user', async () => {
      const orderNumber = await paidOrder();
      const response = await asAdmin(
        http().get(`/api/v1/admin/orders?status=paid&userId=${customerId}`),
      );
      expect(response.status).toBe(200);
      expect(response.body.items.map((o: { orderNumber: string }) => o.orderNumber)).toContain(
        orderNumber,
      );
      expect(response.body.items.every((o: { status: string }) => o.status === 'paid')).toBe(
        true,
      );
    });
  });
});
