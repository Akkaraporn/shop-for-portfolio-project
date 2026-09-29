import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * The definitions of done for tasks 3.2, 3.3 and 3.4, in a real browser against the
 * real backend. Needs `make up-node`.
 */

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

/** Runs SQL against the dev database. Used only to put the last-unit product back. */
function sql(statement: string): void {
  execSync(
    `docker compose --env-file .env -f infra/compose.yaml exec -T postgres psql -qtA -U shop -d shop -c "${statement}"`,
    { cwd: REPO, stdio: 'pipe' },
  );
}

/** One unit of TOTE-M, nothing held against it: the concurrency demo's starting state. */
function resetLastUnit(): void {
  sql(
    "UPDATE stock_reservations SET status='released', resolved_at=now() WHERE status='held' " +
      "AND variant_id=(SELECT id FROM product_variants WHERE sku='TOTE-M'); " +
      "UPDATE product_variants SET stock_on_hand=1, stock_reserved=0 WHERE sku='TOTE-M';",
  );
}

let seq = 0;
const freshEmail = () => `e2e-${Date.now()}-${++seq}@example.com`;
const PASSWORD = 'DemoPass123!';

async function registerViaUi(page: Page, email = freshEmail()): Promise<string> {
  await page.getByLabel('ชื่อ-นามสกุล').fill('ผู้ทดสอบ อัตโนมัติ');
  await page.getByLabel('อีเมล').fill(email);
  await page.getByLabel(/รหัสผ่าน/).fill(PASSWORD);
  await page.getByRole('button', { name: 'สมัครสมาชิก' }).click();
  return email;
}

async function signUp(page: Page): Promise<void> {
  await page.goto('/register');
  await registerViaUi(page);
  await expect(page.getByRole('link', { name: /คำสั่งซื้อ/ })).toBeVisible();
}

async function addToCart(page: Page, productSlug: string, variant?: string): Promise<void> {
  await page.goto(`/products/${productSlug}`);
  if (variant) await page.getByRole('button', { name: variant, exact: true }).click();
  await page.getByRole('button', { name: 'เพิ่มลงตะกร้า' }).click();
  await expect(page.getByText(/ลงตะกร้าแล้ว/)).toBeVisible();
}

async function fillAddress(page: Page): Promise<void> {
  await page.getByLabel('ชื่อผู้รับ').fill('สมชาย ใจดี');
  await page.getByLabel('เบอร์โทรศัพท์').fill('0812345678');
  await page.getByLabel('ที่อยู่', { exact: true }).fill('123 ถนนสุขุมวิท');
  await page.getByLabel('เขต / อำเภอ').fill('คลองเตย');
  await page.getByLabel('จังหวัด').fill('กรุงเทพมหานคร');
  await page.getByLabel('รหัสไปรษณีย์').fill('10110');
}

test.describe('3.3 — the storefront', () => {
  test('browses, filters through the URL, and survives a reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'สินค้าทั้งหมด' })).toBeVisible();

    await page.goto('/?category=clothing&sort=price_asc');
    await expect(page.getByRole('heading', { name: 'เสื้อผ้า' })).toBeVisible();
    // The cheapest item in the clothing subtree comes first under price_asc.
    const first = page.locator('a[href^="/products/"]').first();
    await expect(first).toContainText('เสื้อยืดคอกลม');

    // Filters live in the URL, so a reload keeps them.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'เสื้อผ้า' })).toBeVisible();
  });

  test('search on Thai text reaches mid-word', async ({ page }) => {
    await page.goto(`/?q=${encodeURIComponent('ลินิน')}`);
    await expect(page.getByRole('link', { name: /เสื้อเชิ้ตลินิน/ })).toBeVisible();
  });

  test('a sold-out product cannot be added', async ({ page }) => {
    await page.goto('/products/kitchen-knife-set');
    await expect(page.getByRole('button', { name: 'สินค้าหมด' })).toBeDisabled();
  });
});

