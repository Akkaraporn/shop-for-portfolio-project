import { useQuery } from '@tanstack/react-query';

import { apiFetch, type Schemas } from './client';
import { keys } from './keys';

/**
 * Which backend answered. The smallest possible end-to-end proof that the generated
 * types, the client, the query layer and the gateway agree — and, from Phase 5, the
 * visible half of the backend swap.
 */
export function useHealth() {
  return useQuery({
    queryKey: keys.health,
    queryFn: ({ signal }) => apiFetch<Schemas['Health']>('/health', { signal }),
    staleTime: 5_000,
  });
}
