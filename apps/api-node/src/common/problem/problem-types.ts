/**
 * The problem type registry.
 *
 * `type` is the field clients switch on, so its value is part of the contract as
 * surely as any schema. Both implementations must emit byte-identical URIs and
 * titles — a Java port that says "Not found" where this says "Resource not found"
 * fails the parity suite for a reason that has nothing to do with behaviour.
 *
 * Hence a registry rather than string literals at throw sites: there is one place
 * to read when porting, and one place to change. The catalogue is mirrored in
 * `docs/problem-types.md` for the Java side.
 *
 * The base URI is a constant, not configuration. If it were an environment
 * variable the two backends could be deployed with different values and every
 * client's error handling would break against one of them.
 */
export const PROBLEM_TYPE_BASE = 'https://errors.example.com' as const;

export interface ProblemDefinition {
  readonly status: number;
  readonly title: string;
}

/**
 * Every problem this API can emit. Keys are the URI slug.
 */
export const PROBLEM_TYPES = {
  // --- generic, one per HTTP status we actually use ------------------------
  'validation-failed': { status: 422, title: 'Validation failed' },
  'not-found': { status: 404, title: 'Resource not found' },
  unauthorized: { status: 401, title: 'Unauthorized' },
  forbidden: { status: 403, title: 'Forbidden' },
  conflict: { status: 409, title: 'Conflict' },
  'bad-request': { status: 400, title: 'Bad request' },
  'internal-error': { status: 500, title: 'Internal server error' },
  'service-unavailable': { status: 503, title: 'Service unavailable' },

  // --- pagination ---------------------------------------------------------
  // A cursor is opaque, so a client cannot be expected to repair one. This is
  // 422 rather than 400 because the request is well formed; the value is not.
  'invalid-cursor': { status: 422, title: 'Invalid cursor' },

  // --- auth (task 2.2) ----------------------------------------------------
  'invalid-credentials': { status: 401, title: 'Invalid credentials' },
  'email-already-registered': {
    status: 409,
    title: 'Email already registered',
  },
  // Presenting an already-rotated refresh token means a copy leaked, so the
  // whole family is revoked. The client cannot recover; it must log in again.
  'token-reuse-detected': { status: 401, title: 'Refresh token reuse detected' },

  // --- cart and checkout (tasks 2.4, 2.5) ---------------------------------
  'insufficient-stock': { status: 409, title: 'Insufficient stock' },
  'checkout-in-progress': { status: 409, title: 'Checkout already in progress' },
  // The same idempotency key presented with a different request body. Replaying
  // would be wrong and proceeding would be worse.
  'idempotency-key-reused': {
    status: 422,
    title: 'Idempotency key reused with a different request',
  },

  // --- orders, payments, admin (tasks 2.6, 2.7) ---------------------------
  'order-not-cancellable': { status: 409, title: 'Order cannot be cancelled' },
  'payment-not-confirmable': { status: 409, title: 'Payment cannot be confirmed' },
  'invalid-transition': { status: 409, title: 'Invalid status transition' },
} as const satisfies Record<string, ProblemDefinition>;

export type ProblemSlug = keyof typeof PROBLEM_TYPES;

export function problemTypeUri(slug: ProblemSlug): string {
  return `${PROBLEM_TYPE_BASE}/${slug}`;
}

/**
 * Fallback mapping for exceptions thrown by Nest itself or by libraries, which
 * carry a status but no problem slug. Anything not listed becomes
 * `internal-error`, which is the safe direction to fail in.
 */
const STATUS_TO_SLUG: Readonly<Record<number, ProblemSlug>> = {
  400: 'bad-request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  422: 'validation-failed',
  500: 'internal-error',
  503: 'service-unavailable',
};

export function slugForStatus(status: number): ProblemSlug {
  return STATUS_TO_SLUG[status] ?? 'internal-error';
}
