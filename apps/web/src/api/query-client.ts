import { QueryClient } from '@tanstack/react-query';

import { NetworkError, ProblemError } from './client';

/**
 * Retries only failures that can fix themselves.
 *
 * A 4xx never will — retrying a 422 sends the same invalid body again — and a 5xx
 * from this API is a bug that needs a traceId, not three more identical requests.
 * A dropped connection, on the other hand, is exactly what a retry is for.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ProblemError) {
    return false;
  }
  return error instanceof NetworkError && failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The catalogue changes rarely; refetching on every window focus would hit
        // the API each time a shopper switches tabs to compare prices.
        staleTime: 30_000,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
      mutations: {
        // Never retried automatically. A mutation that timed out may have succeeded,
        // and blindly resending it is how duplicate orders happen — checkout gets its
        // safety from the Idempotency-Key, not from a retry loop.
        retry: false,
      },
    },
  });
}
