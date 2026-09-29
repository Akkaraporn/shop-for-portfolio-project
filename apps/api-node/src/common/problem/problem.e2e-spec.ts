import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { IsInt, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import pino from 'pino';
import request from 'supertest';

import { configureApp } from '../../bootstrap';
import { LoggerModule } from '../logging/logger.module';
import { ConfigModule } from '../../config/config.module';
import { ProblemException } from './problem.exception';

/**
 * The contract promises exactly one error shape. This suite is the proof, and it
 * runs against the real global filter, the real validation pipe and the real
 * request-id middleware via `configureApp` — the same function main.ts uses.
 *
 * The cases are chosen to be the ones that leak in practice: a route that does
 * not exist, a body that is not JSON, an exception from a library, and an
 * unexpected throw. Those are the paths that produce an HTML error page or a
 * stack trace if the filter is anything less than total.
 */

class LineDto {
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;
}

class OrderDto {
  @IsString()
  reference!: string;

  @ValidateNested({ each: true })
  @Type(() => LineDto)
  items!: LineDto[];
}

class PagingDto {
  // Query values arrive as strings, so the conversion is declared rather than
  // inferred. See the note in validation.ts about why implicit conversion is off.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit!: number;
}

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }

  @Get('problem')
  problem(): never {
    throw new ProblemException('insufficient-stock', {
      detail: 'Two lines are short.',
      errors: [
        {
          field: 'items[0]',
          message: 'Only 1 left',
          variantId: '01930003-0000-7000-8000-000000000001',
          requested: 3,
          available: 1,
        },
        {
          field: 'items[2]',
          message: 'Out of stock',
          variantId: '01930003-0000-7000-8000-000000000002',
          requested: 1,
          available: 0,
        },
      ],
    });
  }

  @Get('boom')
  boom(): never {
    // A secret-bearing message, to prove none of it reaches the client.
    throw new Error(
      'connect ECONNREFUSED postgres:5432 password=super-secret-value',
    );
  }

  @Get('prisma-unique')
  prismaUnique(): never {
    throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['email'] },
    });
  }

  @Get('prisma-missing')
  prismaMissing(): never {
    throw new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
      meta: {},
    });
  }

  @Get('prisma-unknown')
  prismaUnknown(): never {
    throw new Prisma.PrismaClientKnownRequestError('Something exotic', {
      code: 'P2037',
      clientVersion: 'test',
      meta: {},
    });
  }

  @Get('paging')
  paging(@Query() query: PagingDto): PagingDto {
    return query;
  }

  @Post('order')
  order(@Body() body: OrderDto): OrderDto {
    return body;
  }
}

@Module({
  imports: [ConfigModule, LoggerModule],
  controllers: [ProbeController],
})
class ProbeModule {}

