import { AlertTriangle } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { ProblemError, type Schemas } from '@/api/client';
import { useCart, useCheckout } from '@/api/hooks';
import { EmptyCart } from '@/components/state/empty-state';
import { ErrorState } from '@/components/state/error-state';
import { CartLineSkeleton, LoadingAnnouncement } from '@/components/state/skeletons';
import { CartLine, OrderSummary, isShort } from '@/components/shop/shop-parts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

type Address = Schemas['Address'];

const ADDRESS_FIELDS: {
  name: keyof Address;
  label: string;
  autoComplete: string;
  optional?: boolean;
  inputMode?: 'numeric' | 'tel';
}[] = [
  { name: 'recipientName', label: 'ชื่อผู้รับ', autoComplete: 'name' },
  { name: 'phone', label: 'เบอร์โทรศัพท์', autoComplete: 'tel', inputMode: 'tel' },
  { name: 'line1', label: 'ที่อยู่', autoComplete: 'address-line1' },
  { name: 'line2', label: 'ที่อยู่ (เพิ่มเติม)', autoComplete: 'address-line2', optional: true },
  { name: 'city', label: 'เขต / อำเภอ', autoComplete: 'address-level2' },
  { name: 'province', label: 'จังหวัด', autoComplete: 'address-level1' },
  { name: 'postalCode', label: 'รหัสไปรษณีย์', autoComplete: 'postal-code', inputMode: 'numeric' },
];

