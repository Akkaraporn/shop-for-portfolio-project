import { Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';

import {
  type AdminProduct,
  useAdminProduct,
  useAdminProducts,
  useCreateProduct,
  useUpdateProduct,
} from '@/api/admin-hooks';
import { ProblemError, type Schemas } from '@/api/client';
import { useCategories } from '@/api/hooks';
import { describeError } from '@/api/problem-messages';
import { EmptyState } from '@/components/state/empty-state';
import { ErrorState } from '@/components/state/error-state';
import { LoadingAnnouncement, OrderRowSkeleton } from '@/components/state/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatPrice } from '@/lib/format';

type ProductStatus = Schemas['ProductStatus'];
type Category = Schemas['Category'];

const STATUS_LABEL: Record<ProductStatus, string> = {
  draft: 'ฉบับร่าง',
  active: 'วางขาย',
  archived: 'เก็บเข้าคลัง',
};

// --- list ------------------------------------------------------------------------

export function AdminProductsPage() {
  const [status, setStatus] = useState<ProductStatus | undefined>(undefined);
  const products = useAdminProducts(status);
  const items = products.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="กรองตามสถานะ" className="flex flex-wrap gap-2">
          {([undefined, 'active', 'draft', 'archived'] as const).map((value) => (
            <Button
              key={value ?? 'all'}
              role="tab"
              aria-selected={status === value}
              variant={status === value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatus(value)}
            >
              {value ? STATUS_LABEL[value] : 'ทั้งหมด'}
            </Button>
          ))}
        </div>
        <Button asChild>
          <Link to="/admin/products/new">
            <Plus className="size-4" aria-hidden="true" />
            เพิ่มสินค้า
          </Link>
        </Button>
      </div>

      {products.isPending ? (
        <div className="flex flex-col gap-2">
          <LoadingAnnouncement />
          <OrderRowSkeleton />
          <OrderRowSkeleton />
        </div>
      ) : products.isError ? (
        <ErrorState error={products.error} onRetry={() => void products.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title="ไม่มีสินค้าในสถานะนี้"
          description="เพิ่มสินค้าใหม่ หรือดูสินค้าทุกสถานะ"
          action={{ label: 'เพิ่มสินค้า', href: '/admin/products/new' }}
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-surface border border-border bg-card">
          {items.map((product) => (
            <li key={product.id}>
              <Link
                to={`/admin/products/${product.id}`}
                className="flex items-center justify-between gap-4 p-4 hover:bg-accent"
              >
                <span className="flex flex-col gap-1">
                  <span className="font-medium">{product.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {product.slug} · {product.variants.length} ตัวเลือก · เริ่ม{' '}
                    {formatPrice(product.minPriceCents)}
                  </span>
                </span>
                <Badge variant={product.status === 'active' ? 'default' : 'outline'}>
                  {STATUS_LABEL[product.status]}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}

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

// --- form --------------------------------------------------------------------------

/** The category tree, flattened for a select, with the depth shown by indentation. */
function flatten(nodes: Category[], depth = 0): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${'— '.repeat(depth)}${node.name}` },
    ...flatten(node.children ?? [], depth + 1),
  ]);
}

/** Baht as typed, to integer satang. The only place the admin UI converts money in. */
function toSatang(value: string): number {
  return Math.round(Number(value) * 100);
}

interface VariantDraft {
  key: number;
}

/** Field errors from a 422 or the slug's 409, keyed the way the inputs are named. */
function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!(error instanceof ProblemError)) return {};
  if (error.slug === 'conflict') {
    // A duplicate slug or SKU. The detail names which, in English; the field that
    // most often collides is the slug, which the admin can change on the spot.
    return { slug: 'slug หรือ SKU นี้ถูกใช้แล้ว ลองเปลี่ยนเป็นค่าอื่น' };
  }
  return Object.fromEntries((error.problem.errors ?? []).map((e) => [e.field, e.message]));
}

export function AdminProductNewPage() {
  return <ProductForm />;
}

export function AdminProductEditPage() {
  const { productId = '' } = useParams();
  const product = useAdminProduct(productId);

  if (product.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <LoadingAnnouncement />
        <OrderRowSkeleton />
      </div>
    );
  }
  if (product.isError) {
    return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  }
  return <ProductForm key={product.data.id} product={product.data} />;
}

/**
 * One form for a product and its variants, as the contract creates them: together,
 * in one request, so a product never exists with nothing to sell.
 *
 * Editing changes the product's own fields only — `PATCH /admin/products/{id}` does
 * not touch variants. Their stock is adjusted on the inventory page, by delta.
 */
function ProductForm({ product }: { product?: AdminProduct }) {
  const editing = product !== undefined;
  const navigate = useNavigate();
  const categories = useCategories();
  const create = useCreateProduct();
  const update = useUpdateProduct(product?.id ?? '');
  const mutation = editing ? update : create;

  const [variants, setVariants] = useState<VariantDraft[]>([{ key: 0 }]);
  const [nextKey, setNextKey] = useState(1);
  const [status, setStatus] = useState<ProductStatus>(product?.status ?? 'draft');

  const errors = fieldErrorsOf(mutation.error);
  const options = flatten(categories.data?.items ?? []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();

    const common = {
      slug: text('slug'),
      name: text('name'),
      description: text('description'),
      categoryId: text('categoryId'),
      status,
    };

    const onSuccess = (saved: AdminProduct) => {
      toast.success(editing ? 'บันทึกแล้ว' : `เพิ่ม “${saved.name}” แล้ว`);
      navigate('/admin/products');
    };
    const onError = (error: Error) => {
      if (!(error instanceof ProblemError) || error.slug !== 'validation-failed') {
        toast.error(describeError(error).message);
      }
    };

    if (editing) {
      update.mutate(common, { onSuccess, onError });
      return;
    }

    const imageUrls = text('imageUrls')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    create.mutate(
      {
        ...common,
        variants: variants.map((_, index) => ({
          sku: text(`variants[${index}].sku`),
          name: text(`variants[${index}].name`),
          priceCents: toSatang(text(`variants[${index}].price`)),
          stockOnHand: Number(text(`variants[${index}].stockOnHand`) || 0),
        })),
        ...(imageUrls.length > 0 ? { imageUrls } : {}),
      },
      { onSuccess, onError },
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-3xl flex-col gap-8" noValidate>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">
          {editing ? `แก้ไข ${product.name}` : 'เพิ่มสินค้า'}
        </h2>
        <Link to="/admin/products" className="text-sm text-primary hover:underline">
          กลับไปรายการสินค้า
        </Link>
      </div>

      <fieldset className="grid gap-4">
        <legend className="mb-2 text-lg font-medium">ข้อมูลสินค้า</legend>
        <Field name="name" label="ชื่อสินค้า" error={errors.name} defaultValue={product?.name} />
        <Field
          name="slug"
          label="Slug (ใช้ใน URL)"
          hint="ตัวพิมพ์เล็ก ตัวเลข และขีด เช่น linen-shirt"
          error={errors.slug}
          defaultValue={product?.slug}
        />
        <div className="grid gap-2">
          <Label htmlFor="description">รายละเอียด</Label>
          <textarea
            id="description"
            name="description"
            rows={4}
            defaultValue={product?.description}
            className="rounded-control border border-input bg-background px-3 py-2 text-sm"
          />
          <FieldError id="description" message={errors.description} />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="categoryId">หมวดหมู่</Label>
            <select
              id="categoryId"
              name="categoryId"
              defaultValue={product?.categoryId ?? ''}
              aria-invalid={errors.categoryId ? true : undefined}
              className="h-10 rounded-control border border-input bg-background px-3 text-sm"
            >
              <option value="" disabled>
                เลือกหมวดหมู่
              </option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <FieldError id="categoryId" message={errors.categoryId} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="status">สถานะ</Label>
            <select
              id="status"
              value={status}
              onChange={(event) => setStatus(event.target.value as ProductStatus)}
              className="h-10 rounded-control border border-input bg-background px-3 text-sm"
            >
              {(Object.keys(STATUS_LABEL) as ProductStatus[]).map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABEL[value]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {!editing ? (
          <div className="grid gap-2">
            <Label htmlFor="imageUrls">
              รูปภาพ <span className="text-muted-foreground">(URL บรรทัดละรูป ถ้ามี)</span>
            </Label>
            <textarea
              id="imageUrls"
              name="imageUrls"
              rows={2}
              placeholder="https://…"
              className="rounded-control border border-input bg-background px-3 py-2 font-mono text-sm"
            />
          </div>
        ) : null}
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-2 text-lg font-medium">ตัวเลือกสินค้า</legend>
        {editing ? (
          <>
            <ul className="flex flex-col divide-y divide-border rounded-surface border border-border">
              {product.variants.map((variant) => (
                <li key={variant.id} className="flex justify-between gap-4 p-3 text-sm">
                  <span>
                    {variant.name} <span className="font-mono text-xs">{variant.sku}</span>
                  </span>
                  <span>
                    {formatPrice(variant.priceCents)} · คงคลัง {variant.stockOnHand}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              สต็อกปรับได้ที่หน้า{' '}
              <Link to="/admin/inventory" className="text-primary hover:underline">
                คลังสินค้า
              </Link>
            </p>
          </>
        ) : (
          <>
            {variants.map((variant, index) => (
              <div
                key={variant.key}
                className="grid gap-3 rounded-surface border border-border p-4 sm:grid-cols-[1fr_1fr_8rem_6rem_auto] sm:items-start"
              >
                <Field
                  name={`variants[${index}].name`}
                  label="ชื่อตัวเลือก"
                  error={errors[`variants[${index}].name`]}
                />
                <Field
                  name={`variants[${index}].sku`}
                  label="SKU"
                  error={errors[`variants[${index}].sku`]}
                />
                <Field
                  name={`variants[${index}].price`}
                  label="ราคา (บาท)"
                  inputMode="decimal"
                  error={errors[`variants[${index}].priceCents`]}
                />
                <Field
                  name={`variants[${index}].stockOnHand`}
                  label="สต็อกเริ่มต้น"
                  inputMode="numeric"
                  defaultValue="0"
                  error={errors[`variants[${index}].stockOnHand`]}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="sm:mt-7"
                  aria-label={`ลบตัวเลือกที่ ${index + 1}`}
                  disabled={variants.length === 1}
                  onClick={() => setVariants(variants.filter((v) => v.key !== variant.key))}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
            <FieldError id="variants" message={errors.variants} />
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => {
                setVariants([...variants, { key: nextKey }]);
                setNextKey(nextKey + 1);
              }}
            >
              <Plus className="size-4" aria-hidden="true" />
              เพิ่มตัวเลือก
            </Button>
          </>
        )}
      </fieldset>

      <Button type="submit" size="lg" className="self-start" disabled={mutation.isPending}>
        {mutation.isPending ? 'กำลังบันทึก…' : editing ? 'บันทึกการแก้ไข' : 'เพิ่มสินค้า'}
      </Button>
    </form>
  );
}

function Field({
  name,
  label,
  hint,
  error,
  defaultValue,
  inputMode,
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  defaultValue?: string;
  inputMode?: 'decimal' | 'numeric';
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        defaultValue={defaultValue}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
      />
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <FieldError id={name} message={error} />
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={`${id}-error`} className="text-sm text-[var(--color-danger)]">
      {message}
    </p>
  ) : null;
}
