import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, CreditCard, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';

import { apiFetch, ProblemError, type Schemas } from '@/api/client';
import { isSettled, useCancelOrder, useConfirmPayment, useOrders } from '@/api/hooks';
import { keys } from '@/api/keys';
import { EmptyOrders, EmptyState } from '@/components/state/empty-state';
import { ErrorState } from '@/components/state/error-state';
import { LoadingAnnouncement, OrderRowSkeleton } from '@/components/state/skeletons';
import { OrderSummary } from '@/components/shop/shop-parts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime, formatPrice, ORDER_STATUS_LABEL } from '@/lib/format';

type Order = Schemas['Order'];

/** How long to wait for the provider's webhook before asking the shopper to check back. */
const POLL_LIMIT_MS = 60_000;

/** The mock provider's test cards (task 2.6). */
const CARDS = {
  success: '4242424242424242',
  declined: '4000000000000002',
} as const;

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'paid' || status === 'fulfilled' || status === 'completed'
      ? 'default'
      : status === 'pending_payment'
        ? 'outline'
        : 'secondary';
  return <Badge variant={tone}>{ORDER_STATUS_LABEL[status] ?? status}</Badge>;
}

/**
 * "Reserved for another 14:32." The API returns `reservationExpiresAt`, and showing it
 * turns an invisible server-side sweeper into something a shopper can see.
 */
function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remaining = Math.max(0, new Date(until).getTime() - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);

  if (remaining === 0) {
    return <p className="text-sm text-[var(--color-danger)]">หมดเวลาจองสินค้าแล้ว</p>;
  }

  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Clock className="size-4" aria-hidden="true" />
      จองสินค้าไว้ให้อีก{' '}
      <span className="font-medium tabular-nums text-foreground">
        {minutes}:{String(seconds).padStart(2, '0')}
      </span>{' '}
      นาที
    </p>
  );
}