export function CheckoutPage() {
  const cart = useCart();
  const checkout = useCheckout();
  const navigate = useNavigate();

  /**
   * The idempotency key belongs to this *attempt to buy*, not to a click.
   *
   * Generated once when the page mounts. A double-click, or a retry after a timeout,
   * sends the same key and the server replays the first order instead of creating a
   * second — the whole reason task 2.5 built the key store. Generating it inside the
   * submit handler would give every click a fresh key and make all of that worthless.
   *
   * A new key comes only from a new attempt: leaving to edit the basket and coming back
   * remounts the page.
   */
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'promptpay'>('card');

  /**
   * A synchronous guard against a second submit, alongside the key.
   *
   * `checkout.isPending` is React state and does not change until the next render, so
   * several submits in one tick all see it false. They would all reach the server with
   * the same key — which is safe, one order — but TanStack reports only the *latest*
   * `mutate()` to its per-call callbacks. When that latest one is answered
   * `409 checkout-in-progress`, the shopper is shown an error over a basket the winning
   * request has just emptied, and never reaches their order. Found by the e2e suite.
   * A ref is read synchronously, so exactly one request leaves this tab.
   */
  const submitting = useRef(false);

  const problem = checkout.error instanceof ProblemError ? checkout.error : null;

  // A 409 names every short line at once (task 2.5). Highlight exactly those, rather
  // than a toast saying "not enough stock" that leaves the shopper guessing which.
  const shortVariants =
    problem?.slug === 'insufficient-stock'
      ? new Map((problem.problem.errors ?? []).map((e) => [e.variantId, e]))
      : new Map();

  const fieldErrors: Record<string, string> =
    problem?.slug === 'validation-failed'
      ? Object.fromEntries(
          (problem.problem.errors ?? []).map((e) => [e.field.replace('shippingAddress.', ''), e.message]),
        )
      : {};

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;

    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();

    const shippingAddress: Address = {
      recipientName: value('recipientName'),
      phone: value('phone'),
      line1: value('line1'),
      ...(value('line2') ? { line2: value('line2') } : {}),
      city: value('city'),
      province: value('province'),
      postalCode: value('postalCode'),
      country: 'TH',
    };

    const body = {
      shippingAddress,
      paymentMethod,
      ...(value('note') ? { note: value('note') } : {}),
    };

    const attempt = (retriesLeft: number) =>
      checkout.mutate(
        { body, idempotencyKey },
        {
          onSuccess: (order) => navigate(`/orders/${order.orderNumber}`, { replace: true }),
          onError: (error) => {
            // Another request with this same key is still running — most likely a
            // retry from a flaky connection, or this page in a second tab. Asking again
            // with the same key a moment later gets the finished order replayed, rather
            // than showing an error over a basket that request is emptying.
            if (
              error instanceof ProblemError &&
              error.slug === 'checkout-in-progress' &&
              retriesLeft > 0
            ) {
              setTimeout(() => attempt(retriesLeft - 1), 1000);
              return;
            }
            submitting.current = false;
            // The basket may have changed underneath us; show what is true now.
            void cart.refetch();
          },
        },
      );

    attempt(5);
  }

  if (cart.isPending) {
    return (
      <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8">
        <LoadingAnnouncement />
        <CartLineSkeleton />
      </main>
    );
  }

  if (cart.isError) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <ErrorState onRetry={() => void cart.refetch()} />
      </main>
    );
  }

  if (cart.data.items.length === 0) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <EmptyCart onBrowse={() => navigate('/')} />
      </main>
    );
  }

  const blocked = cart.data.items.some(isShort);

  return (
    <main className="mx-auto grid max-w-5xl gap-8 px-4 py-8 lg:grid-cols-[1fr_22rem]">
      <form id="checkout-form" onSubmit={onSubmit} className="flex flex-col gap-8" noValidate>
        <h1 className="text-2xl font-semibold">ชำระเงิน</h1>

        {problem?.slug === 'insufficient-stock' ? (
          <div role="alert" className="flex gap-3 rounded-surface border border-[var(--color-warning)] bg-[var(--color-warning-bg)] p-4 text-sm">
            <AlertTriangle className="size-5 shrink-0 text-[var(--color-warning)]" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">
                มีสินค้า {shortVariants.size} รายการที่เหลือไม่พอสำหรับคำสั่งซื้อนี้
              </p>
              <p>
                รายการที่มีปัญหาถูกไฮไลต์ไว้ด้านขวา ปรับจำนวนแล้วกดยืนยันอีกครั้ง
              </p>
            </div>
          </div>
        ) : problem && problem.slug !== 'validation-failed' ? (
          <ErrorState
            title="สั่งซื้อไม่สำเร็จ"
            description="ยังไม่มีการสร้างคำสั่งซื้อ ลองกดยืนยันอีกครั้งได้เลย"
            traceId={problem.traceId}
          />
        ) : null}

        <fieldset className="grid gap-4">
          <legend className="mb-2 text-lg font-medium">ที่อยู่จัดส่ง</legend>
          {ADDRESS_FIELDS.map((field) => (
            <div key={field.name} className="grid gap-2">
              <Label htmlFor={field.name}>
                {field.label}
                {field.optional ? <span className="text-muted-foreground"> (ถ้ามี)</span> : null}
              </Label>
              <Input
                id={field.name}
                name={field.name}
                autoComplete={field.autoComplete}
                inputMode={field.inputMode}
                aria-invalid={fieldErrors[field.name] ? true : undefined}
                aria-describedby={fieldErrors[field.name] ? `${field.name}-error` : undefined}
              />
              {fieldErrors[field.name] ? (
                <p id={`${field.name}-error`} className="text-sm text-[var(--color-danger)]">
                  {fieldErrors[field.name]}
                </p>
              ) : null}
            </div>
          ))}
        </fieldset>

        <fieldset className="grid gap-3">
          <legend className="mb-2 text-lg font-medium">วิธีชำระเงิน</legend>
          <RadioGroup
            value={paymentMethod}
            onValueChange={(v) => setPaymentMethod(v as 'card' | 'promptpay')}
            className="grid gap-2 sm:grid-cols-2"
          >
            {[
              { value: 'card', label: 'บัตรเครดิต / เดบิต' },
              { value: 'promptpay', label: 'พร้อมเพย์' },
            ].map((option) => (
              <Label
                key={option.value}
                htmlFor={`pay-${option.value}`}
                className="flex cursor-pointer items-center gap-3 rounded-control border border-border p-4 has-[:checked]:border-primary"
              >
                <RadioGroupItem id={`pay-${option.value}`} value={option.value} />
                {option.label}
              </Label>
            ))}
          </RadioGroup>
        </fieldset>

        <div className="grid gap-2">
          <Label htmlFor="note">
            หมายเหตุถึงร้าน <span className="text-muted-foreground">(ถ้ามี)</span>
          </Label>
          <Input id="note" name="note" maxLength={500} />
        </div>
      </form>

      <aside className="flex h-fit flex-col gap-4 rounded-surface border border-border bg-card p-6 lg:sticky lg:top-24">
        <h2 className="font-medium">สรุปคำสั่งซื้อ</h2>
        <ul className="flex flex-col gap-2">
          {cart.data.items.map((line) => (
            <CartLine key={line.id} line={line} compact highlighted={shortVariants.has(line.variantId)} />
          ))}
        </ul>
        <OrderSummary subtotalCents={cart.data.subtotalCents} />
        <p className="text-xs text-muted-foreground">
          ค่าจัดส่งแบบเหมาจ่าย จะแสดงในคำสั่งซื้อหลังกดยืนยัน
        </p>
        <Button
          type="submit"
          form="checkout-form"
          size="lg"
          // Disabled while in flight so a double-click cannot even send twice — and if
          // it somehow did, the shared key would make the second a replay.
          disabled={checkout.isPending || blocked}
        >
          {checkout.isPending ? 'กำลังสร้างคำสั่งซื้อ…' : 'ยืนยันการสั่งซื้อ'}
        </Button>
        <Link to="/cart" className="text-center text-sm text-primary hover:underline">
          กลับไปแก้ไขตะกร้า
        </Link>
      </aside>
    </main>
  );
}