describe('problem responses', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // A real environment is required by ConfigModule; these are the only values
    // this suite needs and they never leave the process.
    process.env.DATABASE_URL ??= 'postgresql://x:x@localhost:5432/x';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.JWT_SECRET ??= 'test-secret-at-least-16';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // Silent logger: this suite deliberately triggers 500s, and their stack
    // traces would otherwise bury the test output.
    configureApp(app, pino({ level: 'silent' }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const shapeOf = (body: unknown) => Object.keys(body as object).sort();

  describe('every failure is problem+json', () => {
    it('a route that does not exist', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/nope');

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.body).toMatchObject({
        type: 'https://errors.example.com/not-found',
        title: 'Resource not found',
        status: 404,
        instance: '/api/v1/nope',
      });
    });

    it('a body that is not JSON at all', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/probe/order')
        .set('Content-Type', 'application/json')
        .send('{"reference": broken');

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.body.type).toContain('https://errors.example.com/');
    });

    it('a deliberate ProblemException, with its field errors intact', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/probe/problem',
      );

      expect(response.status).toBe(409);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.body).toMatchObject({
        type: 'https://errors.example.com/insufficient-stock',
        title: 'Insufficient stock',
        status: 409,
        detail: 'Two lines are short.',
      });
      // Every short line, not just the first: a client must be able to fix the
      // whole basket in one pass.
      expect(response.body.errors).toHaveLength(2);
      expect(response.body.errors[0]).toEqual({
        field: 'items[0]',
        message: 'Only 1 left',
        variantId: '01930003-0000-7000-8000-000000000001',
        requested: 3,
        available: 1,
      });
    });

    it('an entirely unexpected throw', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/probe/boom',
      );

      expect(response.status).toBe(500);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.body).toMatchObject({
        type: 'https://errors.example.com/internal-error',
        title: 'Internal server error',
        status: 500,
      });
    });
  });

  describe('a 500 leaks nothing', () => {
    it('carries no stack, no exception message, and no secret', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/probe/boom',
      );
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('super-secret-value');
      expect(serialised).not.toContain('ECONNREFUSED');
      expect(serialised).not.toContain('postgres:5432');
      expect(serialised).not.toMatch(/\bat \w+.*\.ts:\d+/); // a stack frame
      expect(response.body.stack).toBeUndefined();
      expect(shapeOf(response.body)).toEqual(
        ['detail', 'instance', 'status', 'title', 'traceId', 'type'].sort(),
      );
    });
  });

  describe('Prisma errors get honest HTTP meanings', () => {
    it('P2002 unique violation is 409, not 500', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/probe/prisma-unique',
      );

      expect(response.status).toBe(409);
      expect(response.body.type).toBe('https://errors.example.com/conflict');
      // Naming the field is useful and reveals only what the client just sent.
      expect(response.body.detail).toContain('email');
    });

    it('P2025 missing record is 404', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/probe/prisma-missing',
      );

      expect(response.status).toBe(404);
      expect(response.body.type).toBe('https://errors.example.com/not-found');
    });

    it('an unmapped Prisma code stays a 500 rather than being guessed at', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/probe/prisma-unknown',
      );

      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain('exotic');
    });
  });

  describe('validation', () => {
    it('is 422 and reports every invalid field, not just the first', async () => {
      // `reference: 42` must fail: a JSON number is not a string. With implicit
      // conversion on it would silently become "42" and pass, while Jackson on
      // the Java side rejected it — the same request, two different statuses.
      const response = await request(app.getHttpServer())
        .post('/api/v1/probe/order')
        .send({ reference: 42, items: [{ quantity: 0 }, { quantity: 500 }] });

      expect(response.status).toBe(422);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.body.type).toBe(
        'https://errors.example.com/validation-failed',
      );

      const fields = response.body.errors.map((e: { field: string }) => e.field);
      expect(fields).toContain('reference');
      // Array indices are bracketed, exactly as the contract's examples write
      // them, so a client can map an error onto a form field.
      expect(fields).toContain('items[0].quantity');
      expect(fields).toContain('items[1].quantity');
    });

    it('ignores unknown query parameters instead of rejecting them', async () => {
      // Contract rule 6. A stray tracking parameter must not break the API.
      const response = await request(app.getHttpServer()).get(
        '/api/v1/probe/paging?limit=10&utm_source=newsletter&fbclid=xyz',
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ limit: 10 });
      expect(response.body.utm_source).toBeUndefined();
    });

    it('does not coerce a body field to satisfy its type', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/probe/order')
        .send({ reference: 42, items: [{ quantity: 1 }] });

      expect(response.status).toBe(422);
      expect(
        response.body.errors.map((e: { field: string }) => e.field),
      ).toContain('reference');
    });

    it('still rejects a known parameter that is out of range', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/probe/paging?limit=5000',
      );

      expect(response.status).toBe(422);
      expect(response.body.errors[0].field).toBe('limit');
    });
  });

  describe('traceId', () => {
    it('echoes a caller-supplied X-Request-Id and uses it as traceId', async () => {
      // The gateway sets this header, so one request keeps one id across the
      // gateway, both backends and the logs.
      const response = await request(app.getHttpServer())
        .get('/api/v1/probe/boom')
        .set('X-Request-Id', 'gateway-abc-123');

      expect(response.headers['x-request-id']).toBe('gateway-abc-123');
      expect(response.body.traceId).toBe('gateway-abc-123');
    });

    it('generates one when the caller supplies none', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/probe/boom',
      );

      expect(response.body.traceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(response.headers['x-request-id']).toBe(response.body.traceId);
    });

    it('refuses a hostile request id rather than writing it into the logs', async () => {
      // An unbounded, unvalidated header would let a caller inject newlines into
      // the log stream and corrupt every downstream parser.
      const response = await request(app.getHttpServer())
        .get('/api/v1/probe/boom')
        .set('X-Request-Id', 'bad\tid with spaces');

      expect(response.headers['x-request-id']).not.toContain(' ');
      expect(response.body.traceId).not.toContain(' ');
    });

    it('is present on a successful response too', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/probe/ok',
      );

      expect(response.status).toBe(200);
      expect(response.headers['x-request-id']).toBeDefined();
    });
  });
});
