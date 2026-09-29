# Wireframes

Four pages, laid out before the editor was opened. The purpose is to have **decided**
the layout, not to have a pretty picture — deciding layout while writing JSX is where
rework comes from.

Text rather than Figma on purpose: these live next to the code, diff when they change,
and need no account to open. Roughly fifteen minutes each.

Breakpoints: **mobile** `< 640px`, **desktop** `>= 1024px`. No tablet layout.

---

## 1. Catalogue

```
DESKTOP  >= 1024px
┌──────────────────────────────────────────────────────────────────────────┐
│ LOGO   เสื้อผ้า  ของใช้ในบ้าน  กระเป๋า        [ ค้นหา… ]   บัญชี   ตะกร้า(2) │
├────────────────┬─────────────────────────────────────────────────────────┤
│ หมวดหมู่        │  เสื้อผ้า · 7 รายการ            [ เรียง: ใหม่ล่าสุด  ▾ ] │
│  ▸ เสื้อยืด     │                                                          │
│  ▸ เสื้อเชิ้ต   │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐            │
│  ▸ กางเกง      │  │ [รูป]  │ │ [รูป]  │ │ [รูป]  │ │ [รูป]  │            │
│                │  │ 1:1    │ │ 1:1    │ │ 1:1    │ │ 1:1    │            │
│ ราคา           │  ├────────┤ ├────────┤ ├────────┤ ├────────┤            │
│  [ต่ำสุด][สูงสุด]│  │ ชื่อ    │ │ ชื่อ    │ │ ชื่อ    │ │ ชื่อ    │            │
│                │  │ ฿390   │ │ ฿450   │ │ ฿890   │ │ สินค้าหมด│            │
│ ☐ เฉพาะมีสินค้า │  └────────┘ └────────┘ └────────┘ └────────┘            │
│                │                                                          │
│ [ ล้างตัวกรอง ] │  … 4 ต่อแถว …                                            │
│                │                                                          │
│                │            [ ดูเพิ่มเติม ]   ← cursor, not page numbers   │
└────────────────┴─────────────────────────────────────────────────────────┘

MOBILE  < 640px
┌───────────────────────────┐
│ ☰  LOGO        🔍  ตะกร้า(2)│
├───────────────────────────┤
│ [ ตัวกรอง ▾ ] [ เรียง ▾ ]  │   ← filters open a Sheet, not an inline panel
├───────────────────────────┤
│ ┌─────────┐ ┌─────────┐   │
│ │ [รูป]   │ │ [รูป]   │   │   ← 2 per row
│ ├─────────┤ ├─────────┤   │
│ │ ชื่อ     │ │ ชื่อ     │   │
│ │ ฿390    │ │ ฿450    │   │
│ └─────────┘ └─────────┘   │
│                           │
│     [ ดูเพิ่มเติม ]         │
└───────────────────────────┘
```

**Decided here:**

- **4 columns desktop, 2 mobile.** Three looks sparse at this width; six makes the
  images too small to judge a garment by.
- **Sidebar filters on desktop, a Sheet on mobile.** An inline collapsing filter panel
  on mobile pushes the grid down and loses the shopper's place.
- **"Load more", not numbered pages.** The API is cursor-paginated and cannot know a
  total page count — and asking for one would mean a `COUNT(*)` over the same
  predicate on every request.
- **Sort is a Select, filters are separate.** Sort has one value; filters have several.
  Merging them into one "refine" control makes both harder to use.
- Out of stock stays in the grid, marked. Removing it makes the shop look emptier than
  it is and loses a shopper who would have waited.

---

## 2. Product detail

```
DESKTOP
┌──────────────────────────────────────────────────────────────────────────┐
│ LOGO   …นำทาง…                                  ค้นหา  บัญชี  ตะกร้า(2)   │
├──────────────────────────────────────────────────────────────────────────┤
│ หน้าแรก › เสื้อผ้า › เสื้อยืด                                              │
├────────────────────────────────┬─────────────────────────────────────────┤
│                                │  เสื้อยืดคอกลม ผ้าฝ้ายออร์แกนิก            │
│        ┌──────────────┐        │  ฿390                                    │
│        │              │        │                                          │
│        │    [รูปหลัก]  │        │  ขนาด                                    │
│        │     1:1      │        │  ( S ) ( M ) ( L ) ( XL·หมด )            │
│        │              │        │                                          │
│        └──────────────┘        │  เหลือ 12 ชิ้น                            │
│        [▪] [▫] [▫]             │                                          │
│                                │  ┌────────────────────────────────────┐  │
│                                │  │      เพิ่มลงตะกร้า                   │  │
│                                │  └────────────────────────────────────┘  │
│                                │                                          │
│                                │  รายละเอียดสินค้า…                        │
└────────────────────────────────┴─────────────────────────────────────────┘

MOBILE: image full-width on top, then name, price, variants, button, description.
        The button is NOT sticky — see below.
```

**Decided here:**

- **Variant picker is a row of buttons, not a `<select>`.** Four sizes fit; a select
  hides them behind a tap and hides which are unavailable.
- **An unavailable variant is shown and disabled, not removed.** A shopper looking for
  XL needs to learn it is sold out, not fail to find it.
- **Stock is shown only when it is low** (`availableStock <= 5`). Always showing it
  turns a helpful nudge into noise, and the number is advisory anyway — the contract
  says so, and checkout re-verifies under a lock.
- **No sticky add-to-cart on mobile.** It covers content on short pages, and this page
  is short. Revisit if the description grows.
- Breadcrumbs, because the category filter is the main way in and a shopper needs the
  way back out.

---

## 3. Cart

