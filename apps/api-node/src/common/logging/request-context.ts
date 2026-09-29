import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /**
   * Correlates a response with its log lines. Emitted as `traceId` in every
   * Problem body and as the `X-Request-Id` response header.
   */
  requestId: string;
}

/**
 * Request-scoped state, carried without threading it through every signature.
 *
 * The exception filter needs the request id, and so does every log line. Passing
 * it explicitly would mean adding a parameter to every service method that might
 * one day fail, which is all of them. `AsyncLocalStorage` is the standard Node
 * mechanism for exactly this and survives `await` boundaries.
 *
 * Deliberately not a Nest request-scoped provider: those force every consumer
 * into request scope too, which quietly makes the whole injection graph
 * per-request.
 */
const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The current request id, or undefined outside a request (startup, shutdown, a
 * scheduled job). Callers must treat it as optional rather than assert it.
 */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
