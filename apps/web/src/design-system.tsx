import { ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';

import { useHealth } from '@/api/meta';

import { EmptyCart, EmptyOrders, EmptySearch } from '@/components/state/empty-state';
import { ErrorState, OfflineState } from '@/components/state/error-state';
import {
  CartLineSkeleton,
  ProductDetailSkeleton,
  ProductGridSkeleton,
} from '@/components/state/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

/**
 * The design system, rendered.
 *
 * Not decoration: this page is how the tokens get checked. Rendering every colour,
 * radius, type size and state on one screen is the only way to notice that two
 * greys are nearly the same, or that a heading's leading clips Thai tone marks —
 * neither of which shows up in a config file.
 *
 * It stays in the app at `?design` after task 3.3 replaces the home page, because
 * the check is worth repeating whenever a token changes.
 */

/** A sentence built to break bad leading: stacked upper vowels, tone marks, and a
 *  lower vowel, all in one line. If the type scale is wrong, it shows here first. */
const THAI_STRESS_TEST = 'เสื้อยืดคอกลม สีน้ำเงิน ผ้าฝ้ายออร์แกนิก ใส่สบายทั้งวัน';

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className={`h-12 rounded-control border border-border ${className}`} />
      <code className="text-xs text-muted-foreground">{name}</code>
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold">{title}</h2>
        {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      </div>
      {children}
      <Separator className="mt-4" />
    </section>
  );
}

function BackendBadge() {
  const health = useHealth();

  if (health.isPending) {
    return <Badge variant="outline">กำลังเชื่อมต่อ API…</Badge>;
  }
  if (health.isError) {
    return <Badge variant="destructive">API ไม่ตอบสนอง</Badge>;
  }
  return (
    <Badge variant="secondary">
      backend: {health.data.implementation} {health.data.version}
    </Badge>
  );
}

