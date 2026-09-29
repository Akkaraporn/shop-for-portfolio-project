import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';

import { currentRequestId } from '../logging/request-context';
import {
  FieldError,
  ProblemBody,
  ProblemException,
} from './problem.exception';
import {
  PROBLEM_TYPES,
  ProblemSlug,
  problemTypeUri,
  slugForStatus,
} from './problem-types';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * Converts every failure into RFC 9457 `application/problem+json`.
 *
 * Registered with `@Catch()` and no argument, so it catches everything: our own
 * exceptions, Nest's (a 404 for an unmatched route, a 400 for a malformed JSON
 * body), Prisma's, and anything thrown by a dependency that nobody anticipated.
 * That totality is the point — the contract promises exactly one error shape, and
 * a single HTML error page escaping would break every client's error handling.
 *
 * A 5xx never carries a stack trace, an exception message, or a Prisma error
 * detail. Those go to the log, correlated by `traceId`. An unexpected internal
 * error's message frequently contains a query, a column list, or a connection
 * string, and none of that belongs in a response body.
 */
@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const { slug, detail, errors, status } = this.classify(exception);

    // Only 5xx is unexpected, so only 5xx gets the full diagnostic treatment.
    // A 404 logged with a stack trace trains everyone to ignore stack traces.
    if (status >= 500) {
      this.logger.error(
        {
          requestId: currentRequestId(),
          method: request.method,
          path: request.originalUrl,
          err: serialiseError(exception),
        },
        'unhandled exception',
      );
    }

    const body: ProblemBody = {
      type: problemTypeUri(slug),
      title: PROBLEM_TYPES[slug].title,
      status,
      ...(detail ? { detail } : {}),
      instance: request.originalUrl,
      ...(currentRequestId() ? { traceId: currentRequestId() } : {}),
      ...(errors && errors.length > 0 ? { errors } : {}),
    };

    // If headers already went out — a streamed response that failed midway —
    // there is nothing to replace, and writing again would throw inside the
    // filter and lose the log line above.
    if (response.headersSent) {
      response.end();
      return;
    }

    response.status(status).type(PROBLEM_CONTENT_TYPE).send(body);
  }

  private classify(exception: unknown): {
    slug: ProblemSlug;
    status: number;
    detail?: string;
    errors?: FieldError[];
  } {
    // Ours: already carries everything.
    if (exception instanceof ProblemException) {
      return {
        slug: exception.slug,
        status: exception.getStatus(),
        detail: exception.detail,
        errors: exception.errors,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.classifyPrisma(exception);
    }

    // A connection that cannot be established is not a bug in the request.
    if (exception instanceof Prisma.PrismaClientInitializationError) {
      return {
        slug: 'service-unavailable',
        status: 503,
        detail: 'The database is not reachable.',
      };
    }

    // Nest's own exceptions, and anything else extending HttpException.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        slug: slugForStatus(status),
        status,
        // Nest's default messages are safe and often useful ("Cannot GET /x").
        // Anything 5xx is suppressed below rather than echoed.
        ...(status < 500 ? extractHttpDetail(exception) : {}),
      };
    }

    return {
      slug: 'internal-error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'An unexpected error occurred. Quote the traceId when reporting it.',
    };
  }

  /**
   * Prisma error codes that have a correct HTTP meaning. Everything else stays a
   * 500, because guessing is worse than being honest about an unhandled case.
   *
   * P2002 is the one that matters most: a unique violation is the client racing
   * another client or resubmitting, which is a 409. Left unmapped it becomes a
   * 500, and a duplicate email at registration starts paging someone.
   */
  private classifyPrisma(
    exception: Prisma.PrismaClientKnownRequestError,
  ): { slug: ProblemSlug; status: number; detail?: string } {
    switch (exception.code) {
      case 'P2002':
        return {
          slug: 'conflict',
          status: 409,
          detail: `A record with this ${describeTarget(exception)} already exists.`,
        };
      case 'P2003': // foreign key constraint failed
        return {
          slug: 'conflict',
          status: 409,
          detail: 'The request references something that cannot be used here.',
        };
      case 'P2025': // an operation depended on a record that does not exist
        return { slug: 'not-found', status: 404 };
      case 'P2000': // value too long for the column
      case 'P2006': // value invalid for the field
        return {
          slug: 'validation-failed',
          status: 422,
          detail: 'A submitted value is not valid for its field.',
        };
      default:
        return {
          slug: 'internal-error',
          status: 500,
          detail:
            'An unexpected error occurred. Quote the traceId when reporting it.',
        };
    }
  }
}

/**
 * `meta.target` is the column list for a unique violation. Naming the field is
 * genuinely useful to a client and reveals nothing the client did not just send.
 */
function describeTarget(
  exception: Prisma.PrismaClientKnownRequestError,
): string {
  const target = exception.meta?.target;
  if (Array.isArray(target) && target.length > 0) {
    return target.join(' and ');
  }
  if (typeof target === 'string' && target.length > 0) {
    return target;
  }
  return 'value';
}

function extractHttpDetail(exception: HttpException): { detail?: string } {
  const response = exception.getResponse();

  if (typeof response === 'string') {
    return { detail: response };
  }

  if (response && typeof response === 'object') {
    const message = (response as { message?: unknown }).message;
    if (typeof message === 'string') {
      return { detail: message };
    }
    // An array here means a validation pipe produced it without going through
    // our exception factory. Joining keeps the information rather than dropping it.
    if (Array.isArray(message)) {
      return { detail: message.map(String).join('; ') };
    }
  }

  return {};
}

function serialiseError(exception: unknown): Record<string, unknown> {
  if (exception instanceof Error) {
    return {
      name: exception.name,
      message: exception.message,
      stack: exception.stack,
      ...(exception instanceof Prisma.PrismaClientKnownRequestError
        ? { prismaCode: exception.code, meta: exception.meta }
        : {}),
    };
  }
  return { thrown: String(exception) };
}
