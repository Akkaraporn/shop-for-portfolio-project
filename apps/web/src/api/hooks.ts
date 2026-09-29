import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { apiFetch, type Schemas } from './client';
import { keys } from './keys';
import type { paths } from './schema';

/**
 * Every server call the pages make. Request and response shapes are taken from the
 * generated schema, so a contract change surfaces here as a type error.
 */

export type ProductFilters = NonNullable<paths['/products']['get']['parameters']['query']>;

// --- catalogue -------------------------------------------------------------------

export function useCategories() {
  return useQuery({
    queryKey: keys.categories,
    queryFn: ({ signal }) => apiFetch<Schemas['CategoryPage']>('/categories', { signal }),
    staleTime: 5 * 60_000, // matches the server's Cache-Control
  });
}

export function useProducts(filters: Omit<ProductFilters, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: keys.products.list(filters),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Schemas['ProductPage']>('/products', {
        query: { ...filters, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    // The contract omits nextCursor on the last page. TanStack stops only on
    // `undefined`, so anything else — a null, an empty string — would fetch forever.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Keep the old grid on screen while a new filter loads, instead of flashing to
    // skeletons on every click.
    placeholderData: keepPreviousData,
  });
}

export function useProduct(slug: string) {
  return useQuery({
    queryKey: keys.products.detail(slug),
    queryFn: ({ signal }) =>
      apiFetch<Schemas['ProductDetail']>(`/products/${encodeURIComponent(slug)}`, { signal }),
  });
}

// --- cart --------------------------------------------------------------------------

export function useCart() {
  return useQuery({
    queryKey: keys.cart.all,
    queryFn: ({ signal }) => apiFetch<Schemas['Cart']>('/carts/me', { signal }),
    // Prices are live and stock moves. A basket that is 30 seconds stale is a basket
    // that promises the wrong total.
    staleTime: 0,
  });
}

/** Every cart mutation returns the whole basket, so the cache is set, not refetched. */
function useCartMutation<TVars>(request: (vars: TVars) => Promise<Schemas['Cart']>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (cart) => queryClient.setQueryData(keys.cart.all, cart),
  });
}

export function useAddToCart() {
  return useCartMutation((vars: { variantId: string; quantity: number }) =>
    apiFetch<Schemas['Cart']>('/carts/me/items', { method: 'POST', body: vars }),
  );
}

export function useUpdateLine() {
  return useCartMutation((vars: { itemId: string; quantity: number }) =>
    apiFetch<Schemas['Cart']>(`/carts/me/items/${vars.itemId}`, {
      method: 'PATCH',
      body: { quantity: vars.quantity },
    }),
  );
}

export function useRemoveLine() {
  return useCartMutation((itemId: string) =>
    apiFetch<Schemas['Cart']>(`/carts/me/items/${itemId}`, { method: 'DELETE' }),
  );
}

// --- checkout and orders --------------------------------------------------------------

export function useCheckout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { body: Schemas['CheckoutRequest']; idempotencyKey: string }) =>
      apiFetch<Schemas['Order']>('/checkout', {
        method: 'POST',
        body: vars.body,
        headers: { 'Idempotency-Key': vars.idempotencyKey },
      }),
    onSuccess: (order) => {
      queryClient.setQueryData(keys.orders.detail(order.orderNumber), order);
      void queryClient.invalidateQueries({ queryKey: keys.cart.all });
      void queryClient.invalidateQueries({ queryKey: keys.orders.all });
    },
  });
}

const SETTLED: ReadonlySet<string> = new Set([
  'paid',
  'payment_failed',
  'cancelled',
  'expired',
  'fulfilled',
  'completed',
]);

export function isSettled(status: string | undefined): boolean {
  return status !== undefined && SETTLED.has(status);
}

/**
 * One order. With `poll`, it refetches every two seconds until the order settles —
 * the mock provider's webhook lands about two seconds after confirm, so a page that
 * read the order once would show `pending_payment` forever.
 */
export function useOrder(orderNumber: string, options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: keys.orders.detail(orderNumber),
    queryFn: ({ signal }) =>
      apiFetch<Schemas['Order']>(`/orders/${encodeURIComponent(orderNumber)}`, { signal }),
    refetchInterval: (query) =>
      options.poll && !isSettled(query.state.data?.status) ? 2000 : false,
  });
}

export function useOrders() {
  return useInfiniteQuery({
    queryKey: keys.orders.all,
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Schemas['OrderPage']>('/orders', { query: { cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useCancelOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderNumber: string) =>
      apiFetch<Schemas['Order']>(`/orders/${encodeURIComponent(orderNumber)}/cancel`, {
        method: 'POST',
      }),
    onSuccess: (order) => {
      queryClient.setQueryData(keys.orders.detail(order.orderNumber), order);
      void queryClient.invalidateQueries({ queryKey: keys.orders.all });
    },
  });
}

export function useConfirmPayment() {
  return useMutation({
    mutationFn: (vars: { paymentId: string; cardNumber?: string }) =>
      apiFetch<Schemas['Payment']>(`/payments/${vars.paymentId}/confirm`, {
        method: 'POST',
        body: vars.cardNumber ? { cardNumber: vars.cardNumber } : {},
      }),
  });
}
