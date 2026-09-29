import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { Logger } from 'pino';

import { AppModule } from './app.module';
import { configureApp, GLOBAL_PREFIX } from './bootstrap';
import { LOGGER } from './common/logging/logger.module';
import { ENV, type Env } from './config/config.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Needed by the payment webhook in task 2.6: its HMAC is computed over the
    // exact bytes received, and verifying a re-serialised body fails because key
    // order and whitespace change. Enabled here rather than later so nobody has
    // to remember to come back for it.
    rawBody: true,
    // Nest's own bootstrap logging is buffered until the pino logger replaces it
    // below, so startup messages land in the same JSON stream as everything else.
    bufferLogs: true,
  });

  const env = app.get<Env>(ENV);
  const logger = app.get<Logger>(LOGGER);

  // Exactly the configuration the test suite applies. See src/bootstrap.ts.
  configureApp(app, logger);

  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');

  logger.info(
    {
      port: env.PORT,
      prefix: GLOBAL_PREFIX,
      env: env.NODE_ENV,
      version: env.APP_VERSION,
    },
    'api-node listening',
  );
}

void bootstrap().catch((error: unknown) => {
  // The logger may not exist yet — a failed environment parse happens before it
  // is constructed — so this one place writes to stderr directly. Exiting
  // non-zero is what makes a misconfiguration visible to the orchestrator
  // instead of a container that stays up serving nothing.
  process.stderr.write(
    `fatal: failed to start\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
