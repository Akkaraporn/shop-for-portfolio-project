import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Loading states shaped like the content they stand in for.
 *
 * A spinner in the middle of the page tells the reader only that something is
 * happening. A skeleton with the product grid's actual geometry tells them what is
 * coming and keeps the layout from jumping when it lands — which is the difference
 * between a page that feels fast and one that feels broken.
 *
 * Each skeleton mirrors a real component, so when that component's shape changes
 * this one has to change with it. That coupling is deliberate: a skeleton that has
 * drifted from its content is worse than none.
 */

export function ProductCardSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {/* Same square aspect as the real card's image, so nothing reflows. */}
      <Skeleton className="aspect-square w-full rounded-lg" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-2/5" />
    </div>
  );
}

export function ProductGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div
      className="grid grid-cols-2 gap-6 lg:grid-cols-4"
      // The grid is a placeholder, not content. Announcing it would read a list of
      // nothing to a screen reader; the live region on the real list handles the
      // "loaded" announcement.
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, index) => (
        <ProductCardSkeleton key={index} />
      ))}
    </div>
  );
}

export function ProductDetailSkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-2" aria-hidden="true">
      <Skeleton className="aspect-square w-full rounded-lg" />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-20 w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-10 w-20" />
          <Skeleton className="h-10 w-20" />
          <Skeleton className="h-10 w-20" />
        </div>
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}

export function CartLineSkeleton() {
  return (
    <div className="flex items-center gap-4" aria-hidden="true">
      <Skeleton className="size-20 shrink-0 rounded-lg" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-1/4" />
      </div>
      <Skeleton className="h-8 w-24" />
    </div>
  );
}

export function OrderRowSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('flex items-center justify-between gap-4 py-4', className)}
      aria-hidden="true"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-6 w-20" />
    </div>
  );
}

/**
 * The announcement that goes with any of the above.
 *
 * Skeletons are `aria-hidden`, so without this a screen reader is told nothing at
 * all while a page loads. One polite live region says it once.
 */
export function LoadingAnnouncement({ label = 'กำลังโหลด' }: { label?: string }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {label}
    </span>
  );
}
