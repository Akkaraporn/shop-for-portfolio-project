import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';

import { ProblemError, type Schemas } from '@/api/client';
import { useCategories, useProducts, type ProductFilters } from '@/api/hooks';
import { EmptySearch } from '@/components/state/empty-state';
import { ErrorState } from '@/components/state/error-state';
import { LoadingAnnouncement, ProductGridSkeleton } from '@/components/state/skeletons';
import { ProductCard } from '@/components/shop/shop-parts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const SORTS = [
  { value: 'newest', label: 'ใหม่ล่าสุด' },
  { value: 'price_asc', label: 'ราคา: ต่ำไปสูง' },
  { value: 'price_desc', label: 'ราคา: สูงไปต่ำ' },
  { value: 'name_asc', label: 'ชื่อ: ก–ฮ' },
] as const;

type Sort = (typeof SORTS)[number]['value'];

/**
 * The URL is the state. Filters live in the query string, not in component state, so a
 * refresh keeps them, a link can be shared, and Back returns to the previous filter —
 * which a shopper expects and local state silently breaks.
 *
 * Prices are typed in baht and sent in satang: the contract's money is integer minor
 * units (ADR-002), and the conversion happens at this one boundary.
 */
function readFilters(params: URLSearchParams): Omit<ProductFilters, 'cursor'> {
  const baht = (key: string) => {
    const value = Number(params.get(key));
    return params.get(key) && Number.isFinite(value) && value >= 0
      ? Math.round(value * 100)
      : undefined;
  };
  const sort = params.get('sort');

  return {
    q: params.get('q') || undefined,
    categorySlug: params.get('category') || undefined,
    minPriceCents: baht('min'),
    maxPriceCents: baht('max'),
    inStockOnly: params.get('inStock') === '1' ? true : undefined,
    sort: SORTS.some((s) => s.value === sort) ? (sort as Sort) : undefined,
    limit: 12,
  };
}

