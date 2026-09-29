import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * Task 3.5's back office, in a real browser against the real backend. Needs
 * `make up-node`.
 */

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const RUN = Date.now().toString(36);

function sql(statement: string): void {
  execSync(
    `docker compose --env-file .env -f infra/compose.yaml exec -T postgres psql -qtA -U shop -d shop -c "${statement}"`,
    { cwd: REPO, stdio: 'pipe' },
  );
}

// Products made here are real rows in the demo catalogue. Nothing orders them, so
// they are removed outright rather than archived and left lying around.
test.afterAll(() => {
  const mine = `SELECT id FROM products WHERE slug LIKE 'e2e-${RUN}%'`;
  const variants = `SELECT id FROM product_variants WHERE product_id IN (${mine})`;
  sql(
    [
      `DELETE FROM outbox_events WHERE aggregate_id IN (${variants})`,
      `DELETE FROM cart_items WHERE variant_id IN (${variants})`,
      `DELETE FROM product_images WHERE product_id IN (${mine})`,
      `DELETE FROM product_variants WHERE product_id IN (${mine})`,
      `DELETE FROM products WHERE slug LIKE 'e2e-${RUN}%'`,
    ].join('; '),
  );
});

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('อีเมล').fill('admin@vibecode.shop');
  await page.getByLabel('รหัสผ่าน').fill('DemoPass123!');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByRole('link', { name: 'หลังร้าน' })).toBeVisible();
}

async function register(page: Page, name: string, email: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('ชื่อ-นามสกุล').fill(name);
  await page.getByLabel('อีเมล').fill(email);
  await page.getByLabel(/รหัสผ่าน/).fill('DemoPass123!');
  await page.getByRole('button', { name: 'สมัครสมาชิก' }).click();
  await expect(page.getByRole('link', { name: /คำสั่งซื้อ/ })).toBeVisible();
}

