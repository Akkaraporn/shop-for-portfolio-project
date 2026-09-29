import { createHash } from 'node:crypto';

import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import request from 'supertest';

import { AuthModule } from './auth.module';
import { CurrentUser } from './decorators/current-user.decorator';
import { OptionalAuth, Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { FakePrisma } from './testing/fake-prisma';
import type { AuthenticatedUser } from './auth.types';
import { configureApp } from '../bootstrap';
import { LOGGER, LoggerModule } from '../common/logging/logger.module';
import { ConfigModule } from '../config/config.module';
import { PrismaModule } from '../infra/prisma/prisma.module';
import { PrismaService } from '../infra/prisma/prisma.service';

/**
 * The auth flow, end to end over HTTP, with persistence substituted by FakePrisma.
 *
 * What this proves: the register/login/me/refresh/logout contract, the timing
 * defence on login, rotation with reuse detection revoking a whole family, and the
 * global guards' default-deny behaviour.
 *
 * What it cannot prove, because the double does not model row locking: the
 * concurrent-refresh case, where `FOR UPDATE` is what forces the second request to
 * be classified as reuse. That needs a real Postgres.
 */

/** Endpoints that exist only to observe what the global guards do. */
@Controller('probe-auth')
class GuardProbeController {
  @Get('protected')
  protectedRoute(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  @Get('public')
  @Public()
  publicRoute(): { seen: string } {
    return { seen: 'public' };
  }

  @Get('optional')
  @OptionalAuth()
  optionalRoute(@CurrentUser() user?: AuthenticatedUser): { userId: string | null } {
    return { userId: user?.id ?? null };
  }

  @Get('admin-only')
  @Roles('admin')
  adminRoute(): { seen: string } {
    return { seen: 'admin' };
  }
}

const REGISTRATION = {
  email: 'Somchai@Example.com',
  password: 'DemoPass123!',
  fullName: 'สมชาย ใจดี',
};

describe('auth', () => {
  let app: INestApplication;
  let db: FakePrisma;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgresql://x:x@localhost:5432/x';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret';
    process.env.ACCESS_TOKEN_TTL_SECONDS = '900';

    db = new FakePrisma();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, LoggerModule, PrismaModule, AuthModule],
      controllers: [GuardProbeController],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(db)
      // Services log through the injected logger, not the one configureApp is
      // given, and this suite deliberately triggers the reuse-detection warning.
      .overrideProvider(LOGGER)
      .useValue(pino({ level: 'silent' }))
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app, pino({ level: 'silent' }));
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    db.reset();
  });

  const http = () => request(app.getHttpServer());

  const registerFresh = async (overrides: Partial<typeof REGISTRATION> = {}) => {
    const response = await http()
      .post('/api/v1/auth/register')
      .send({ ...REGISTRATION, ...overrides });
    expect(response.status).toBe(201);
    return response.body;
  };

  describe('POST /auth/register', () => {
    it('creates the account and signs it in, in one call', async () => {
      const response = await http()
        .post('/api/v1/auth/register')
        .send(REGISTRATION);

      expect(response.status).toBe(201);
      expect(response.body.user).toMatchObject({
        // Normalised: the contract compares addresses case-insensitively, and the
        // unique index is on lower(email), so the stored form has to agree with it.
        email: 'somchai@example.com',
        fullName: 'สมชาย ใจดี',
        role: 'customer',
      });
      expect(response.body.user.id).toMatch(/^[0-9a-f-]{36}$/);
      // RFC 3339 UTC with exactly three fractional digits.
      expect(response.body.user.createdAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    it('never returns the password hash', async () => {
      const response = await http()
        .post('/api/v1/auth/register')
        .send(REGISTRATION);

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain('argon2');
      expect(serialised).not.toContain(REGISTRATION.password);
      expect(response.body.user.password_hash).toBeUndefined();
      expect(response.body.user.passwordHash).toBeUndefined();
    });

    it('stores an argon2id hash, not the password', async () => {
      await registerFresh();

      const stored = db.userRows[0].password_hash;
      expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(stored).not.toContain(REGISTRATION.password);
    });

    it('issues a token pair whose expiresIn is seconds', async () => {
      const body = await registerFresh();

      expect(body.tokens.tokenType).toBe('Bearer');
      // 900, not 900000 and not an absolute timestamp. The Java side must send the
      // same unit or every client's refresh timer is wrong by a factor of 1000.
      expect(body.tokens.expiresIn).toBe(900);
      expect(body.tokens.accessToken.split('.')).toHaveLength(3);
      expect(body.tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('stores only a hash of the refresh token', async () => {
      const body = await registerFresh();

      expect(db.tokenRows).toHaveLength(1);
      expect(db.tokenRows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(db.tokenRows[0].token_hash).not.toBe(body.tokens.refreshToken);
    });

    it('rejects a duplicate email with 409, case-insensitively', async () => {
      await registerFresh();

      const response = await http()
        .post('/api/v1/auth/register')
        // Different case, same account.
        .send({ ...REGISTRATION, email: 'SOMCHAI@example.com' });

      expect(response.status).toBe(409);
      expect(response.body.type).toBe(
        'https://errors.example.com/email-already-registered',
      );
      expect(response.body.errors[0].field).toBe('email');
    });

    it('rejects a short password with 422 and names the field', async () => {
      const response = await http()
        .post('/api/v1/auth/register')
        .send({ ...REGISTRATION, password: 'short' });

      expect(response.status).toBe(422);
      expect(
        response.body.errors.map((e: { field: string }) => e.field),
      ).toContain('password');
    });
  });

  describe('POST /auth/login', () => {
    it('signs in with the right password', async () => {
      await registerFresh();

      const response = await http()
        .post('/api/v1/auth/login')
        .send({ email: REGISTRATION.email, password: REGISTRATION.password });

      expect(response.status).toBe(200);
      expect(response.body.user.email).toBe('somchai@example.com');
      expect(response.body.tokens.accessToken).toBeDefined();
    });

    it('gives a byte-identical response for a wrong password and an unknown email', async () => {
      await registerFresh();

      const wrongPassword = await http()
        .post('/api/v1/auth/login')
        .send({ email: REGISTRATION.email, password: 'WrongPass123!' });

      const unknownEmail = await http()
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.com', password: 'WrongPass123!' });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);

      // Equal timing with distinguishable bodies would defend nothing, so the
      // bodies must match on everything except the per-request traceId.
      const strip = (body: Record<string, unknown>) => {
        const { traceId, ...rest } = body;
        return rest;
      };
      expect(strip(unknownEmail.body)).toEqual(strip(wrongPassword.body));
      expect(wrongPassword.body.type).toBe(
        'https://errors.example.com/invalid-credentials',
      );
    });

    it('spends comparable time on an unknown email as on a wrong password', async () => {
      await registerFresh();

      const time = async (payload: object): Promise<number> => {
        const started = process.hrtime.bigint();
        await http().post('/api/v1/auth/login').send(payload);
        return Number(process.hrtime.bigint() - started) / 1_000_000;
      };

      const wrongPassword = await time({
        email: REGISTRATION.email,
        password: 'WrongPass123!',
      });
      const unknownEmail = await time({
        email: 'nobody@example.com',
        password: 'WrongPass123!',
      });

      // The real assertion is that the unknown-email path is not effectively free:
      // returning early would answer in well under a millisecond while a real
      // verification costs tens of them. Bounds are loose on purpose — this runs on
      // shared CI — but an early return fails it by two orders of magnitude.
      expect(unknownEmail).toBeGreaterThan(5);
      expect(wrongPassword).toBeGreaterThan(5);
    }, 30_000);
  });

  describe('GET /auth/me', () => {
    it('returns the account behind the access token', async () => {
      const session = await registerFresh();

      const response = await http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${session.tokens.accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(session.user);
    });

    it('is 401 without a token', async () => {
      const response = await http().get('/api/v1/auth/me');

      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.body.type).toBe('https://errors.example.com/unauthorized');
    });

    it.each([
      ['a malformed token', 'Bearer not.a.jwt'],
      ['a token signed with the wrong key', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4Iiwicm9sZSI6ImFkbWluIn0.wrongsignature'],
      ['the wrong scheme', 'Basic abcdef'],
      ['a bare token with no scheme', 'abcdef'],
    ])('is 401 for %s', async (_name, header) => {
      const response = await http()
        .get('/api/v1/auth/me')
        .set('Authorization', header);

      expect(response.status).toBe(401);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the token and returns a different one', async () => {
      const session = await registerFresh();

      const response = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.tokens.refreshToken });

      expect(response.status).toBe(200);
      expect(response.body.refreshToken).not.toBe(session.tokens.refreshToken);
      expect(response.body.expiresIn).toBe(900);
      expect(response.body.tokenType).toBe('Bearer');
    });

    it('records what replaced the consumed token, so the chain can be walked', async () => {
      const session = await registerFresh();
      const originalId = db.tokenRows[0].id;

      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.tokens.refreshToken });

      const original = db.tokenRows.find((t) => t.id === originalId)!;
      expect(original.revoked_at).not.toBeNull();
      expect(original.replaced_by).toBe(db.tokenRows[1].id);
      // Same family: revoking one compromised session must not sign the user out
      // of their other devices.
      expect(db.tokenRows[1].family_id).toBe(original.family_id);
    });

    it('keeps the new token working after a rotation', async () => {
      const session = await registerFresh();

      const first = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.tokens.refreshToken });

      const second = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: first.body.refreshToken });

      expect(second.status).toBe(200);
      expect(second.body.refreshToken).not.toBe(first.body.refreshToken);
    });

    it('revokes the whole family when a consumed token is presented again', async () => {
      // The headline behaviour of this task. A -> B -> C, then replay A.
      const session = await registerFresh();
      const tokenA = session.tokens.refreshToken;

      const b = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokenA });
      const c = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: b.body.refreshToken });

      expect(c.status).toBe(200);
      expect(db.tokenRows.filter((t) => t.revoked_at === null)).toHaveLength(1);

      const replay = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokenA });

      expect(replay.status).toBe(401);
      expect(replay.body.type).toBe(
        'https://errors.example.com/token-reuse-detected',
      );

      // Every token in the family is dead, including the one the legitimate user
      // was holding. Signing the victim out is correct: the alternative leaves an
      // attacker with a working session.
      expect(db.tokenRows.every((t) => t.revoked_at !== null)).toBe(true);

      const afterwards = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: c.body.refreshToken });
      expect(afterwards.status).toBe(401);
    });

    it('is 401 for a token that was never issued', async () => {
      const response = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'a'.repeat(43) });

      expect(response.status).toBe(401);
      expect(response.body.type).toBe('https://errors.example.com/unauthorized');
    });

    it('is 401 for an expired token, and consumes it', async () => {
      const session = await registerFresh();
      db.tokenRows[0].expires_at = new Date(Date.now() - 1000);

      const response = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.tokens.refreshToken });

      expect(response.status).toBe(401);
      expect(db.tokenRows[0].revoked_at).not.toBeNull();
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the family and returns 204', async () => {
      const session = await registerFresh();

      const response = await http()
        .post('/api/v1/auth/logout')
        .send({ refreshToken: session.tokens.refreshToken });

      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
      expect(db.tokenRows.every((t) => t.revoked_at !== null)).toBe(true);
    });

    it('is 204 when called twice', async () => {
      const session = await registerFresh();
      const payload = { refreshToken: session.tokens.refreshToken };

      await http().post('/api/v1/auth/logout').send(payload);
      const second = await http().post('/api/v1/auth/logout').send(payload);

      expect(second.status).toBe(204);
    });

    it('is 204 with no token at all', async () => {
      // A client retrying after a dropped connection must not be told off for
      // successfully having no session.
      const response = await http().post('/api/v1/auth/logout').send({});

      expect(response.status).toBe(204);
    });

    it('is 204 for a token that was never issued, revealing nothing', async () => {
      const response = await http()
        .post('/api/v1/auth/logout')
        .send({ refreshToken: 'z'.repeat(43) });

      expect(response.status).toBe(204);
    });

    it('revokes every session for the user when only a bearer is supplied', async () => {
      const session = await registerFresh();
      // A second sign-in, so there are two live families.
      await http()
        .post('/api/v1/auth/login')
        .send({ email: REGISTRATION.email, password: REGISTRATION.password });

      expect(db.tokenRows.filter((t) => t.revoked_at === null)).toHaveLength(2);

      const response = await http()
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${session.tokens.accessToken}`)
        .send({});

      expect(response.status).toBe(204);
      expect(db.tokenRows.every((t) => t.revoked_at !== null)).toBe(true);
    });
  });

  describe('the global guards', () => {
    it('protect an endpoint that says nothing, so a forgotten annotation fails closed', async () => {
      const response = await http().get('/api/v1/probe-auth/protected');
      expect(response.status).toBe(401);
    });

    it('allow a @Public endpoint with no token', async () => {
      const response = await http().get('/api/v1/probe-auth/public');
      expect(response.status).toBe(200);
    });

    it('allow an @OptionalAuth endpoint with no token, and report no user', async () => {
      const response = await http().get('/api/v1/probe-auth/optional');
      expect(response.status).toBe(200);
      expect(response.body.userId).toBeNull();
    });

    it('attach the user on @OptionalAuth when a valid token is present', async () => {
      const session = await registerFresh();

      const response = await http()
        .get('/api/v1/probe-auth/optional')
        .set('Authorization', `Bearer ${session.tokens.accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.userId).toBe(session.user.id);
    });

    it('treat an invalid token on @OptionalAuth as no token rather than an error', async () => {
      // A guest whose access token expired overnight should get a working basket,
      // not a 401 they cannot act on.
      const response = await http()
        .get('/api/v1/probe-auth/optional')
        .set('Authorization', 'Bearer nonsense.token.here');

      expect(response.status).toBe(200);
      expect(response.body.userId).toBeNull();
    });

    it('return 403, not 404, when a customer calls an admin endpoint', async () => {
      const session = await registerFresh();

      const response = await http()
        .get('/api/v1/probe-auth/admin-only')
        .set('Authorization', `Bearer ${session.tokens.accessToken}`);

      expect(response.status).toBe(403);
      expect(response.body.type).toBe('https://errors.example.com/forbidden');
    });

    it('return 401, not 403, when an admin endpoint is called with no token', async () => {
      const response = await http().get('/api/v1/probe-auth/admin-only');
      expect(response.status).toBe(401);
    });

    it('admit an admin to an admin endpoint', async () => {
      await registerFresh();
      db.userRows[0].role = 'admin';

      const session = await http()
        .post('/api/v1/auth/login')
        .send({ email: REGISTRATION.email, password: REGISTRATION.password });

      const response = await http()
        .get('/api/v1/probe-auth/admin-only')
        .set('Authorization', `Bearer ${session.body.tokens.accessToken}`);

      expect(response.status).toBe(200);
    });
  });

  describe('guest cart claiming', () => {
    it('claims a guest basket at register, clearing the guest ownership', async () => {
      const cart = db.seedCart({ token_hash: hashOf('guest-token-abc') });

      const session = await http()
        .post('/api/v1/auth/register')
        .set('X-Cart-Token', 'guest-token-abc')
        .send(REGISTRATION);

      expect(session.status).toBe(201);
      const claimed = db.cartRows.find((c) => c.id === cart.id)!;
      // All three move together, or the carts_single_owner_check constraint rejects
      // the row: a basket belongs to a user or to a guest token, never both.
      expect(claimed.user_id).toBe(session.body.user.id);
      expect(claimed.token_hash).toBeNull();
      expect(claimed.expires_at).toBeNull();
    });

    it('registers successfully when the cart token is unknown', async () => {
      const response = await http()
        .post('/api/v1/auth/register')
        .set('X-Cart-Token', 'never-existed')
        .send(REGISTRATION);

      expect(response.status).toBe(201);
    });

    it('leaves the guest basket alone when the account already has one', async () => {
      // This is the merge case, which belongs to POST /carts/me/merge in task 2.4.
      // Claiming here would need the same summing logic in two places.
      const session = await registerFresh();
      db.seedCart({ user_id: session.user.id });
      const guest = db.seedCart({ token_hash: hashOf('guest-token-xyz') });

      const login = await http()
        .post('/api/v1/auth/login')
        .set('X-Cart-Token', 'guest-token-xyz')
        .send({ email: REGISTRATION.email, password: REGISTRATION.password });

      expect(login.status).toBe(200);
      const untouched = db.cartRows.find((c) => c.id === guest.id)!;
      expect(untouched.user_id).toBeNull();
      expect(untouched.token_hash).not.toBeNull();
    });
  });
});

/** Mirrors hashToken in token.service.ts: only the hash is ever stored. */
function hashOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