export function OrderPage() {
  const { orderNumber = '' } = useParams();
  const confirm = useConfirmPayment();
  const cancel = useCancelOrder();

  // When polling started. Polling runs only while the payment is with the provider,
  // and stops after a minute rather than forever.
  const pollStarted = useRef<number | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  const order = useQuery({
    queryKey: keys.orders.detail(orderNumber),
    queryFn: ({ signal }) =>
      apiFetch<Order>(`/orders/${encodeURIComponent(orderNumber)}`, { signal }),
    // The mock provider's webhook lands about two seconds after confirm, so an order
    // read once would sit at `pending_payment` forever. Poll while the payment is being
    // processed — not while it waits for the shopper, and not once it has settled.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || isSettled(data.status) || data.payment.status !== 'processing') {
        pollStarted.current = null;
        return false;
      }
      pollStarted.current ??= Date.now();
      if (Date.now() - pollStarted.current > POLL_LIMIT_MS) {
        setGaveUp(true);
        return false;
      }
      return 2000;
    },
  });

  if (order.isPending) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <LoadingAnnouncement />
        <OrderRowSkeleton />
      </main>
    );
  }

  if (order.isError) {
    const status = order.error instanceof ProblemError ? order.error.status : 0;
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        {status === 404 || status === 403 ? (
          <EmptyState
            title="ไม่พบคำสั่งซื้อนี้"
            description="คำสั่งซื้ออาจไม่ใช่ของบัญชีนี้ หรือเลขที่คำสั่งซื้อไม่ถูกต้อง"
            action={{ label: 'ดูคำสั่งซื้อทั้งหมด', href: '/orders' }}
          />
        ) : (
          <ErrorState
            traceId={order.error instanceof ProblemError ? order.error.traceId : undefined}
            onRetry={() => void order.refetch()}
          />
        )}
      </main>
    );
  }

  const data = order.data;
  const awaitingShopper = data.status === 'pending_payment' && data.payment.status === 'requires_action';
  const processing = data.status === 'pending_payment' && data.payment.status === 'processing';

  function pay(card: string) {
    confirm.mutate(
      { paymentId: data.payment.id, cardNumber: card },
      {
        onSuccess: () => {
          setGaveUp(false);
          void order.refetch();
        },
        onError: (error) =>
          toast.error(
            error instanceof ProblemError && error.slug === 'payment-not-confirmable'
              ? 'คำสั่งซื้อนี้ไม่อยู่ในสถานะที่ชำระเงินได้แล้ว'
              : 'ส่งคำสั่งชำระเงินไม่สำเร็จ ลองใหม่อีกครั้ง',
          ),
      },
    );
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">คำสั่งซื้อ {data.orderNumber}</h1>
          <StatusBadge status={data.status} />
        </div>
        <p className="text-sm text-muted-foreground">สั่งเมื่อ {formatDateTime(data.placedAt)}</p>
      </header>

      {/* The payment panel follows the contract's shape: checkout creates the order,
          confirm hands it to the provider, the webhook settles it. */}
      {awaitingShopper ? (
        <section className="flex flex-col gap-4 rounded-surface border border-border bg-card p-6">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <CreditCard className="size-5" aria-hidden="true" />
            ชำระเงิน {formatPrice(data.totalCents)}
          </h2>
          {data.reservationExpiresAt ? <Countdown until={data.reservationExpiresAt} /> : null}
          <p className="text-sm text-muted-foreground">
            ร้านนี้ใช้ระบบชำระเงินจำลอง ไม่มีการตัดเงินจริง เลือกผลลัพธ์ที่ต้องการทดสอบ
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={confirm.isPending} onClick={() => pay(CARDS.success)}>
              ชำระด้วยบัตรทดสอบ (สำเร็จ)
            </Button>
            <Button variant="outline" disabled={confirm.isPending} onClick={() => pay(CARDS.declined)}>
              บัตรถูกปฏิเสธ (ทดสอบ)
            </Button>
          </div>
        </section>
      ) : null}

      {processing ? (
        <section role="status" className="flex flex-col gap-3 rounded-surface border border-border bg-card p-6">
          {gaveUp ? (
            <>
              <p>การชำระเงินใช้เวลานานกว่าปกติ คำสั่งซื้อยังอยู่ ไม่มีการตัดเงินซ้ำ</p>
              <Button
                variant="outline"
                className="w-fit"
                onClick={() => {
                  setGaveUp(false);
                  void order.refetch();
                }}
              >
                ตรวจสอบสถานะอีกครั้ง
              </Button>
            </>
          ) : (
            <p className="flex items-center gap-2">
              <Clock className="size-5 animate-pulse" aria-hidden="true" />
              กำลังรอผลการชำระเงินจากผู้ให้บริการ…
            </p>
          )}
        </section>
      ) : null}

      {data.status === 'paid' ? (
        <section role="status" className="flex items-center gap-3 rounded-surface bg-[var(--color-success-bg)] p-6">
          <CheckCircle2 className="size-6 text-[var(--color-success)]" aria-hidden="true" />
          <p>ชำระเงินเรียบร้อย ขอบคุณที่สั่งซื้อ ร้านจะจัดส่งสินค้าให้เร็วที่สุด</p>
        </section>
      ) : null}

      {data.status === 'payment_failed' ? (
        <section role="alert" className="flex items-center gap-3 rounded-surface bg-[var(--color-danger-bg)] p-6">
          <XCircle className="size-6 text-[var(--color-danger)]" aria-hidden="true" />
          <p>
            ชำระเงินไม่สำเร็จ{data.payment.failureReason ? `: ${data.payment.failureReason}` : ''} —
            สินค้าที่จองไว้ถูกปล่อยคืนแล้ว สั่งซื้อใหม่ได้ตามปกติ
          </p>
        </section>
      ) : null}

      <section className="flex flex-col gap-4 rounded-surface border border-border bg-card p-6">
        <h2 className="font-medium">รายการสินค้า</h2>
        <ul className="flex flex-col gap-3">
          {data.items.map((item) => (
            <li key={item.id} className="flex items-center gap-4">
              {item.imageUrl ? (
                <img src={item.imageUrl} alt={item.productName} className="size-14 rounded-control object-cover" />
              ) : null}
              <div className="flex-1">
                <p className="text-sm">{item.productName}</p>
                <p className="text-xs text-muted-foreground">
                  {item.variantName} · {formatPrice(item.unitPriceCents)} × {item.quantity}
                </p>
              </div>
              <p className="text-sm tabular-nums">{formatPrice(item.lineTotalCents)}</p>
            </li>
          ))}
        </ul>
        <OrderSummary subtotalCents={data.subtotalCents} shippingCents={data.shippingCents} />
      </section>

      <section className="grid gap-1 text-sm">
        <h2 className="mb-1 font-medium">จัดส่งไปที่</h2>
        <p>{data.shippingAddress.recipientName} · {data.shippingAddress.phone}</p>
        <p className="text-muted-foreground">
          {[data.shippingAddress.line1, data.shippingAddress.line2, data.shippingAddress.city, data.shippingAddress.province, data.shippingAddress.postalCode]
            .filter(Boolean)
            .join(' ')}
        </p>
      </section>

      {/* Shown from the server's `cancellable`, never from a client-side copy of the
          state machine — three implementations of one rule is three places to fix it. */}
      {data.cancellable ? (
        <Button
          variant="outline"
          className="w-fit"
          disabled={cancel.isPending}
          onClick={() =>
            cancel.mutate(data.orderNumber, {
              onSuccess: () => toast.success('ยกเลิกคำสั่งซื้อแล้ว สินค้าที่จองไว้ถูกปล่อยคืน'),
              onError: () => toast.error('ยกเลิกไม่สำเร็จ ลองใหม่อีกครั้ง'),
            })
          }
        >
          ยกเลิกคำสั่งซื้อ
        </Button>
      ) : null}

      <Link to="/orders" className="text-sm text-primary hover:underline">
        ดูคำสั่งซื้อทั้งหมด
      </Link>
    </main>
  );
}

export function OrdersPage() {
  const orders = useOrders();
  const items = orders.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">คำสั่งซื้อของฉัน</h1>

      {orders.isPending ? (
        <div>
          <LoadingAnnouncement />
          <OrderRowSkeleton />
          <OrderRowSkeleton />
        </div>
      ) : orders.isError ? (
        <ErrorState onRetry={() => void orders.refetch()} />
      ) : items.length === 0 ? (
        <EmptyOrders />
      ) : (
        <>
          <ul className="divide-y divide-border rounded-surface border border-border bg-card">
            {items.map((order) => (
              <li key={order.id}>
                <Link
                  to={`/orders/${order.orderNumber}`}
                  className="flex items-center justify-between gap-4 p-4 hover:bg-accent"
                >
                  <div>
                    <p className="font-medium">{order.orderNumber}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(order.placedAt)} · {order.items.length} รายการ
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm tabular-nums">{formatPrice(order.totalCents)}</span>
                    <StatusBadge status={order.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {orders.hasNextPage ? (
            <Button
              variant="outline"
              className="w-fit self-center"
              disabled={orders.isFetchingNextPage}
              onClick={() => void orders.fetchNextPage()}
            >
              ดูเพิ่มเติม
            </Button>
          ) : null}
        </>
      )}
    </main>
  );
}