async function createProduct(page: Page, slug: string, stock = '4'): Promise<void> {
  await page.goto('/admin/products/new');
  await page.getByLabel('ชื่อสินค้า').fill(`ผ้าพันคอ ${slug}`);
  await page.getByLabel('Slug (ใช้ใน URL)').fill(slug);
  await page.getByLabel('รายละเอียด').fill('ผ้าฝ้ายทอมือ');
  await page.locator('#categoryId').selectOption({ label: 'เสื้อผ้า' });
  await page.locator('#status').selectOption('active');

  await page.locator('[id="variants[0].name"]').fill('ครีม');
  await page.locator('[id="variants[0].sku"]').fill(`${slug}-CRM`.toUpperCase());
  await page.locator('[id="variants[0].price"]').fill('290.50');
  await page.locator('[id="variants[0].stockOnHand"]').fill(stock);

  await page.getByRole('button', { name: 'เพิ่มตัวเลือก' }).click();
  await page.locator('[id="variants[1].name"]').fill('กรม');
  await page.locator('[id="variants[1].sku"]').fill(`${slug}-NVY`.toUpperCase());
  await page.locator('[id="variants[1].price"]').fill('250');

  await page.getByRole('button', { name: 'เพิ่มสินค้า', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/products$/);
}

test('a customer who opens /admin is told it is not for them', async ({ page }) => {
  await register(page, 'ลูกค้า ทั่วไป', `e2e-cust-${RUN}@example.com`);

  await page.goto('/admin');
  await expect(page.getByText('หน้านี้สำหรับผู้ดูแลร้าน')).toBeVisible();
  await expect(page.getByRole('link', { name: 'หลังร้าน' })).toHaveCount(0);
});

test('a product created with its variants is on sale at once, cheapest first', async ({
  page,
}) => {
  await signInAsAdmin(page);
  const slug = `e2e-${RUN}-scarf`;
  await createProduct(page, slug);

  await page.goto(`/products/${slug}`);
  await expect(page.getByRole('heading', { name: `ผ้าพันคอ ${slug}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'กรม', exact: true })).toBeVisible();

  // And it is in the catalogue listing, priced from its cheapest variant — the
  // min_price_cents the admin API set on create, which sort=price_asc reads.
  await page.goto(`/?q=${slug}`);
  await expect(page.locator('a[href^="/products/"]').first()).toContainText('฿250');
});

test('a duplicate slug is reported on the slug field', async ({ page }) => {
  await signInAsAdmin(page);
  const slug = `e2e-${RUN}-dupe`;
  await createProduct(page, slug);

  await page.goto('/admin/products/new');
  await page.getByLabel('ชื่อสินค้า').fill('ซ้ำ');
  await page.getByLabel('Slug (ใช้ใน URL)').fill(slug);
  await page.locator('#categoryId').selectOption({ label: 'เสื้อผ้า' });
  await page.locator('[id="variants[0].name"]').fill('เดียว');
  await page.locator('[id="variants[0].sku"]').fill(`${slug}-X`.toUpperCase());
  await page.locator('[id="variants[0].price"]').fill('100');
  await page.getByRole('button', { name: 'เพิ่มสินค้า', exact: true }).click();

  await expect(page.getByText('slug หรือ SKU นี้ถูกใช้แล้ว', { exact: false })).toBeVisible();
});

test('inventory moves stock by delta, and refuses what would promise missing units', async ({
  page,
}) => {
  await signInAsAdmin(page);
  const slug = `e2e-${RUN}-stock`;
  await createProduct(page, slug, '4');
  const sku = `${slug}-CRM`.toUpperCase();

  await page.goto('/admin/inventory');
  const row = page.getByRole('row').filter({ hasText: sku });
  await row.getByRole('button', { name: `เพิ่ม ${sku} 1 ชิ้น` }).click();
  await expect(page.getByText(`${sku}: คงคลัง 5 ชิ้น`)).toBeVisible();

  await row.getByRole('button', { name: 'ระบุจำนวน' }).click();
  await row.getByLabel('เพิ่ม/ลด').fill('-999');
  await row.getByLabel('เหตุผล').fill('ทดสอบ');
  await row.getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.getByText(/ลดไม่ได้/)).toBeVisible();
});

test('the order queue offers only the next step, as the server says', async ({ browser }) => {
  // A shopper buys and pays.
  const shopper = await (await browser.newContext()).newPage();
  await register(shopper, 'ผู้ซื้อ คิวงาน', `e2e-queue-${RUN}@example.com`);
  await shopper.goto('/products/matte-ceramic-mug');
  await shopper.getByRole('button', { name: 'เพิ่มลงตะกร้า' }).click();
  await expect(shopper.getByText(/ลงตะกร้าแล้ว/)).toBeVisible();
  await shopper.goto('/checkout');
  await shopper.getByLabel('ชื่อผู้รับ').fill('ผู้ซื้อ คิวงาน');
  await shopper.getByLabel('เบอร์โทรศัพท์').fill('0812345678');
  await shopper.getByLabel('ที่อยู่', { exact: true }).fill('9 ถนนพระราม 4');
  await shopper.getByLabel('เขต / อำเภอ').fill('ปทุมวัน');
  await shopper.getByLabel('จังหวัด').fill('กรุงเทพมหานคร');
  await shopper.getByLabel('รหัสไปรษณีย์').fill('10330');
  await shopper.getByRole('button', { name: 'ยืนยันการสั่งซื้อ' }).click();
  await expect(shopper).toHaveURL(/\/orders\/ORD-/);
  const orderNumber = shopper.url().split('/').pop()!;
  await shopper.getByRole('button', { name: 'ชำระด้วยบัตรทดสอบ (สำเร็จ)' }).click();
  await expect(shopper.getByText('ชำระเงินเรียบร้อย', { exact: false })).toBeVisible({
    timeout: 20_000,
  });

  // The admin finds it waiting to ship, and is offered exactly one move.
  const admin = await (await browser.newContext()).newPage();
  await signInAsAdmin(admin);
  await admin.goto('/admin/orders');
  const row = () => admin.getByRole('listitem').filter({ hasText: orderNumber });
  await row().getByRole('button', { name: 'เปลี่ยนสถานะ' }).click();
  const moves = admin.getByRole('dialog').getByRole('button', { name: /เปลี่ยนเป็น/ });
  await expect(moves).toHaveText(['เปลี่ยนเป็น “จัดส่งแล้ว”']);
  await moves.click();
  await expect(admin.getByText(`${orderNumber}: จัดส่งแล้ว`)).toBeVisible();

  // From fulfilled, the server offers "completed" and nothing else.
  await admin.getByRole('tab', { name: 'จัดส่งแล้ว' }).click();
  await row().getByRole('button', { name: 'เปลี่ยนสถานะ' }).click();
  await expect(moves).toHaveText(['เปลี่ยนเป็น “สำเร็จ”']);

  // And the shopper's own page follows.
  await shopper.reload();
  await expect(shopper.getByText('จัดส่งแล้ว').first()).toBeVisible();
});
