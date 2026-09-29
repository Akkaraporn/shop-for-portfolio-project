import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch, ProblemError, type Paged, type Schemas } from './client';
import { keys } from './keys';

/**
 * The back office's server calls. Same rules as `hooks.ts`: every shape comes from the
 * generated schema, and every write sends what the contract asks for — a signed stock
 * delta, a target status — never a value computed from what the page read earlier.
 */

/**
 * `AdminProduct` is `allOf(ProductDetail, { variants: AdminVariant[] })`, which the
 * generator renders as `ProductVariant[] & AdminVariant[]` — and an intersection of
 * array types resolves element access against the first, losing the stock columns.
 * Narrowed here once, exactly as `Paged<T>` does for page items.
 */
export type AdminProduct = Omit<Schemas['AdminProduct'], 'variants'> & {
  variants: Schemas['AdminVariant'][];
};
type ProductStatus = Schemas['ProductStatus'];
type OrderStatus = Schemas['OrderStatus'];

export function useAdminProducts(status?: ProductStatus) {
  return useInfiniteQuery({
    queryKey: keys.admin.products(status),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Paged<AdminProduct>>('/admin/products', {
        query: { status, cursor: pageParam, limit: 50 },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * One product for the edit form.
 *
 * The contract has no `GET /admin/products/{id}` — the list already carries every
 * field — so this walks the admin list until it finds the id. Bounded, and in practice
 * one request: the product being edited was almost always just clicked in that list,
 * whose cached first page is checked before anything is fetched.
 */
export function useAdminProduct(id: string) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: keys.admin.product(id),
    queryFn: async ({ signal }) => {
      const cached = queryClient
        .getQueriesData<{ pages: Paged<AdminProduct>[] }>({ queryKey: keys.admin.productsAll })
        .flatMap(([, data]) => data?.pages.flatMap((page) => page.items) ?? [])
        .find((product) => product.id === id);
      if (cached) return cached;

      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await apiFetch<Paged<AdminProduct>>('/admin/products', {
          query: { cursor, limit: 50 },
          signal,
        });
        const found = result.items.find((product) => product.id === id);
        if (found) return found;
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      throw new ProblemError({
        type: 'https://errors.example.com/not-found',
        title: 'Resource not found',
        status: 404,
      });
    },
  });
}

function useProductWrite<TVars>(request: (vars: TVars) => Promise<AdminProduct>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (product) => {
      queryClient.setQueryData(keys.admin.product(product.id), product);
      void queryClient.invalidateQueries({ queryKey: keys.admin.productsAll });
      // The storefront's lists, detail pages and category counts may all have changed.
      void queryClient.invalidateQueries({ queryKey: keys.products.all });
      void queryClient.invalidateQueries({ queryKey: keys.categories });
    },
  });
}

export function useCreateProduct() {
  return useProductWrite((body: Schemas['CreateProductRequest']) =>
    apiFetch<AdminProduct>('/admin/products', { method: 'POST', body }),
  );
}

export function useUpdateProduct(id: string) {
  return useProductWrite((body: Schemas['UpdateProductRequest']) =>
    apiFetch<AdminProduct>(`/admin/products/${id}`, { method: 'PATCH', body }),
  );
}

/** A signed delta, never an absolute value: two admins' +10s must both land. */
export function useAdjustStock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { variantId: string; delta: number; reason: string }) =>
      apiFetch<Schemas['AdminVariant']>(`/admin/variants/${vars.variantId}/stock`, {
        method: 'PATCH',
        body: { delta: vars.delta, reason: vars.reason },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.admin.productsAll });
      void queryClient.invalidateQueries({ queryKey: keys.products.all });
    },
  });
}

export function useAdminOrders(status?: OrderStatus) {
  return useInfiniteQuery({
    queryKey: keys.admin.orders(status),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Paged<Schemas['Order']>>('/admin/orders', {
        query: { status, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * Where an order may go next, read from the server's own 409.
 *
 * The back office carries no copy of the order state machine. Asking to move an order
 * to the status it already has is never a transition, so the server always answers
 * `409 invalid-transition` — with no side effect — and its `errors[]` lists the
 * reachable states. The buttons are rendered from that list, so a change to the
 * machine in either backend reaches this page with no frontend release.
 */
export function useNextStatuses(order: Pick<Schemas['Order'], 'orderNumber' | 'status'>) {
  return useQuery({
    queryKey: keys.admin.next(order.orderNumber, order.status),
    queryFn: async () => {
      try {
        await apiFetch(`/admin/orders/${order.orderNumber}/status`, {
          method: 'PATCH',
          body: { status: order.status },
        });
      } catch (error) {
        const next = reachableFrom(error);
        if (next) return next;
        throw error;
      }
      // A 200 would mean the server now treats "stay put" as a transition. Nothing
      // moved, and there is nothing sensible to offer.
      return [];
    },
    staleTime: Infinity,
  });
}

/** The reachable states named by an `invalid-transition` 409, or null if it is not one. */
export function reachableFrom(error: unknown): OrderStatus[] | null {
  if (!(error instanceof ProblemError) || error.slug !== 'invalid-transition') return null;
  return (error.problem.errors ?? [])
    .filter((entry) => entry.field === 'status')
    .map((entry) => entry.message as OrderStatus);
}

export function useAdvanceOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { orderNumber: string; status: OrderStatus }) =>
      apiFetch<Schemas['Order']>(`/admin/orders/${vars.orderNumber}/status`, {
        method: 'PATCH',
        body: { status: vars.status },
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.admin.ordersAll });
      void queryClient.invalidateQueries({ queryKey: keys.orders.all });
    },
  });
}
