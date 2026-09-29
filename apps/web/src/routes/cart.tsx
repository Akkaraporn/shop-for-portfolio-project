import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate } from 'react-router';

import { ProblemError } from '@/api/client';
import { useCart } from '@/api/hooks';
import { EmptyCart } from '@/components/state/empty-state';
import { ErrorState } from '@/components/state/error-state';
import { CartLineSkeleton, LoadingAnnouncement } from '@/components/state/skeletons';
import { CartLine, OrderSummary, isShort } from '@/components/shop/shop-parts';
import { Button } from '@/components/ui/button';

export function CartPage() {
  const cart = useCart();
  const navigate = useNavigate();

  if (cart.isPending) {
    return (
      <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8">
        <LoadingAnnouncement />
        <CartLineSkeleton />
        <CartLineSkeleton />
      </main>
    );
  }

  if (cart.isError) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <ErrorState
          traceId={cart.error instanceof ProblemError ? cart.error.traceId : undefined}
          onRetry={() => void cart.refetch()}
        />
      </main>
    );
  }

  const lines = cart.data.items;

  if (lines.length === 0) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <EmptyCart onBrowse={() => navigate('/')} />
      </main>
    );
  }

  // A line asking for more than exists blocks checkout here, rather than letting the
  // shopper reach the payment step and meet a 409 there.
  const blocked = lines.some(isShort);

  return (
    <main className="mx-auto grid max-w-5xl gap-8 px-4 py-8 lg:grid-cols-[1fr_20rem]">
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">ตะกร้าสินค้า</h1>
        <ul className="flex flex-col gap-3">
          {lines.map((line) => (
            <CartLine key={line.id} line={line} />
          ))}
        </ul>
        <Link to="/" className="flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" />
          เลือกซื้อสินค้าต่อ
        </Link>
      </section>

      <aside className="flex h-fit flex-col gap-4 rounded-surface border border-border bg-card p-6 lg:sticky lg:top-24">
        <h2 className="font-medium">สรุปคำสั่งซื้อ</h2>
        <OrderSummary subtotalCents={cart.data.subtotalCents} />
        {blocked ? (
          <p role="status" className="text-sm text-[var(--color-warning)]">
            บางรายการมีไม่พอ กรุณาปรับจำนวนก่อนชำระเงิน
          </p>
        ) : null}
        <Button size="lg" disabled={blocked} onClick={() => navigate('/checkout')}>
          ดำเนินการสั่งซื้อ
        </Button>
      </aside>
    </main>
  );
}
