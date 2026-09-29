import { Check, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';

import { ProblemError } from '@/api/client';
import { useAddToCart, useProduct } from '@/api/hooks';
import { EmptyState } from '@/components/state/empty-state';
import { ErrorState } from '@/components/state/error-state';
import { LoadingAnnouncement, ProductDetailSkeleton } from '@/components/state/skeletons';
import { StockBadge } from '@/components/shop/shop-parts';
import { Button } from '@/components/ui/button';
import { formatPrice } from '@/lib/format';
import { cn } from '@/lib/utils';

export function ProductPage() {
  const { slug = '' } = useParams();
  const product = useProduct(slug);
  const add = useAddToCart();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [imageIndex, setImageIndex] = useState(0);

  if (product.isPending) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
        <LoadingAnnouncement label="กำลังโหลดสินค้า" />
        <ProductDetailSkeleton />
      </main>
    );
  }

  if (product.isError) {
    const notFound = product.error instanceof ProblemError && product.error.slug === 'not-found';
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        {notFound ? (
          <EmptyState
            title="ไม่พบสินค้านี้"
            description="สินค้าอาจถูกนำออกจากร้านแล้ว ลองดูสินค้าอื่นในร้านแทน"
            action={{ label: 'กลับไปหน้าร้าน', href: '/' }}
          />
        ) : (
          <ErrorState
            error={product.error}
            onRetry={() => void product.refetch()}
          />
        )}
      </main>
    );
  }

  const data = product.data;
  // Default to the first variant that can be bought, so a shopper is never
  // pre-selected into a sold-out size.
  const selected =
    data.variants.find((v) => v.id === chosenId) ??
    data.variants.find((v) => v.availableStock > 0) ??
    data.variants[0];
  const soldOut = !selected || selected.availableStock <= 0;
  const image = data.images[imageIndex] ?? data.images[0];

  function addToCart() {
    if (!selected) return;
    add.mutate(
      { variantId: selected.id, quantity: 1 },
      {
        // Failure is reported by useAddToCart itself, like every basket change.
        onSuccess: () => toast.success(`เพิ่ม ${data.name} (${selected.name}) ลงตะกร้าแล้ว`),
      },
    );
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 lg:px-6">
      <nav aria-label="breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/" className="hover:underline">หน้าร้าน</Link>
        {data.categorySlug ? (
          <>
            <ChevronRight className="size-3" aria-hidden="true" />
            <Link to={`/?category=${data.categorySlug}`} className="hover:underline">
              หมวดหมู่
            </Link>
          </>
        ) : null}
        <ChevronRight className="size-3" aria-hidden="true" />
        <span className="truncate text-foreground">{data.name}</span>
      </nav>

      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="aspect-square overflow-hidden rounded-surface bg-muted">
            {image ? (
              <img src={image.url} alt={image.alt ?? data.name} className="size-full object-cover" />
            ) : null}
          </div>
          {data.images.length > 1 ? (
            <div className="flex gap-2">
              {data.images.map((img, index) => (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => setImageIndex(index)}
                  aria-label={`รูปที่ ${index + 1}`}
                  aria-pressed={index === imageIndex}
                  className={cn(
                    'size-16 overflow-hidden rounded-control border-2',
                    index === imageIndex ? 'border-primary' : 'border-transparent',
                  )}
                >
                  <img src={img.url} alt="" className="size-full object-cover" />
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold">{data.name}</h1>
            <p className="text-2xl">{selected ? formatPrice(selected.priceCents) : ''}</p>
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-medium">ตัวเลือก</legend>
            <div className="flex flex-wrap gap-2">
              {/* Buttons, not a <select>: every option and its availability is visible.
                  A sold-out option stays, disabled — a shopper looking for XL needs to
                  learn it is gone, not fail to find it. */}
              {data.variants.map((variant) => {
                const active = variant.id === selected?.id;
                const out = variant.availableStock <= 0;
                return (
                  <Button
                    key={variant.id}
                    type="button"
                    variant={active ? 'default' : 'outline'}
                    disabled={out}
                    aria-pressed={active}
                    onClick={() => setChosenId(variant.id)}
                    className={cn(out && 'line-through')}
                  >
                    {active ? <Check className="size-4" aria-hidden="true" /> : null}
                    {variant.name}
                  </Button>
                );
              })}
            </div>
            {selected ? <StockBadge available={selected.availableStock} /> : null}
          </fieldset>

          <Button size="lg" disabled={soldOut || add.isPending} onClick={addToCart}>
            {soldOut ? 'สินค้าหมด' : add.isPending ? 'กำลังเพิ่ม…' : 'เพิ่มลงตะกร้า'}
          </Button>

          <div className="flex flex-col gap-2 border-t border-border pt-6">
            <h2 className="text-sm font-medium">รายละเอียดสินค้า</h2>
            <p className="text-muted-foreground">{data.description}</p>
          </div>
        </div>
      </div>
    </main>
  );
}
