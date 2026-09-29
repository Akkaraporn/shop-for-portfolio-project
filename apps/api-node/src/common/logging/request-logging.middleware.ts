import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';

import { runWithRequestContext } from './request-context';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Establishes the request id and logs one line per completed request.
 *
 * A plain Express middleware rather than a Nest `NestMiddleware`, and applied
 * with `app.use` in `configureApp`. That is deliberate: middleware registered
 * through a module's `configure()` only covers that module's route table, so a
 * request to a path no controller claims would get no request id — and its 404
 * Problem response would have no `traceId`, which is the one case where a caller
 * most needs something to quote. Registering at the adapter level makes the id
 * unconditional, and keeps it inside the single `configureApp` function the test
 * suite and main.ts share.
 *
 * The id is taken from `X-Request-Id` when the caller supplied a usable one — the
 * nginx gateway sets it — so a single request keeps one identifier across the
 * gateway, both backends, and the logs.
 */
export function createRequestLoggingMiddleware(logger: Logger): RequestHandler {
  return function requestLogging(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId = isUsableRequestId(incoming) ? incoming : randomUUID();

    res.setHeader('X-Request-Id', requestId);

    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      // 5xx is ours, 4xx is usually the caller's. Logging both at the same level
      // buries the ones worth waking up for in the ones that are not.
      const level =
        res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

      logger[level](
        {
          requestId,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          ip: req.ip,
        },
        `${req.method} ${req.originalUrl} ${res.statusCode}`,
      );
    });

    runWithRequestContext({ requestId }, () => next());
  };
}

/**
 * A caller-supplied id is echoed back and written into every log line, so it is
 * not accepted unconditionally: an unbounded header would let anyone write
 * arbitrary content into the log stream, and a newline there corrupts the parser
 * of every downstream log consumer.
 */
function isUsableRequestId(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\w.:-]+$/.test(value)
  );
}
