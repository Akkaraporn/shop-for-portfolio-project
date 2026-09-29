import type { INestApplication } from '@nestjs/common';
import type { Logger } from 'pino';

import { PinoLoggerService } from './common/logging/logger';
import { createRequestLoggingMiddleware } from './common/logging/request-logging.middleware';
import { ProblemExceptionFilter } from './common/problem/problem.filter';
import { createValidationPipe } from './common/problem/validation';

/** Matches the `servers` entry in contract/openapi.yaml. */
export const GLOBAL_PREFIX = 'api/v1';

/**
 * Applies every global concern to an application instance.
 *
 * Extracted from main.ts so the test suite configures its application through
 * exactly this function. A test that builds its own pipeline verifies a pipeline
 * that is not the one shipped — and the interesting failures here are precisely
 * the ones where a global filter, pipe or middleware is registered differently.
 *
 * Order matters: the request-id middleware must run before anything that might
 * fail, because the exception filter reads the id it establishes.
 */
export function configureApp(app: INestApplication, logger: Logger): void {
  app.useLogger(new PinoLoggerService(logger));

  // Adapter level, not module level, so every request gets an id — including
  // requests to paths no controller claims, whose 404 still needs a traceId.
  app.use(createRequestLoggingMiddleware(logger));

  app.setGlobalPrefix(GLOBAL_PREFIX);

  // An instance rather than a provider, so it also catches exceptions thrown
  // outside the request pipeline where an injected filter would never be reached.
  app.useGlobalFilters(new ProblemExceptionFilter(logger));
  app.useGlobalPipes(createValidationPipe());
}
