import { LogOut, Search, ShoppingBag, Store, User } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';

import { useCart, useCategories } from '@/api/hooks';
import { logout, useSession } from '@/auth/session';
import { EmptyCart } from '@/components/state/empty-state';
import { CartLineSkeleton } from '@/components/state/skeletons';
import { CartLine, OrderSummary, isShort } from '@/components/shop/shop-parts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

/**
 * The header is the one thing identical on every page — it is how a shopper knows they
 * have not left the shop. Order per the reference analysis: logo, categories, search,
 * account, cart.
 */
export function Layout() {
  const [cartOpen, setCartOpen] = useState(false);
  const location = useLocation();

  // Navigating anywhere closes the drawer, so "view product" from a line does not
  // leave the drawer covering the product.
  useEffect(() => setCartOpen(false), [location.pathname]);

  return (
    <div className="flex min-h-dvh flex-col">
      <Header onOpenCart={() => setCartOpen(true)} />
      <div className="flex-1">
        <Outlet />
      </div>
      <footer className="border-t border-border py-8 text-center text-xs text-muted-foreground">
        ร้านตัวอย่างสำหรับพอร์ตโฟลิโอ · ไม่มีการตัดเงินจริง
      </footer>
      <CartDrawer open={cartOpen} onOpenChange={setCartOpen} />
    </div>
  );
}

function Header({ onOpenCart }: { onOpenCart: () => void }) {
  const session = useSession();
  const cart = useCart();
  const categories = useCategories();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    navigate(q ? `/?q=${encodeURIComponent(q)}` : '/');
  }

  const count = cart.data?.itemCount ?? 0;

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 lg:px-6">
        <Link to="/" className="shrink-0 text-lg font-semibold">
          VibeCode<span className="text-primary">.</span>
        </Link>

        <nav aria-label="หมวดหมู่" className="hidden gap-4 text-sm lg:flex">
          {categories.data?.items.map((category) => (
            <NavLink
              key={category.id}
              to={`/?category=${category.slug}`}
              className={() =>
                cn(
                  'text-muted-foreground hover:text-foreground',
                  params.get('category') === category.slug && 'font-medium text-foreground',
                )
              }
            >
              {category.name}
            </NavLink>
          ))}
        </nav>

        <form onSubmit={onSearch} role="search" className="ml-auto hidden sm:block">
          <label htmlFor="header-search" className="sr-only">
            ค้นหาสินค้า
          </label>
          <div className="relative">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id="header-search"
              name="q"
              key={params.get('q') ?? ''}
              defaultValue={params.get('q') ?? ''}
              placeholder="ค้นหาสินค้า"
              className="w-56 pl-9"
            />
          </div>
        </form>

        <div className="ml-auto flex items-center gap-1 sm:ml-0">
          {session.status === 'signed-in' ? (
            <>
              {session.user?.role === 'admin' ? (
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/admin/orders">
                    <Store className="size-4" aria-hidden="true" />
                    <span className="hidden sm:inline">หลังร้าน</span>
                  </Link>
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" asChild>
                <Link to="/orders">
                  <User className="size-4" aria-hidden="true" />
                  <span className="hidden sm:inline">คำสั่งซื้อ</span>
                </Link>
              </Button>
              <Button variant="ghost" size="icon" onClick={() => void logout()} aria-label="ออกจากระบบ">
                <LogOut className="size-4" />
              </Button>
            </>
          ) : session.status === 'signed-out' ? (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/login">เข้าสู่ระบบ</Link>
            </Button>
          ) : null}

          <Button variant="ghost" size="sm" onClick={onOpenCart} aria-label={`ตะกร้า ${count} ชิ้น`}>
            <ShoppingBag className="size-4" aria-hidden="true" />
            <span className="tabular-nums">{count}</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

function CartDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const cart = useCart();
  const navigate = useNavigate();
  const lines = cart.data?.items ?? [];
  const blocked = lines.some(isShort);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>ตะกร้าสินค้า</SheetTitle>
          <SheetDescription>
            {cart.data ? `${cart.data.itemCount} ชิ้น` : 'กำลังโหลด…'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4">
          {cart.isPending ? (
            <div className="flex flex-col gap-4">
              <CartLineSkeleton />
              <CartLineSkeleton />
            </div>
          ) : lines.length === 0 ? (
            <EmptyCart onBrowse={() => onOpenChange(false)} />
          ) : (
            <ul className="flex flex-col gap-2">
              {lines.map((line) => (
                <CartLine key={line.id} line={line} compact />
              ))}
            </ul>
          )}
        </div>

        {lines.length > 0 && cart.data ? (
          <SheetFooter className="border-t border-border">
            <OrderSummary subtotalCents={cart.data.subtotalCents} />
            {blocked ? (
              <p className="text-xs text-[var(--color-warning)]">
                บางรายการมีไม่พอ กรุณาปรับจำนวนก่อนชำระเงิน
              </p>
            ) : null}
            <Button disabled={blocked} onClick={() => navigate('/checkout')}>
              ดำเนินการสั่งซื้อ
            </Button>
            <Button variant="outline" onClick={() => navigate('/cart')}>
              ดูตะกร้าทั้งหมด
            </Button>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
