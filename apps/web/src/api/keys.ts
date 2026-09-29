/**
 * Query keys, in one place.
 *
 * Hierarchical so a whole family can be invalidated at once — `keys.cart.all` after a
 * checkout clears every cart query without naming each one.
 */
export const keys = {
  health: ['health'] as const,
  categories: ['categories'] as const,
  products: {
    all: ['products'] as const,
    list: (filters: object) => ['products', 'list', filters] as const,
    detail: (slug: string) => ['products', 'detail', slug] as const,
  },
  cart: { all: ['cart'] as const },
  orders: {
    all: ['orders'] as const,
    detail: (orderNumber: string) => ['orders', 'detail', orderNumber] as const,
  },
};
