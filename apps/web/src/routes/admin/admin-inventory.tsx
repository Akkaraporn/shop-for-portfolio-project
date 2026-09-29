import { Minus, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { useAdjustStock, useAdminProducts } from '@/api/admin-hooks';
import { ProblemError, type Schemas } from '@/api/client';
import { describeError } from '@/api/problem-messages';
import { EmptyState } from '@/components/state/empty-state';
import { ErrorState } from '@/components/state/error-state';
import { LoadingAnnouncement, OrderRowSkeleton } from '@/components/state/skeletons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type Variant = Schemas['AdminVariant'];

/**
 * Stock, one row per variant.
 *
 * Every control sends a signed delta — the +/− buttons send ±1, the form sends
 * whatever was typed — and never the number on screen. That number may already be
 * stale: if two admins both read 40 and each wrote "50", one restock would vanish;
 * two `+10`s both land.
 */
export function AdminInventoryPage() {
  const products = useAdminProducts();
  const rows =
    products.data?.pages.flatMap((page) =>
      page.items.flatMap((product) => product.variants.map((variant) => ({ product, variant }))),
    ) ?? [];

  if (products.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <LoadingAnnouncement />
        <OrderRowSkeleton />
        <OrderRowSkeleton />
      </div>
    );
  }
  if (products.isError) {
    return <ErrorState error={products.error} onRetry={() => void products.refetch()} />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="ยังไม่มีสินค้าในคลัง"
        description="เพิ่มสินค้าใหม่ก่อน แล้วสต็อกของแต่ละตัวเลือกจะแสดงที่นี่"
        action={{ label: 'เพิ่มสินค้า', href: '/admin/products/new' }}
      />
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        “จองไว้” คือจำนวนที่อยู่ในคำสั่งซื้อที่ยังไม่ชำระ ลดสต็อกให้ต่ำกว่านั้นไม่ได้
      </p>
      <div className="overflow-x-auto rounded-surface border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>สินค้า</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead className="text-right">คงคลัง</TableHead>
              <TableHead className="text-right">จองไว้</TableHead>
              <TableHead className="text-right">ขายได้</TableHead>
              <TableHead>ปรับสต็อก</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ product, variant }) => (
              <StockRow
                key={variant.id}
                productName={product.name}
                productStatus={product.status}
                variant={variant}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      {products.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          disabled={products.isFetchingNextPage}
          onClick={() => void products.fetchNextPage()}
        >
          ดูเพิ่มเติม
        </Button>
      ) : null}
    </section>
  );
}

function StockRow({
  productName,
  productStatus,
  variant,
}: {
  productName: string;
  productStatus: string;
  variant: Variant;
}) {
  const adjust = useAdjustStock();
  const [custom, setCustom] = useState(false);

  function send(delta: number, reason: string) {
    adjust.mutate(
      { variantId: variant.id, delta, reason },
      {
        onSuccess: (updated) => toast.success(`${variant.sku}: คงคลัง ${updated.stockOnHand} ชิ้น`),
        onError: (error) =>
          toast.error(
            // The one 409 this endpoint raises is "below what is reserved"; say it in
            // terms of this screen rather than the generic conflict message.
            error instanceof ProblemError && error.slug === 'conflict'
              ? `ลดไม่ได้: มีลูกค้าจองไว้ ${variant.stockReserved} ชิ้น`
              : describeError(error).message,
          ),
      },
    );
  }

  function onCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const delta = Number(form.get('delta'));
    const reason = String(form.get('reason') ?? '').trim();
    if (!Number.isInteger(delta) || delta === 0 || !reason) {
      toast.error('ใส่จำนวนเป็นจำนวนเต็มที่ไม่ใช่ศูนย์ และระบุเหตุผล');
      return;
    }
    send(delta, reason);
    setCustom(false);
  }

  return (
    <TableRow>
      <TableCell>
        {productName}
        <span className="block text-xs text-muted-foreground">
          {variant.name}
          {productStatus !== 'active' ? ` · ${productStatus}` : ''}
        </span>
      </TableCell>
      <TableCell className="font-mono text-xs">{variant.sku}</TableCell>
      <TableCell className="text-right tabular-nums">{variant.stockOnHand}</TableCell>
      <TableCell className="text-right tabular-nums">{variant.stockReserved}</TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        {variant.availableStock}
      </TableCell>
      <TableCell>
        {custom ? (
          <form onSubmit={onCustom} className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor={`delta-${variant.id}`} className="text-xs">
                เพิ่ม/ลด
              </Label>
              <Input
                id={`delta-${variant.id}`}
                name="delta"
                type="number"
                step={1}
                placeholder="+10 หรือ -3"
                className="w-24"
                autoFocus
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`reason-${variant.id}`} className="text-xs">
                เหตุผล
              </Label>
              <Input
                id={`reason-${variant.id}`}
                name="reason"
                maxLength={200}
                placeholder="รับของเข้า"
                className="w-32"
              />
            </div>
            <Button type="submit" size="sm" disabled={adjust.isPending}>
              บันทึก
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCustom(false)}>
              ยกเลิก
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="outline"
              aria-label={`ลด ${variant.sku} 1 ชิ้น`}
              disabled={adjust.isPending}
              onClick={() => send(-1, 'ปรับลดจากหลังร้าน')}
            >
              <Minus className="size-4" aria-hidden="true" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              aria-label={`เพิ่ม ${variant.sku} 1 ชิ้น`}
              disabled={adjust.isPending}
              onClick={() => send(1, 'ปรับเพิ่มจากหลังร้าน')}
            >
              <Plus className="size-4" aria-hidden="true" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCustom(true)}>
              ระบุจำนวน
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
