import type { components } from './schema';

/**
 * The only way this app talks to the API.
 *
 * Every type here comes from `schema.d.ts`, generated from `contract/openapi.yaml`.
 * **Never hand-write an API type.** A hand-written interface compiles happily after
 * the backend changes shape; a generated one makes `tsc` fail at every use. That
 * failure is the entire benefit of working contract-first.
 */

export type Schemas = components['schemas'];
export type Problem = Schemas['Problem'];

export const API_BASE = '/api/v1';

/**
 * An HTTP error from the API, carrying the RFC 9457 body.
 *
 * Every failure a caller sees is one of exactly two classes: this, or `NetworkError`.
 * Pages switch on `problem.type` — the stable URI the contract publishes in
 * docs/problem-types.md — never on the status code or the message text.
 */
export class ProblemError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ProblemError';
    this.problem = problem;
  }

  get status(): number {
    return this.problem.status;
  }

  /** The slug after the base URI, e.g. `insufficient-stock`. */
  get slug(): string {
    return this.problem.type.split('/').pop() ?? '';
  }

  /** Surfaced by ErrorState so a report can be tied to a log line. */
  get traceId(): string | undefined {
    return this.problem.traceId;
  }
}

/** The request never produced a response: offline, DNS, connection refused. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('The API could not be reached.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * Hooks for task 3.2, which adds the access token, the guest cart token and the
 * refresh-on-401 behaviour. Declared here so the client does not have to be rewritten
 * to accept them — 3.2 registers, this file does not change.
 */
export interface ClientHooks {
  /** Extra headers for every request (Authorization, X-Cart-Token). */
  headers?: () => Record<string, string>;
  /** Sees every response, e.g. to store a rotated X-Cart-Token. */
  onResponse?: (response: Response) => void;
  /**
   * Called on a 401. Resolves true when a fresh access token is now available, and the
   * request is retried once with it. Never called for `/auth/*`: a 401 from login or
   * refresh is the answer, not a reason to refresh.
   */
  onUnauthorized?: () => Promise<boolean>;
}

let hooks: ClientHooks = {};

export function configureClient(next: ClientHooks): void {
  hooks = next;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Serialised as JSON. */
  body?: unknown;
  /** Undefined values are dropped, so optional filters can be passed through as-is. */
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);

  if (
    response.status === 401 &&
    !path.startsWith('/auth/') &&
    hooks.onUnauthorized &&
    (await hooks.onUnauthorized())
  ) {
    // One retry, with the headers rebuilt so the new access token is used. A second
    // 401 falls through as an ordinary error: looping would hammer the API with a
    // token it has just rejected.
    return parse<T>(await send(path, options));
  }

  return parse<T>(response);
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);

  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  let response: Response;

  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json, application/problem+json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...hooks.headers?.(),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    // An abort is the caller's own doing (TanStack Query cancelling a stale request),
    // not a failure, so it passes through untouched.
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new NetworkError(error);
  }

  hooks.onResponse?.(response);
  return response;
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ProblemError(await readProblem(response));
  }

  // 204 from logout, and any other empty success.
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/**
 * Every error the API emits is problem+json, so this is normally a straight parse.
 *
 * The fallback exists for the one error that does not come from a backend: a proxy
 * or CDN in front of the gateway answering with HTML. Synthesising a Problem from it
 * keeps callers on one code path instead of two.
 */
async function readProblem(response: Response): Promise<Problem> {
  if (response.headers.get('content-type')?.includes('application/problem+json')) {
    try {
      return (await response.json()) as Problem;
    } catch {
      // Fall through: a truncated body is handled like a non-problem one.
    }
  }

  return {
    type: 'about:blank',
    title: response.statusText || 'Request failed',
    status: response.status,
    traceId: response.headers.get('x-request-id') ?? undefined,
  };
}
