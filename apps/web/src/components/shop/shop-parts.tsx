import { AlertTriangle, Minus, Plus, Trash2 } from 'lucide-react';
import { Link } from 'react-router';

import type { Schemas } from '@/api/client';
import { useRemoveLine, useUpdateLine } from '@/api/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatPrice } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Show stock only when it is low; always showing it turns a nudge into noise. */
export const LOW_STOCK = 5;

/**
 * The stock badge, per the task's table: sold out at 0, "N left" at 1–5, nothing above.
 *
 * `availableStock` is advisory — computed at read time, re-verified under a lock at
 * checkout — so this is information, never a guarantee.
 */
export function StockBadge({ available }: { available: number }) {
  if (available <= 0) {
    return <Badge variant="destructive">สินค้าหมด</Badge>;
  }
  if (available <= LOW_STOCK) {
    return (
      <Badge className="bg-[var(--color-warning-bg)] text-[var(--color-warning)] hover:bg-[var(--color-warning-bg)]">
        เหลือ {available} ชิ้น
      </Badge>
    );
  }
  return null;
}

export function ProductCard({ product }: { product: Schemas['ProductSummary'] }) {
  return (
    <Link
      to={`/products/${product.slug}`}
      className="group flex flex-col gap-3 rounded-surface focus-visible:outline-offset-4"
    >
      <div className="relative aspect-square overflow-hidden rounded-surface bg-muted">
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt={product.name}
            loading="lazy"
            className={cn(
              'size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]',
              !product.inStock && 'opacity-60',
            )}
          />
        ) : null}
        {!product.inStock ? (
          <Badge variant="secondary" className="absolute top-3 left-3">
            สินค้าหมด
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        {/* Two lines at most: a card's job is to get someone to the product page. */}
        <p className="line-clamp-2 text-sm">{product.name}</p>
        {/* minPriceCents is the cheapest variant, so a card for a product whose sizes
            differ in price reads "from". */}
        <p className="text-sm font-medium">{formatPrice(product.minPriceCents)}</p>
      </div>
    </Link>
  );
}

/**
 * A line whose quantity exceeds what is available. The server returns
 * `availableStock` per line precisely so this can be caught here — a warning on the
 * line is much better than a 409 at the payment step.
 */
export function isShort(line: Schemas['CartItem']): boolean {
  return line.quantity > line.availableStock;
}

export function CartLine({
  line,
  compact = false,
  highlighted = false,
}: {
  line: Schemas['CartItem'];
  compact?: boolean;
  /** Set when a checkout 409 named this variant. */
  highlighted?: boolean;
}) {
  const update = useUpdateLine();
  const remove = useRemoveLine();
  const busy = update.isPending || remove.isPending;
  const short = isShort(line);

  return (
    <li
      className={cn(
        'flex gap-4 rounded-surface p-2',
        (short || highlighted) && 'bg-[var(--color-warning-bg)]',
      )}
    >
      <Link to={`/products/${line.slug}`} className="shrink-0">
        {line.imageUrl ? (
          <img
            src={line.imageUrl}
            alt={line.productName}
            className={cn('rounded-control object-cover', compact ? 'size-16' : 'size-20')}
          />
        ) : (
          <div className={cn('rounded-control bg-muted', compact ? 'size-16' : 'size-20')} />
        )}
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link to={`/products/${line.slug}`} className="line-clamp-2 text-sm hover:underline">
          {line.productName}
        </Link>
        <p className="text-xs text-muted-foreground">
          {line.variantName} · {formatPrice(line.unitPriceCents)}
        </p>

        {short ? (
          <p className="flex items-center gap-1 text-xs text-[var(--color-warning)]">
            <AlertTriangle className="size-3" aria-hidden="true" />
            {line.availableStock === 0
              ? 'สินค้าหมดแล้ว กรุณาลบออกจากตะกร้า'
              : `เหลือเพียง ${line.availableStock} ชิ้น กรุณาลดจำนวน`}
          </p>
        ) : null}

        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="flex items-center rounded-control border border-border">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              disabled={busy || line.quantity <= 1}
              onClick={() => update.mutate({ itemId: line.id, quantity: line.quantity - 1 })}
              aria-label={`ลดจำนวน ${line.productName}`}
            >
              <Minus className="size-3" />
            </Button>
            <span className="w-8 text-center text-sm tabular-nums" aria-live="polite">
              {line.quantity}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              // Capped at what exists as well as at 99: the server would 409 anyway.
              disabled={busy || line.quantity >= Math.min(99, line.availableStock)}
              onClick={() => update.mutate({ itemId: line.id, quantity: line.quantity + 1 })}
              aria-label={`เพิ่มจำนวน ${line.productName}`}
            >
              <Plus className="size-3" />
            </Button>
          </div>

          <span className="text-sm font-medium tabular-nums">
            {formatPrice(line.lineTotalCents)}
          </span>

          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={busy}
            onClick={() => remove.mutate(line.id)}
            aria-label={`ลบ ${line.productName} ออกจากตะกร้า`}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
    </li>
  );
}

/** The summary block shared by the drawer, the cart page and checkout. */
export function OrderSummary({
  subtotalCents,
  shippingCents,
}: {
  subtotalCents: number;
  shippingCents?: number;
}) {
  return (
    <dl className="grid gap-2 text-sm">
      <div className="flex justify-between">
        <dt className="text-muted-foreground">ยอดรวมสินค้า</dt>
        <dd className="tabular-nums">{formatPrice(subtotalCents)}</dd>
      </div>
      {/* Shown even though it is flat: a total that appears from nowhere at checkout
          is where people abandon. */}
      <div className="flex justify-between">
        <dt className="text-muted-foreground">ค่าจัดส่ง</dt>
        <dd className="tabular-nums">
          {shippingCents === undefined ? 'คำนวณตอนชำระเงิน' : formatPrice(shippingCents)}
        </dd>
      </div>
      {shippingCents !== undefined ? (
        <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
          <dt>รวมทั้งสิ้น</dt>
          <dd className="tabular-nums">{formatPrice(subtotalCents + shippingCents)}</dd>
        </div>
      ) : null}
    </dl>
  );
}
