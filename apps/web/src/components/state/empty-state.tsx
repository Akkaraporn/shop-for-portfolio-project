import type { LucideIcon } from 'lucide-react';
import { Inbox, PackageSearch, ReceiptText, ShoppingBag } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  /** What happened, and what the reader can do about it. Never just "no data". */
  description: string;
  action?: { label: string; onClick?: () => void; href?: string };
  className?: string;
  children?: ReactNode;
}

/**
 * The screen a shopper sees when there is nothing to show.
 *
 * Every empty state carries a way out. An empty basket that only says "empty" is a
 * dead end: the reader already knows it is empty, and what they need is the button
 * back to the catalogue. That is why `action` is part of the shape rather than
 * something each caller remembers to add.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center',
        className,
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {/* Decorative: the heading already says what this is, so a screen reader
            announcing the icon would just repeat it. */}
        <Icon className="size-6" aria-hidden="true" />
      </span>

      <div className="flex max-w-prose flex-col gap-2">
        <h2 className="text-lg font-medium text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      {action ? (
        action.href ? (
          <Button asChild>
            <a href={action.href}>{action.label}</a>
          </Button>
        ) : (
          <Button onClick={action.onClick}>{action.label}</Button>
        )
      ) : null}

      {children}
    </div>
  );
}

/**
 * The three empties this shop actually has.
 *
 * Named rather than assembled at each call site, so the wording is decided once and
 * a page cannot quietly invent a fourth way of saying "nothing here".
 */
export function EmptyCart({ onBrowse }: { onBrowse?: () => void }) {
  return (
    <EmptyState
      icon={ShoppingBag}
      title="ตะกร้าของคุณยังว่างอยู่"
      description="เลือกสินค้าที่ถูกใจแล้วกดเพิ่มลงตะกร้า สินค้าจะอยู่ในตะกร้าให้แม้ปิดหน้าเว็บไปแล้ว"
      action={{ label: 'เลือกซื้อสินค้า', onClick: onBrowse, href: onBrowse ? undefined : '/' }}
    />
  );
}

export function EmptySearch({
  query,
  onClear,
}: {
  query?: string;
  onClear?: () => void;
}) {
  return (
    <EmptyState
      icon={PackageSearch}
      title={query ? `ไม่พบสินค้าที่ตรงกับ "${query}"` : 'ไม่พบสินค้า'}
      description="ลองใช้คำค้นที่สั้นลง หรือล้างตัวกรองบางอย่างออก แล้วค้นหาอีกครั้ง"
      action={onClear ? { label: 'ล้างตัวกรองทั้งหมด', onClick: onClear } : undefined}
    />
  );
}

export function EmptyOrders() {
  return (
    <EmptyState
      icon={ReceiptText}
      title="ยังไม่มีคำสั่งซื้อ"
      description="เมื่อสั่งซื้อสำเร็จ รายการและสถานะการจัดส่งจะแสดงอยู่ที่นี่"
      action={{ label: 'เริ่มเลือกซื้อ', href: '/' }}
    />
  );
}
