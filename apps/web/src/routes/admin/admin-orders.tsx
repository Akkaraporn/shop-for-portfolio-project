import { useState } from 'react';
import { toast } from 'sonner';

import { reachableFrom, useAdminOrders, useAdvanceOrder, useNextStatuses } from '@/api/admin-hooks';
import type { Schemas } from '@/api/client';
import { describeError } from '@/api/problem-messages';
import { EmptyState } from '@/components/state/empty-state';
import { ErrorState } from '@/components/state/error-state';
import { LoadingAnnouncement, OrderRowSkeleton } from '@/components/state/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDateTime, formatPrice, ORDER_STATUS_LABEL } from '@/lib/format';
import { cn } from '@/lib/utils';

type Order = Schemas['Order'];
type OrderStatus = Schemas['OrderStatus'];

// Filters, not the state machine: which lists an admin wants to look at. The order
// in which statuses may follow one another is never written down in this app.
const FILTERS: { value?: OrderStatus; label: string }[] = [
  { value: 'paid', label: 'รอจัดส่ง' },
  { value: 'fulfilled', label: 'จัดส่งแล้ว' },
  { value: 'pending_payment', label: 'รอชำระเงิน' },
  { value: undefined, label: 'ทั้งหมด' },
];

export function AdminOrdersPage() {
  const [status, setStatus] = useState<OrderStatus | undefined>('paid');
  const [managing, setManaging] = useState<Order | null>(null);
  const orders = useAdminOrders(status);
  const items = orders.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="flex flex-col gap-4">
      <div role="tablist" aria-label="กรองตามสถานะ" className="flex flex-wrap gap-2">
        {FILTERS.map((filter) => (
          <Button
            key={filter.label}
            role="tab"
            aria-selected={status === filter.value}
            variant={status === filter.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatus(filter.value)}
          >
            {filter.label}
          </Button>
        ))}
      </div>

      {orders.isPending ? (
        <div className="flex flex-col gap-2">
          <LoadingAnnouncement />
          <OrderRowSkeleton />
          <OrderRowSkeleton />
          <OrderRowSkeleton />
        </div>
      ) : orders.isError ? (
        <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title="ไม่มีคำสั่งซื้อในสถานะนี้"
          description="ลองดูสถานะอื่น หรือดูคำสั่งซื้อทั้งหมด"
          action={{ label: 'ดูทั้งหมด', onClick: () => setStatus(undefined) }}
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-surface border border-border bg-card">
          {items.map((order) => (
            <li
              key={order.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-col gap-1">
                <span className="font-medium">{order.orderNumber}</span>
                <span className="text-sm text-muted-foreground">
                  {formatDateTime(order.placedAt)} · {order.items.length} รายการ ·{' '}
                  {order.shippingAddress.recipientName}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{formatPrice(order.totalCents)}</span>
                <Badge variant="outline">{ORDER_STATUS_LABEL[order.status] ?? order.status}</Badge>
                <Button variant="outline" size="sm" onClick={() => setManaging(order)}>
                  เปลี่ยนสถานะ
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {orders.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          disabled={orders.isFetchingNextPage}
          onClick={() => void orders.fetchNextPage()}
        >
          ดูเพิ่มเติม
        </Button>
      ) : null}

      <Dialog open={managing !== null} onOpenChange={(open) => !open && setManaging(null)}>
        <DialogContent>
          {managing ? <StatusChanger order={managing} onDone={() => setManaging(null)} /> : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * The buttons are whatever the server says is reachable — first from the probe in
 * `useNextStatuses`, then, if someone else moved the order meanwhile, from the 409 that
 * this admin's click receives. Neither path consults a table in this file.
 */
function StatusChanger({ order, onDone }: { order: Order; onDone: () => void }) {
  const probe = useNextStatuses(order);
  const advance = useAdvanceOrder();
  const [learned, setLearned] = useState<OrderStatus[] | null>(null);
  const next = learned ?? probe.data;

  function move(status: OrderStatus) {
    advance.mutate(
      { orderNumber: order.orderNumber, status },
      {
        onSuccess: (updated) => {
          toast.success(
            `${updated.orderNumber}: ${ORDER_STATUS_LABEL[updated.status] ?? updated.status}`,
          );
          onDone();
        },
        onError: (error) => {
          const reachable = reachableFrom(error);
          if (reachable) {
            // Another admin got there first. The 409 says where the order can go now.
            setLearned(reachable);
            toast.error('สถานะเพิ่งถูกเปลี่ยนโดยผู้อื่น ปุ่มด้านล่างแสดงขั้นที่ทำได้ตอนนี้');
          } else {
            toast.error(describeError(error).message);
          }
        },
      },
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{order.orderNumber}</DialogTitle>
        <DialogDescription>
          สถานะตอนนี้: {ORDER_STATUS_LABEL[order.status] ?? order.status}
        </DialogDescription>
      </DialogHeader>

      {probe.isError && !learned ? (
        <ErrorState error={probe.error} onRetry={() => void probe.refetch()} />
      ) : next === undefined ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          กำลังตรวจสอบขั้นถัดไป…
        </p>
      ) : next.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          คำสั่งซื้อนี้ไม่มีขั้นถัดไปให้เปลี่ยนจากหลังร้าน
        </p>
      ) : (
        <div className={cn('flex flex-wrap gap-2')}>
          {next.map((status) => (
            <Button key={status} disabled={advance.isPending} onClick={() => move(status)}>
              เปลี่ยนเป็น “{ORDER_STATUS_LABEL[status] ?? status}”
            </Button>
          ))}
        </div>
      )}
    </>
  );
}
