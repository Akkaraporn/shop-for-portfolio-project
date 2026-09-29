import { Global, Module } from '@nestjs/common';

import { loadEnv, type Env } from './env';

export type { Env } from './env';

/** Injection token for the validated environment. */
export const ENV = Symbol('ENV');

/**
 * Global, because almost everything needs some part of the configuration and
 * threading a module import for it through every feature module adds noise
 * without adding clarity.
 *
 * The environment is parsed once here. Nothing else in the codebase reads
 * `process.env` — if it did, an unvalidated variable could re-enter through the
 * back door and the schema in env.ts would stop being the whole truth.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