```
DESKTOP
┌──────────────────────────────────────────────────────────────────────────┐
│ ตะกร้าสินค้า                                                              │
├───────────────────────────────────────────────┬──────────────────────────┤
│ ┌───────────────────────────────────────────┐ │  สรุปคำสั่งซื้อ            │
│ │ [รูป]  เสื้อยืดคอกลม                        │ │                          │
│ │  80px  ขาว / M          ฿390              │ │  ยอดรวมสินค้า    ฿1,170  │
│ │        [ − ] 3 [ + ]    ฿1,170       [ลบ] │ │  ค่าจัดส่ง          ฿50  │
│ └───────────────────────────────────────────┘ │  ─────────────────────── │
│ ┌───────────────────────────────────────────┐ │  รวมทั้งสิ้น      ฿1,220  │
│ │ [รูป]  กระเป๋าผ้าแคนวาส                     │ │                          │
│ │        กลาง / เหลือ 1 ชิ้น  ฿690           │ │  ┌────────────────────┐  │
│ │        [ − ] 1 [ + ]     ฿690        [ลบ] │ │  │  ดำเนินการสั่งซื้อ   │  │
│ └───────────────────────────────────────────┘ │  └────────────────────┘  │
│                                               │                          │
│ ← เลือกซื้อสินค้าต่อ                            │  (sticky on scroll)      │
└───────────────────────────────────────────────┴──────────────────────────┘

MOBILE: lines stacked full-width; the summary sits BELOW them, and the
        checkout button is sticky to the bottom of the viewport.
```

**Decided here:**

- **The summary shows a shipping line even though it is flat.** A total that appears
  from nowhere at checkout is where people abandon.
- **`+`/`−` steppers, not a free-text quantity field.** The quantity is 1–99 and a
  text field invites `0`, `-1`, and `abc`, each of which needs its own error.
- **Sticky checkout on mobile, sticky summary on desktop.** Opposite of the PDP,
  because here the action *is* the page.
- **Low stock is repeated on the line.** It changed while the basket sat there, and
  checkout is about to 409 if it is short — better to say so now.
- Removing the last line shows `EmptyCart`, which has a route back to the catalogue.

---

## 4. Checkout

```
DESKTOP
┌──────────────────────────────────────────────────────────────────────────┐
│ ชำระเงิน                                                    ← กลับไปตะกร้า │
├───────────────────────────────────────────────┬──────────────────────────┤
│ ที่อยู่จัดส่ง                                    │  สรุปคำสั่งซื้อ            │
│  ชื่อผู้รับ      [__________________]          │                          │
│  เบอร์โทร       [__________________]          │  เสื้อยืด × 3     ฿1,170  │
│  ที่อยู่          [__________________]          │  กระเป๋า × 1       ฿690  │
│  เขต/อำเภอ      [_________]                   │  ─────────────────────── │
│  จังหวัด         [_________]                   │  ยอดรวม          ฿1,860  │
│  รหัสไปรษณีย์    [_____]                       │  ค่าจัดส่ง           ฿50  │
│                                               │  รวมทั้งสิ้น      ฿1,910  │
│ วิธีชำระเงิน                                    │                          │
│  ( • ) บัตรเครดิต    (   ) พร้อมเพย์            │  (sticky)                │
│                                               │                          │
│ หมายเหตุ (ถ้ามี)  [__________________]          │                          │
│                                               │                          │
│ ┌───────────────────────────────────────────┐ │                          │
│ │            ยืนยันการสั่งซื้อ                 │ │                          │
│ └───────────────────────────────────────────┘ │                          │
└───────────────────────────────────────────────┴──────────────────────────┘

MOBILE: one column. The summary collapses to a tappable
        "รวมทั้งสิ้น ฿1,910  ▾" row pinned at the top.

AFTER SUBMIT
┌──────────────────────────────────────────┐
│   ✓  สั่งซื้อสำเร็จ                        │
│      เลขที่คำสั่งซื้อ ORD-2026-0000001      │
│      สถานะ: รอชำระเงิน                    │
│      ┌──────────────────────────────┐    │
│      │        ชำระเงินตอนนี้          │    │  → POST /payments/{id}/confirm
│      └──────────────────────────────┘    │
│      สำรองสินค้าไว้ให้ถึง 14:35            │  ← reservationExpiresAt
└──────────────────────────────────────────┘
```

**Decided here:**

- **One page, not a wizard.** One address, one shipping option, one payment method —
  steps would be ceremony. It also maps one-to-one onto `POST /checkout`, which is
  what makes one submit mean one idempotency key.
- **The idempotency key is generated when the page mounts**, not when the button is
  clicked. A double-click must reuse the same key; generating it on click would make
  two keys and two orders.
- **The submit button disables while in flight and the key does not change**, so a
  retry after a timeout replays rather than duplicating.
- **Confirmation shows the reservation deadline.** The contract returns
  `reservationExpiresAt`, and a shopper who wanders off should know the hold expires.
- **Payment is a separate step after the order exists.** That is the contract's
  shape — checkout creates an order in `pending_payment`, confirm hands it to the
  provider — and the UI matching it is what makes the state recoverable: an
  abandoned payment leaves a real order the shopper can come back to.
- A 409 on submit re-renders the basket **with every short line marked at once**,
  because that is what the API returns and fixing one item per round trip is the
  behaviour it exists to avoid.

---

## What is not wireframed

- **Admin** — task 2.7/3.5, and the first thing to cut. It is a table and two forms.
- **Auth pages** — a centred card with two fields. Nothing to decide.
- **Order history and detail** — the same two-column shape as the cart, reusing the
  summary block.
