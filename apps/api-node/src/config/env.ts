import { z } from 'zod';

/**
 * Environment validation.
 *
 * Validated once, at startup, before anything else is constructed. A missing or
 * malformed variable should stop the process immediately with a message naming
 * the variable — not surface as `undefined` three layers deep on the first
 * request that happens to need it.
 *
 * Defaults mirror `.env.example`. Secrets have no defaults on purpose: a
 * development JWT secret that silently works in production is worse than a
 * refusal to boot.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  APP_VERSION: z.string().min(1).default('1.0.0'),

  DATABASE_URL: z.string().min(1),
  // Prisma's default pool is cpu*2+1, which can exhaust Postgres's
  // max_connections when both backends run at once in development. Pinned to
  // match HikariCP's default so the two sides behave the same.
  DB_POOL_SIZE: z.coerce.number().int().positive().max(100).default(10),

  REDIS_URL: z.string().min(1),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  PAYMENT_WEBHOOK_SECRET: z.string().min(8),
  PAYMENT_MOCK_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
  /**
   * Where the mock provider posts its callbacks. It makes a real HTTP request back
   * to this service, so the webhook goes through the same signature check, parser and
   * deduplication an external provider would hit — calling the handler in-process
   * would exercise none of those.
   */
  SELF_BASE_URL: z.string().min(1).default('http://127.0.0.1:3000'),

  // One currency, deliberately (ADR-002 and the contract's preamble). A literal
  // rather than a string, so setting it to anything else fails at boot instead
  // of producing prices nobody can interpret.
  CURRENCY: z.literal('THB').default('THB'),
  SHIPPING_FLAT_CENTS: z.coerce.number().int().nonnegative().default(5000),
  RESERVATION_TTL_MINUTES: z.coerce.number().int().positive().default(15),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and returns the environment, or throws with every problem listed at
 * once. Reporting one variable at a time turns a misconfigured deployment into
 * several restarts.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${problems}`);
  }

  return result.data;
}
