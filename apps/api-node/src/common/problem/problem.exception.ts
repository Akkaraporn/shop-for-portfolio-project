import { HttpException } from '@nestjs/common';

import {
  PROBLEM_TYPES,
  ProblemSlug,
  problemTypeUri,
} from './problem-types';

/**
 * One field-level problem, matching `FieldError` in the contract.
 *
 * `variantId`, `requested` and `available` are only populated on an
 * insufficient-stock 409, where the client needs every short line at once in
 * order to fix the basket in a single pass.
 */
export interface FieldError {
  field: string;
  message: string;
  variantId?: string;
  requested?: number;
  available?: number;
}

/**
 * The response body, matching `Problem` in the contract (RFC 9457).
 */
export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  traceId?: string;
  errors?: FieldError[];
}

/**
 * The only exception type this codebase should throw deliberately.
 *
 * Carrying the slug rather than a pre-built body means the filter stays the sole
 * place that assembles a response, so `traceId` and `instance` cannot be
 * forgotten at an individual throw site.
 */
export class ProblemException extends HttpException {
  readonly slug: ProblemSlug;
  readonly detail?: string;
  readonly errors?: FieldError[];

  constructor(
    slug: ProblemSlug,
    options: { detail?: string; errors?: FieldError[] } = {},
  ) {
    const definition = PROBLEM_TYPES[slug];
    super(definition.title, definition.status);
    this.slug = slug;
    this.detail = options.detail;
    this.errors = options.errors;
  }

  get typeUri(): string {
    return problemTypeUri(this.slug);
  }

  get title(): string {
    return PROBLEM_TYPES[this.slug].title;
  }
}

/** Convenience constructors for the problems thrown most often. */
export const Problems = {
  notFound: (detail?: string) => new ProblemException('not-found', { detail }),

  validationFailed: (errors: FieldError[], detail?: string) =>
    new ProblemException('validation-failed', { errors, detail }),

  invalidCursor: (detail = 'The cursor is not a value this API issued.') =>
    new ProblemException('invalid-cursor', {
      detail,
      errors: [{ field: 'cursor', message: detail }],
    }),

  conflict: (detail?: string) => new ProblemException('conflict', { detail }),

  unauthorized: (detail?: string) =>
    new ProblemException('unauthorized', { detail }),

  forbidden: (detail?: string) => new ProblemException('forbidden', { detail }),

  unavailable: (detail?: string) =>
    new ProblemException('service-unavailable', { detail }),
} as const;
