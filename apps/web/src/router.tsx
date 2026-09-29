import { createBrowserRouter, Navigate } from 'react-router';

import { EmptyState } from '@/components/state/empty-state';
import { RequireAuth } from '@/auth/require-auth';
import { DesignSystem } from '@/design-system';
import { LoginPage, RegisterPage } from '@/routes/auth-pages';
import { CartPage } from '@/routes/cart';
import { CatalogPage } from '@/routes/catalog';
import { CheckoutPage } from '@/routes/checkout';
import { Layout } from '@/routes/layout';
import { OrderPage, OrdersPage } from '@/routes/orders';
import { ProductPage } from '@/routes/product';
import { RootError, RouteError } from '@/routes/route-error';
import { AdminInventoryPage } from '@/routes/admin/admin-inventory';
import { AdminLayout } from '@/routes/admin/admin-layout';
import { AdminOrdersPage } from '@/routes/admin/admin-orders';
import {
  AdminProductEditPage,
  AdminProductNewPage,
  AdminProductsPage,
} from '@/routes/admin/admin-products';

function NotFound() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <EmptyState
        title="ไม่พบหน้านี้"
        description="ลิงก์อาจไม่ถูกต้อง หรือหน้านี้ถูกย้ายไปแล้ว"
        action={{ label: 'กลับไปหน้าร้าน', href: '/' }}
      />
    </main>
  );
}

export const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RootError />,
    children: [
      {
        // Pathless, so a page that throws is replaced by RouteError while the layout
        // around it — header, search, basket — keeps working.
        errorElement: <RouteError />,
        children: [
          { index: true, element: <CatalogPage /> },
          { path: 'products/:slug', element: <ProductPage /> },
          { path: 'cart', element: <CartPage /> },
          // An order belongs to a user, so checkout and everything after it require one.
          {
            path: 'checkout',
            element: (
              <RequireAuth>
                <CheckoutPage />
              </RequireAuth>
            ),
          },
          {
            path: 'orders',
            element: (
              <RequireAuth>
                <OrdersPage />
              </RequireAuth>
            ),
          },
          {
            path: 'orders/:orderNumber',
            element: (
              <RequireAuth>
                <OrderPage />
              </RequireAuth>
            ),
          },
          {
            path: 'admin',
            element: <AdminLayout />,
            children: [
              { index: true, element: <Navigate to="/admin/orders" replace /> },
              { path: 'orders', element: <AdminOrdersPage /> },
              { path: 'products', element: <AdminProductsPage /> },
              { path: 'products/new', element: <AdminProductNewPage /> },
              { path: 'products/:productId', element: <AdminProductEditPage /> },
              { path: 'inventory', element: <AdminInventoryPage /> },
            ],
          },
          { path: 'login', element: <LoginPage /> },
          { path: 'register', element: <RegisterPage /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
  // The design system stays reachable, outside the shop chrome, as the place to check
  // a token change.
  { path: '/design', element: <DesignSystem /> },
]);
