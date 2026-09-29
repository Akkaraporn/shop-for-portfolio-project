import { LoggerService } from '@nestjs/common';
import pino, { Logger } from 'pino';

import { currentRequestId } from './request-context';

/**
 * Structured logging, JSON in every environment including development.
 *
 * No pretty-printer: the whole value of structured logs is that they are the same
 * shape wherever they are read, and a format that differs between development and
 * production is a format nobody has tested the parsing of. Pipe through
 * `pino-pretty` locally if you want colour.
 *
 * Every line carries the request id from AsyncLocalStorage, so a Problem
 * response's `traceId` leads straight to the lines that produced it without
 * anything being passed down by hand.
 */
export function createPinoLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'api-node' },
    // RFC 3339 with milliseconds, matching every timestamp the API emits. pino's
    // default is epoch millis, which is fine for machines and useless when you
    // are reading `docker compose logs` next to an HTTP response.
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-cart-token"]',
        'password',
        'refreshToken',
        'accessToken',
        '*.password',
        '*.refreshToken',
        '*.accessToken',
      ],
      censor: '[redacted]',
    },
  });
}

/**
 * Adapts pino to Nest's LoggerService so framework messages land in the same
 * stream as application messages, rather than Nest printing its own coloured
 * lines beside the JSON.
 */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  private bind(context?: unknown): Record<string, unknown> {
    const requestId = currentRequestId();
    return {
      ...(typeof context === 'string' ? { context } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }

  log(message: unknown, context?: unknown): void {
    this.logger.info(this.bind(context), String(message));
  }

  error(message: unknown, stackOrContext?: unknown, context?: unknown): void {
    this.logger.error(
      {
        ...this.bind(context ?? stackOrContext),
        ...(typeof stackOrContext === 'string' && context
          ? { stack: stackOrContext }
          : {}),
      },
      String(message),
    );
  }

  warn(message: unknown, context?: unknown): void {
    this.logger.warn(this.bind(context), String(message));
  }

  debug(message: unknown, context?: unknown): void {
    this.logger.debug(this.bind(context), String(message));
  }

  verbose(message: unknown, context?: unknown): void {
    this.logger.trace(this.bind(context), String(message));
  }
}
