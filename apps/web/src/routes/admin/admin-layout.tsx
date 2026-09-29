import { NavLink, Outlet } from 'react-router';

import { RequireAuth } from '@/auth/require-auth';
import { useSession } from '@/auth/session';
import { EmptyState } from '@/components/state/empty-state';
import { cn } from '@/lib/utils';

const TABS = [
  { to: '/admin/orders', label: 'คำสั่งซื้อ' },
  { to: '/admin/products', label: 'สินค้า' },
  { to: '/admin/inventory', label: 'คลังสินค้า' },
];

/**
 * The back office's frame: sign-in required, then the admin role.
 *
 * The role check here is for the reader, not for security — the API enforces
 * `@Roles('admin')` on every route and answers a customer with 403 whatever this page
 * renders. A signed-in customer who types /admin sees a plain explanation rather than
 * a page of failed requests.
 */
export function AdminLayout() {
  return (
    <RequireAuth>
      <AdminOnly />
    </RequireAuth>
  );
}

function AdminOnly() {
  const { user } = useSession();

  if (user?.role !== 'admin') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <EmptyState
          title="หน้านี้สำหรับผู้ดูแลร้าน"
          description="บัญชีนี้ไม่มีสิทธิ์เข้าหลังร้าน หากต้องการซื้อสินค้า กลับไปที่หน้าร้านได้เลย"
          action={{ label: 'กลับไปหน้าร้าน', href: '/' }}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 lg:px-6">
      <div className="flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="text-2xl font-semibold">หลังร้าน</h1>
        <nav aria-label="เมนูหลังร้าน" className="flex gap-1">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                cn(
                  'rounded-control px-3 py-2 text-sm',
                  isActive
                    ? 'bg-secondary font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Outlet />
    </main>
  );
}
