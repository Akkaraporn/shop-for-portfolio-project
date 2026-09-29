import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import request from 'supertest';

import { configureApp } from '../bootstrap';
import { LoggerModule } from '../common/logging/logger.module';
import { ConfigModule } from '../config/config.module';
import { PrismaModule } from '../infra/prisma/prisma.module';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisModule } from '../infra/redis/redis.module';
import { RedisService } from '../infra/redis/redis.service';
import { HealthModule } from './health.module';

/**
 * The probes, verified against the contract's `Health` and `Readiness` schemas.
 *
 * Prisma and Redis are substituted so that each dependency state can be produced
 * on demand. The interesting cases are not the happy path: they are Redis down
 * (which must NOT fail readiness) and Postgres down (which must), and neither is
 * reproducible against real infrastructure without breaking it on purpose.
 */
describe('health and readiness', () => {
  let app: INestApplication;
  let databaseUp = true;
  let cacheUp = true;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgresql://x:x@localhost:5432/x';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.JWT_SECRET ??= 'test-secret-at-least-16';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret';
    process.env.APP_VERSION = '1.2.3';

    const moduleRef = await Test.createTestingModule({
      // The infra modules are imported so their tokens exist in the graph for
      // the overrides below to replace. The real services are never constructed:
      // overrideProvider substitutes them before instantiation, which is what
      // lets this suite run with no database and no Redis.
      imports: [
        ConfigModule,
        LoggerModule,
        PrismaModule,
        RedisModule,
        HealthModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({ isReachable: async () => databaseUp })
      .overrideProvider(RedisService)
      .useValue({ ping: async () => cacheUp })
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app, pino({ level: 'silent' }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.APP_VERSION;
  });

  beforeEach(() => {
    databaseUp = true;
    cacheUp = true;
  });

  describe('GET /health', () => {
    it('matches the contract and names the implementation', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');

      expect(response.status).toBe(200);
      // Exactly the required fields, nothing extra: the two implementations must
      // return the same shape, and an extra field here is a parity failure there.
      expect(response.body).toEqual({
        status: 'ok',
        implementation: 'nestjs',
        version: '1.2.3',
      });
    });

    it('stays ok when every dependency is down', async () => {
      // Liveness must not depend on anything. An orchestrator restarts the
      // container on this probe, and restarting the API because the database
      // blinked turns one outage into two.
      databaseUp = false;
      cacheUp = false;

      const response = await request(app.getHttpServer()).get('/api/v1/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
    });
  });

  describe('GET /ready', () => {
    it('reports ok when both dependencies answer', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/ready');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        implementation: 'nestjs',
        checks: { database: 'ok', cache: 'ok' },
      });
    });

    it('is degraded but still ready when the cache is down', async () => {
      // The project rule: losing Redis makes the system slower, never wrong.
      // Gating readiness on it would let a cache blip take down a shop that can
      // serve every request from Postgres.
      cacheUp = false;

      const response = await request(app.getHttpServer()).get('/api/v1/ready');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'degraded',
        implementation: 'nestjs',
        checks: { database: 'ok', cache: 'down' },
      });
    });

    it('is 503 problem+json when the database is down', async () => {
      databaseUp = false;

      const response = await request(app.getHttpServer()).get('/api/v1/ready');

      expect(response.status).toBe(503);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.body).toMatchObject({
        type: 'https://errors.example.com/service-unavailable',
        title: 'Service unavailable',
        status: 503,
      });
      expect(response.body.traceId).toBeDefined();
    });

    it('fails on the database even when the cache is fine', async () => {
      databaseUp = false;
      cacheUp = true;

      const response = await request(app.getHttpServer()).get('/api/v1/ready');

      expect(response.status).toBe(503);
    });
  });
});
