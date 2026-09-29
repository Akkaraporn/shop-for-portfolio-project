import { Global, Module } from '@nestjs/common';
import type { Logger } from 'pino';

import { ENV, type Env } from '../../config/config.module';
import { createPinoLogger } from './logger';

/** Injection token for the root pino logger. */
export const LOGGER = Symbol('LOGGER');

@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: Env): Logger => createPinoLogger(env.LOG_LEVEL),
    },
  ],
  exports: [LOGGER],
})
export class LoggerModule {}
