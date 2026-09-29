# Design references and decisions

Task 3.0. The point of this task is not to design something beautiful — it is to make
the shop **look finished**, which is a different and much more achievable thing. A
reviewer decides in about five seconds, from a screenshot, before they read a line of
the README.

## No screenshots in this folder, deliberately

The task says to screenshot three reference sites. What is recorded here instead is
the **structural analysis** — what those layouts contain and in what order. Two
reasons: shipping other companies' page designs as image files in a public portfolio
repo is a copyright question nobody needs, and the screenshots would not be the
useful part anyway. The useful part is the list of conventions, which is below.

## The three references

**Uniqlo**, **Muji** and **Everlane** — chosen because all three sell physical goods
with variants at a similar price point, and all three have had their layouts tested
against far more traffic than this project will ever see.

This is not copying. These are conventions a shopper already knows how to read, and
inventing alternatives produces something unfamiliar without producing something
better. The places worth being original are the checkout guarantees, not where the
basket icon sits.

### Header

All three converge on the same thing, in this order:

```
[ logo ]   [ category nav ]                    [ search ]  [ account ]  [ cart • n ]
```

- Cart on the far right, with a count badge. Always visible, never in a menu.
- Search is a field on desktop and an icon that expands on mobile.
- Category navigation is horizontal on desktop; on mobile it collapses into a drawer.
- The header is the only part of the page that is identical everywhere. It is how a
  shopper knows they have not left the shop.

### Product card

What all three show:

- Image, square or 4:5, and always the **same** ratio across the grid. This matters
  more than which ratio: a mixed grid reflows as images load and reads as broken.
- Product name, one or two lines, truncated rather than wrapped to three.
- Price.
- An out-of-stock treatment that is visible without hovering.

What they deliberately **do not** show: description, ratings, SKU, variant pickers,
an add-to-cart button. A card's job is to get someone to the product page, and every
extra element competes with that.

### Product detail

- Images on the left (desktop) or top (mobile); everything else on the right.
- Name, price, then the variant picker, then add-to-cart — in that order, because that
  is the order the decision is made in.
- The add-to-cart button is the single most prominent element on the page.
- Description below the fold. Nobody reads it before deciding.

### Checkout

Two columns on desktop: the form on the left, an order summary sticky on the right.
One column on mobile, summary collapsed into an expandable row at the top.

All three keep the summary visible throughout. A shopper who cannot see what they are
paying for abandons.

This shop uses a **single page** rather than a multi-step wizard: there is one
address, one shipping option and one payment method, so steps would be ceremony. The
contract's `POST /checkout` is a single call, and the UI matching it one-to-one is
what makes the idempotency key meaningful — one submit, one key.

## Tokens

Implemented in [`apps/web/src/index.css`](../../apps/web/src/index.css) under
`@theme`, and asserted in
[`design-tokens.spec.ts`](../../apps/web/src/design-tokens.spec.ts).

> **A note on the task's wording.** The DoD says the tokens live in
> `tailwind.config.ts`. Tailwind v4 is CSS-first and that file no longer holds the
> theme; tokens are declared in `@theme` in CSS, which generates both the utilities
> and the CSS variables from one place. The intent — one place, not scattered across
> class attributes — is what v4's `@theme` is for.

| | decision | why |
| --- | --- | --- |
| Colour | one neutral ramp (11 steps), one brand ramp (9), three semantics | A project looks unfinished because it uses too many colours, not too few. The brand green appears on primary buttons and links and nowhere else. |
| Neutrals | very slightly warm | Large grey areas next to product photography read cold and clinical if they are pure grey. |
| Radius | two values: 6px controls, 12px surfaces | A third would only ever be chosen by whoever was typing at the time. |
| Shadow | two levels | A shop wants separation, not drama. |
| Spacing | six steps of Tailwind's scale: `2 3 4 6 8 12` | A page assembled from six spacings looks composed; one assembled from whatever felt right looks almost-aligned everywhere. |

## Type, and the Thai problem