export function CatalogPage() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const products = useProducts(filters);
  const categories = useCategories();

  const items = products.data?.pages.flatMap((page) => page.items) ?? [];
  const activeCategory = findCategory(categories.data?.items ?? [], filters.categorySlug);

  function update(changes: Record<string, string | undefined>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next);
  }

  // Infinite scroll: load the next page when the sentinel comes into view. The button
  // below stays as a fallback, and as the keyboard-reachable way to do the same thing.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && products.hasNextPage && !products.isFetchingNextPage) {
        void products.fetchNextPage();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [products]);

  const filtersPanel = (
    <Filters
      categories={categories.data?.items ?? []}
      params={params}
      onChange={update}
      onClear={() => setParams(new URLSearchParams())}
    />
  );

  return (
    <main className="mx-auto flex max-w-6xl gap-8 px-4 py-8 lg:px-6">
      <aside className="hidden w-56 shrink-0 lg:block" aria-label="ตัวกรองสินค้า">
        {filtersPanel}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">
              {filters.q ? `ผลการค้นหา "${filters.q}"` : (activeCategory?.name ?? 'สินค้าทั้งหมด')}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="lg:hidden">
                  <SlidersHorizontal className="size-4" aria-hidden="true" />
                  ตัวกรอง
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="overflow-y-auto">
                <SheetHeader>
                  <SheetTitle>ตัวกรอง</SheetTitle>
                </SheetHeader>
                <div className="px-4">{filtersPanel}</div>
              </SheetContent>
            </Sheet>

            <Select
              value={filters.sort ?? 'newest'}
              onValueChange={(value) => update({ sort: value === 'newest' ? undefined : value })}
            >
              <SelectTrigger className="w-44" aria-label="เรียงลำดับ">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((sort) => (
                  <SelectItem key={sort.value} value={sort.value}>
                    {sort.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {products.isPending ? (
          <>
            <LoadingAnnouncement label="กำลังโหลดสินค้า" />
            <ProductGridSkeleton count={8} />
          </>
        ) : products.isError ? (
          <ErrorState
            traceId={products.error instanceof ProblemError ? products.error.traceId : undefined}
            onRetry={() => void products.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptySearch query={filters.q} onClear={() => setParams(new URLSearchParams())} />
        ) : (
          <>
            <ul
              className={cn(
                'grid grid-cols-2 gap-6 lg:grid-cols-4',
                // Dim rather than blank the grid while a new filter loads.
                products.isPlaceholderData && 'opacity-60 transition-opacity',
              )}
              aria-busy={products.isFetching}
            >
              {items.map((product) => (
                <li key={product.id}>
                  <ProductCard product={product} />
                </li>
              ))}
            </ul>

            {products.isFetchingNextPage ? <ProductGridSkeleton count={4} /> : null}

            <div ref={sentinel} className="flex justify-center">
              {products.hasNextPage ? (
                <Button
                  variant="outline"
                  disabled={products.isFetchingNextPage}
                  onClick={() => void products.fetchNextPage()}
                >
                  ดูเพิ่มเติม
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">แสดงครบ {items.length} รายการแล้ว</p>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function Filters({
  categories,
  params,
  onChange,
  onClear,
}: {
  categories: Schemas['Category'][];
  params: URLSearchParams;
  onChange: (changes: Record<string, string | undefined>) => void;
  onClear: () => void;
}) {
  const current = params.get('category');

  function onPrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onChange({ min: String(form.get('min') ?? ''), max: String(form.get('max') ?? '') });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">หมวดหมู่</h2>
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            <button
              type="button"
              className={cn('text-left hover:underline', !current && 'font-medium')}
              onClick={() => onChange({ category: undefined })}
            >
              ทั้งหมด
            </button>
          </li>
          {categories.map((category) => (
            <CategoryItem key={category.id} category={category} current={current} onChange={onChange} />
          ))}
        </ul>
      </div>

      <form onSubmit={onPrice} className="flex flex-col gap-2" key={params.toString()}>
        <h2 className="text-sm font-medium">ราคา (บาท)</h2>
        <div className="flex items-center gap-2">
          <Label htmlFor="price-min" className="sr-only">ราคาต่ำสุด</Label>
          <Input id="price-min" name="min" inputMode="numeric" placeholder="ต่ำสุด" defaultValue={params.get('min') ?? ''} />
          <span aria-hidden="true">–</span>
          <Label htmlFor="price-max" className="sr-only">ราคาสูงสุด</Label>
          <Input id="price-max" name="max" inputMode="numeric" placeholder="สูงสุด" defaultValue={params.get('max') ?? ''} />
        </div>
        <Button type="submit" variant="secondary" size="sm">
          ใช้ช่วงราคา
        </Button>
      </form>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-[var(--color-brand-600)]"
          checked={params.get('inStock') === '1'}
          onChange={(event) => onChange({ inStock: event.target.checked ? '1' : undefined })}
        />
        เฉพาะสินค้าที่มีของ
      </label>

      <Button variant="outline" size="sm" onClick={onClear}>
        ล้างตัวกรองทั้งหมด
      </Button>
    </div>
  );
}

function CategoryItem({
  category,
  current,
  onChange,
  depth = 0,
}: {
  category: Schemas['Category'];
  current: string | null;
  onChange: (changes: Record<string, string | undefined>) => void;
  depth?: number;
}) {
  return (
    <li>
      <button
        type="button"
        style={{ paddingLeft: `${depth * 0.75}rem` }}
        className={cn('text-left hover:underline', current === category.slug && 'font-medium text-primary')}
        onClick={() => onChange({ category: category.slug })}
      >
        {category.name}
      </button>
      {category.children?.length ? (
        <ul className="mt-1 flex flex-col gap-1">
          {category.children.map((child) => (
            <CategoryItem key={child.id} category={child} current={current} onChange={onChange} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function findCategory(
  nodes: Schemas['Category'][],
  slug: string | undefined,
): Schemas['Category'] | undefined {
  for (const node of nodes) {
    if (node.slug === slug) return node;
    const found = findCategory(node.children ?? [], slug);
    if (found) return found;
  }
  return undefined;
}