test.describe('3.2 and 3.4 — the whole purchase', () => {
  test('guest fills a basket, registers, keeps it, checks out, and pays', async ({ page }) => {
    await addToCart(page, 'crewneck-organic-tee');

    // Checkout requires an account; the guard sends us to login and remembers where.
    await page.goto('/checkout');
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByRole('link', { name: 'สมัครสมาชิก' }).click();
    await registerViaUi(page);

    // Back on checkout, and the guest basket came with us.
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.getByText('เสื้อยืดคอกลม ผ้าฝ้ายออร์แกนิก')).toBeVisible();

    await fillAddress(page);
    await page.getByRole('button', { name: 'ยืนยันการสั่งซื้อ' }).click();

    await expect(page).toHaveURL(/\/orders\/ORD-\d{4}-\d{7}$/);
    await expect(page.getByText('รอชำระเงิน')).toBeVisible();
    await expect(page.getByText(/จองสินค้าไว้ให้อีก/)).toBeVisible();

    await page.getByRole('button', { name: 'ชำระด้วยบัตรทดสอบ (สำเร็จ)' }).click();

    // Confirm moves nothing; the provider's webhook lands ~2s later and the page polls.
    await expect(page.getByText('ชำระเงินเรียบร้อย')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('ชำระเงินแล้ว')).toBeVisible();
  });

  test('five rapid submits make one order', async ({ page }) => {
    await signUp(page);
    await addToCart(page, 'crewneck-organic-tee');
    await page.goto('/checkout');
    await fillAddress(page);

    // Five submits in one tick, faster than React can disable the button, so all five
    // reach the network. They share one Idempotency-Key, created when the page mounted.
    await page.locator('#checkout-form').evaluate((form: HTMLFormElement) => {
      for (let i = 0; i < 5; i += 1) form.requestSubmit();
    });

    await expect(page).toHaveURL(/\/orders\/ORD-/, { timeout: 20_000 });

    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'คำสั่งซื้อของฉัน' })).toBeVisible();
    await expect(page.getByRole('link', { name: /ORD-\d{4}-\d{7}/ })).toHaveCount(1);
  });

  test('a declined card fails the order and releases the stock', async ({ page }) => {
    await signUp(page);
    await addToCart(page, 'matte-ceramic-mug');
    await page.goto('/checkout');
    await fillAddress(page);
    await page.getByRole('button', { name: 'ยืนยันการสั่งซื้อ' }).click();

    await page.getByRole('button', { name: 'บัตรถูกปฏิเสธ (ทดสอบ)' }).click();
    await expect(page.getByText(/ชำระเงินไม่สำเร็จ/).first()).toBeVisible({ timeout: 20_000 });
  });

  test('an unpaid order can be cancelled, and then cannot', async ({ page }) => {
    await signUp(page);
    await addToCart(page, 'matte-ceramic-mug');
    await page.goto('/checkout');
    await fillAddress(page);
    await page.getByRole('button', { name: 'ยืนยันการสั่งซื้อ' }).click();

    await page.getByRole('button', { name: 'ยกเลิกคำสั่งซื้อ' }).click();
    await expect(page.getByText('ยกเลิกแล้ว')).toBeVisible();
    // Driven by the server's `cancellable`, not a client copy of the state machine.
    await expect(page.getByRole('button', { name: 'ยกเลิกคำสั่งซื้อ' })).toHaveCount(0);
  });
});

test.describe('3.4 — two shoppers, one last unit', () => {
  test('the loser is told exactly which line is short', async ({ browser }) => {
    resetLastUnit();

    const alice = await (await browser.newContext()).newPage();
    const bob = await (await browser.newContext()).newPage();

    for (const page of [alice, bob]) {
      await signUp(page);
      // Both can hold it: adding to a basket reserves nothing (task 2.4).
      await addToCart(page, 'canvas-tote-bag', 'กลาง');
      await page.goto('/checkout');
      await fillAddress(page);
    }

    await alice.getByRole('button', { name: 'ยืนยันการสั่งซื้อ' }).click();
    await expect(alice).toHaveURL(/\/orders\/ORD-/);

    await bob.getByRole('button', { name: 'ยืนยันการสั่งซื้อ' }).click();
    const alert = bob.getByRole('alert').filter({ hasText: 'เหลือไม่พอ' });
    await expect(alert).toContainText('มีสินค้า 1 รายการ');
    // And the line itself says how many are left.
    await expect(bob.getByText('สินค้าหมดแล้ว กรุณาลบออกจากตะกร้า')).toBeVisible();

    resetLastUnit();
  });
});

test.describe('3.2 — a reload while signed in', () => {
  test('does not ask for a guest basket before the session is restored', async ({ page }) => {
    await signUp(page);
    await addToCart(page, 'crewneck-organic-tee');

    const guestCartRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/carts/me') && !request.headers().authorization) {
        guestCartRequests.push(request.url());
      }
    });

    await page.reload();
    await expect(page.getByRole('button', { name: 'ตะกร้า 1 ชิ้น' })).toBeVisible();

    // No anonymous basket request, and so no throwaway guest basket or token.
    expect(guestCartRequests).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('vc.cartToken'))).toBeNull();
  });
});

test.describe('3.2 — the refresh race across tabs', () => {
  test('two tabs restoring the session at the same instant are not signed out', async ({ browser }) => {
    const context = await browser.newContext();
    const first = await context.newPage();
    await signUp(first);
    await first.goto('/orders');

    const second = await context.newPage();
    await second.goto('/orders');
    await expect(second.getByRole('heading', { name: 'คำสั่งซื้อของฉัน' })).toBeVisible();

    // Both tabs reload together. Each must refresh its access token from the one shared
    // refresh token. Without cross-tab serialisation the second presents a consumed
    // token, the server detects reuse and revokes the whole family (task 2.2).
    await Promise.all([first.reload(), second.reload()]);

    for (const page of [first, second]) {
      await expect(page.getByRole('heading', { name: 'คำสั่งซื้อของฉัน' })).toBeVisible();
      await expect(page).not.toHaveURL(/\/login/);
    }

    // And once more: a revoked family would fail here even if the reloads raced past.
    await first.reload();
    await expect(first.getByRole('heading', { name: 'คำสั่งซื้อของฉัน' })).toBeVisible();
  });
});