**IBM Plex Sans Thai**, self-hosted via `@fontsource`, covering Thai and Latin in one
family. A Latin font with a Thai fallback renders the two scripts at visibly
different weights and sizes, and the seam shows on every product card.

Self-hosted rather than a Google Fonts `<link>`: the shop then renders identically
offline and inside Docker, with no third-party request on the critical path.

**The failure this guards against.** Thai stacks an upper vowel and a tone mark above
the base character and can hang a lower vowel below it. A line box sized for Latin
clips them — the text is still readable, so it is easy to miss, and it looks
subtly wrong in a way a reader cannot name.

Tailwind's default type scale pairs the smaller sizes with tight leading, so the
scale is redeclared with a line-height on every size: **1.6 for body, never below
1.35 for headings**. `leading-tight` and `leading-none` are banned outright.

Three of shadcn's own components shipped with `leading-none` — the card title, the
dialog title and the label. All three carry Thai copy in this shop, so all three were
changed. **The guard test found them**, which is exactly why it is a test rather than
a note.

## Non-happy-path states

The place most portfolios stop looking finished: everything is polished until you
click something, and then it is a blank area or `undefined`.

| state | component | rule |
| --- | --- | --- |
| Loading | `components/state/skeletons.tsx` | A skeleton with the real geometry, not a spinner. The layout must not jump when content lands. |
| Empty | `components/state/empty-state.tsx` | Every empty state carries a way out. `action` is part of the type, so it cannot be forgotten. |
| Error | `components/state/error-state.tsx` | Says what to try next, and surfaces the `traceId` so a report can be traced to a log line. |
| Disabled | button `disabled` + adjacent text | A disabled button must be accompanied by the reason. "Sold out" next to it, never just a grey button. |
| Offline | `OfflineState` | Separate from Error, because the advice differs: retrying is pointless until the connection returns. |

All of them are rendered on the design-system page, so they are looked at rather than
written and forgotten.

## Responsive

Two breakpoints, and no tablet layout:

- **mobile** `< 640px` — single column, 2-up product grid
- **desktop** `>= 1024px` — 4-up product grid, two-column checkout

A tablet-specific layout is a third set of decisions to make and maintain, for a
width that is served perfectly well by the mobile layout with more room.

## Accessibility, to a defined floor

Not a full WCAG programme — four things that take under an hour and that a reviewer
who cares will check within seconds:

1. **Visible focus on everything focusable.** A `:focus-visible` outline is set
   globally in `index.css` and never removed. `:focus-visible` rather than `:focus`,
   so a mouse click does not leave a ring behind.
2. **Contrast at AA.** Asserted, not eyeballed: `design-tokens.spec.ts` converts the
   oklch tokens to luminance and checks every text/background pair used, at 4.5:1 for
   body text and 3:1 for large text and the focus ring.
3. **Real `alt` on every image.** The product's name, never "product image".
4. **Tab through the page without getting stuck.** Radix handles focus trapping in
   the sheet and dialog, which is most of why shadcn is worth using here.

Plus two that came free: `prefers-reduced-motion` is honoured, and loading skeletons
are `aria-hidden` with a single polite live region announcing the load — otherwise a
screen reader is told nothing at all while a page loads.

## Dark mode: not now

Deliberately not built. It doubles the work on every component in exchange for
something no interviewer has ever asked about. Recorded in
[`docs/future.md`](../future.md).

It is "not now" rather than "cannot": everything is already expressed as CSS
variables, so a dark theme is a second block of values rather than a rewrite.

## Component library

shadcn/ui, with only the components this shop uses: Button, Input, Label, Select,
Card, Badge, Sheet (cart drawer), Dialog, Skeleton, Separator, Table (admin), Sonner
(toasts).

shadcn copies source into the repo rather than adding a dependency, so the three
`leading-none` fixes above were ordinary edits to our own files.

Time saved here goes into the checkout flow. Nobody is hired for writing their own
dropdown.

### One thing to know if you re-run `shadcn add`

The CLI generated `import { cn } from "cn"` — a package that exists on npm and is not
ours — instead of `@/lib/utils`, and installed it. The imports were repointed and the
package removed. Check the imports after adding a component.
