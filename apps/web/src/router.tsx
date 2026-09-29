import { createBrowserRouter } from 'react-router';

import { EmptyState } from '@/components/state/empty-state';
import { DesignSystem } from '@/design-system';
import { LoginPage, RegisterPage } from '@/routes/auth-pages';
import { CartPage } from '@/routes/cart';
import { CatalogPage } from '@/routes/catalog';
import { Layout } from '@/routes/layout';
import { ProductPage } from '@/routes/product';

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
    children: [
      { index: true, element: <CatalogPage /> },
      { path: 'products/:slug', element: <ProductPage /> },
      { path: 'cart', element: <CartPage /> },
      { path: 'login', element: <LoginPage /> },
      { path: 'register', element: <RegisterPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
  // The design system stays reachable, outside the shop chrome, as the place to check
  // a token change.
  { path: '/design', element: <DesignSystem /> },
]);