export function DesignSystem() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-12 px-4 py-12 lg:px-6">
      <header className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Badge variant="secondary">task 3.0</Badge>
          <BackendBadge />
        </div>
        <h1 className="text-4xl font-semibold">ระบบดีไซน์ · Design system</h1>
        <p className="max-w-prose text-muted-foreground">
          ทุกโทเคน สี ระยะห่าง และสถานะที่ร้านนี้ใช้ อยู่ในหน้าเดียวกันทั้งหมด
          เพื่อให้เห็นตอนที่อะไรสักอย่างเพี้ยนไปจากกัน
        </p>
      </header>

      <Section
        title="ตัวอักษรภาษาไทย"
        note="IBM Plex Sans Thai — ไทยและละตินอยู่ในฟอนต์เดียวกัน line-height ของ body คือ 1.6 และหัวข้อไม่ต่ำกว่า 1.35"
      >
        <div className="flex flex-col gap-3 rounded-surface border border-border bg-card p-6">
          <p className="text-4xl font-semibold">{THAI_STRESS_TEST}</p>
          <p className="text-2xl font-medium">{THAI_STRESS_TEST}</p>
          <p className="text-base">{THAI_STRESS_TEST}</p>
          <p className="text-sm text-muted-foreground">{THAI_STRESS_TEST}</p>
          <p className="text-xs text-muted-foreground">{THAI_STRESS_TEST}</p>
          <Separator />
          <p className="text-base">
            Latin and ไทย in one sentence, 1,290.50 ฿ — the two scripts share a
            family, so the baseline and weight do not shift mid-line.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          ถ้าสระบน วรรณยุกต์ หรือสระล่างโดนตัด แปลว่า line-height แน่นเกินไป —
          ห้ามใช้ <code className="font-mono">leading-tight</code> หรือ{' '}
          <code className="font-mono">leading-none</code> ที่ไหนก็ตาม
        </p>
      </Section>

      <Section
        title="สี"
        note="neutral หนึ่งชุด, brand หนึ่งสี, semantic สามสี — ไม่มีมากกว่านี้"
      >
        <div className="grid grid-cols-4 gap-3 lg:grid-cols-11">
          {[50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => (
            <Swatch
              key={step}
              name={`neutral-${step}`}
              className={`bg-neutral-${step}`}
            />
          ))}
        </div>
        <div className="grid grid-cols-4 gap-3 lg:grid-cols-9">
          {[50, 100, 200, 300, 400, 500, 600, 700, 800].map((step) => (
            <Swatch key={step} name={`brand-${step}`} className={`bg-brand-${step}`} />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Swatch name="success" className="bg-[var(--color-success)]" />
          <Swatch name="warning" className="bg-[var(--color-warning)]" />
          <Swatch name="danger" className="bg-[var(--color-danger)]" />
        </div>
      </Section>

      <Section
        title="ปุ่มและสถานะ"
        note="รวมสถานะ disabled ซึ่งเป็นสิ่งที่ลืมกันบ่อยที่สุด — ปุ่มตอนสินค้าหมดต้องบอกได้ว่าทำไมกดไม่ได้"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button>เพิ่มลงตะกร้า</Button>
          <Button variant="secondary">ดูรายละเอียด</Button>
          <Button variant="outline">ล้างตัวกรอง</Button>
          <Button variant="ghost">ยกเลิก</Button>
          <Button variant="destructive">ลบออกจากตะกร้า</Button>
          <Button disabled>สินค้าหมด</Button>
          <Button size="sm">
            <ShoppingCart className="size-4" aria-hidden="true" />
            ตะกร้า
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge>พร้อมส่ง</Badge>
          <Badge variant="secondary">เหลือ 1 ชิ้น</Badge>
          <Badge variant="outline">รอชำระเงิน</Badge>
          <Badge variant="destructive">สินค้าหมด</Badge>
        </div>
      </Section>

      <Section title="ฟอร์ม" note="ทุก input มี label ที่เชื่อมกันจริง ไม่ใช่แค่ placeholder">
        <div className="grid max-w-md gap-4">
          <div className="grid gap-2">
            <Label htmlFor="ds-name">ชื่อผู้รับ</Label>
            <Input id="ds-name" placeholder="สมชาย ใจดี" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ds-zip">รหัสไปรษณีย์</Label>
            <Input id="ds-zip" inputMode="numeric" placeholder="10110" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ds-bad" className="text-[var(--color-danger)]">
              อีเมล
            </Label>
            <Input
              id="ds-bad"
              aria-invalid
              aria-describedby="ds-bad-error"
              defaultValue="not-an-email"
            />
            <p id="ds-bad-error" className="text-sm text-[var(--color-danger)]">
              กรุณากรอกอีเมลให้ถูกต้อง
            </p>
          </div>
        </div>
      </Section>

      <Section
        title="การ์ดสินค้า"
        note="รูปเป็นสี่เหลี่ยมจัตุรัสเสมอ เพื่อให้ grid ไม่กระตุกตอนรูปโหลดเสร็จ"
      >
        <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          {[
            { name: 'เสื้อยืดคอกลม ผ้าฝ้ายออร์แกนิก', price: '฿390', seed: 'crewneck-organic-tee' },
            { name: 'กระเป๋าผ้าแคนวาสสะพายไหล่', price: '฿590', seed: 'canvas-tote-bag' },
            { name: 'หม้อเหล็กหล่อเคลือบอีนาเมล', price: '฿2,490', seed: 'cast-iron-pot' },
            { name: 'ชุดมีดทำครัวสเตนเลส 3 ชิ้น', price: '฿1,890', seed: 'kitchen-knife-set', soldOut: true },
          ].map((product) => (
            <Card key={product.seed} className="overflow-hidden pt-0">
              <img
                src={`https://picsum.photos/seed/${product.seed}/600/600`}
                // Every image has real alt text: the product's name is what a screen
                // reader needs, not "product image".
                alt={product.name}
                className="aspect-square w-full object-cover"
                loading="lazy"
              />
              <CardContent className="flex flex-col gap-1">
                <p className="text-sm">{product.name}</p>
                <p className="text-sm font-medium">
                  {product.price}
                  {product.soldOut ? (
                    <span className="ml-2 text-muted-foreground">สินค้าหมด</span>
                  ) : null}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>

      <Section
        title="สถานะกำลังโหลด"
        note="โครงร่างที่มีรูปทรงเหมือนของจริง ไม่ใช่ spinner กลางจอ — หน้าจะได้ไม่กระตุกตอนข้อมูลมาถึง"
      >
        <ProductGridSkeleton count={4} />
        <Separator />
        <ProductDetailSkeleton />
        <Separator />
        <div className="flex flex-col gap-4">
          <CartLineSkeleton />
          <CartLineSkeleton />
        </div>
      </Section>

      <Section
        title="สถานะว่างเปล่า"
        note="ทุกอันมีทางออก — บอกว่าเกิดอะไรขึ้นและกดอะไรต่อได้"
      >
        <div className="grid gap-6 lg:grid-cols-3">
          <EmptyCart />
          <EmptySearch query="เสื้อกันหนาวขนเป็ด" />
          <EmptyOrders />
        </div>
      </Section>

      <Section title="สถานะผิดพลาด" note="แสดง traceId ไว้ให้ตามหาใน log ได้">
        <div className="grid gap-6 lg:grid-cols-2">
          <ErrorState
            traceId="a3f1c2b4-8d7e-4f21-9c3a-1b2d4e6f8a09"
            onRetry={() => toast.success('ลองใหม่แล้ว')}
          />
          <div className="rounded-surface border border-border bg-card">
            <OfflineState onRetry={() => toast.error('ยังเชื่อมต่อไม่ได้')} />
          </div>
        </div>
      </Section>

      <Section title="รัศมีและเงา" note="รัศมีสองค่า เงาสองระดับ จบ">
        <div className="flex flex-wrap gap-6">
          <Card className="w-56">
            <CardHeader>
              <CardTitle>surface · 12px</CardTitle>
              <CardDescription>การ์ด ชีต ไดอะล็อก</CardDescription>
            </CardHeader>
            <CardContent>
              <Button className="w-full">control · 6px</Button>
            </CardContent>
          </Card>
          <div className="flex w-56 items-center justify-center rounded-surface bg-card shadow-resting">
            <code className="py-10 text-xs text-muted-foreground">shadow-resting</code>
          </div>
          <div className="flex w-56 items-center justify-center rounded-surface bg-card shadow-lifted">
            <code className="py-10 text-xs text-muted-foreground">shadow-lifted</code>
          </div>
        </div>
      </Section>
    </main>
  );
}
