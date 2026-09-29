# TASKS

The plan, mirrored from ClickUp. The board is the live copy — it holds the full
per-task detail (checklists, gotchas, code sketches, definitions of done). This
file is the map: what the phases are, what each task is for, and what has to be
true before it can be called done.

**Board:** [Portfolio Project](https://app.clickup.com/90182767626/v/o/s/1100450000000236)

> When a task's detail changes, it changes in ClickUp first. When
> `contract/openapi.yaml` changes, the affected ClickUp tasks get updated too —
> the spec and the plan drift apart silently otherwise.

## What this project is

One web store API, defined once in OpenAPI and implemented twice — NestJS and
Spring Boot — against a single PostgreSQL schema owned by Flyway. One contract
test suite runs against both and proves they are interchangeable: `make up-node`
and `make up-java` serve the same store through the same gateway, and the swap
is invisible to the browser.

The interesting parts are the ones OpenAPI cannot describe — the cursor codec
and the canonical request hash used for idempotency — because those are exactly
where two independent implementations drift. See `docs/cursor-format.md` and
`docs/idempotency.md` once Phase 2 writes them.

## Phase 1 — Contract & Foundation

Everything here is cheap now and expensive later. A day spent closing the
contract saves three in Phase 5, because every spec change after code exists is
a change in two languages plus the tests.

| # | Task | Priority | Est. | Done when |
| --- | --- | --- | --- | --- |
| 1.1 | [Repo scaffold + Makefile + ADR template](https://app.clickup.com/t/z8v9xnfz55) ✅ | High | 4h | `git clone` shows where everything lives, before any code exists |
| 1.2 | [Close the OpenAPI contract + Spectral lint](https://app.clickup.com/t/z8v9xnfz56) ✅ | Urgent | 7h | `make lint-contract` is clean and no endpoint's behaviour has to be guessed |
| 1.3 | [Flyway V1 migration + V2 seed](https://app.clickup.com/t/z8v9xnfz58) ✅ | Urgent | 7h | `make clean && make up-node` gives a demo-ready database, three times running |
| 1.4 | [Compose: Postgres + Redis + Flyway + nginx gateway](https://app.clickup.com/t/z8v9xnfz5a) ✅ | High | 5h | `docker compose ps` all healthy; the gateway swap works from env alone |
| 1.5 | [ADR-001 … ADR-003](https://app.clickup.com/t/z8v9xnfz5b) ✅ | Normal | 2h | Three ADRs in `docs/adr/`, one page each, Alternatives section non-empty |

Three questions 1.2 had to settle before anything else started — all three are
now answered in the contract itself, in the description of the operation each
one affects:

1. **`sort=price_asc` orders by the product's cheapest active variant**, read
   from a denormalised `min_price_cents` column on `products`. A `MIN()`
   subquery cannot use an index. → **1.3 must include that column in
   `V1__init.sql`**, and both backends must maintain it on every variant
   reprice and archive.
2. **Flat shipping rate** (`SHIPPING_FLAT_CENTS`, 5000 = ฿50), stated in the
   README as deliberate rather than hidden behind a shipping-zone table.
3. **THB only**, with `currency` on every money-bearing response so the seam is
   visible. No endpoint accepts a currency as input.

A fourth question surfaced while writing the spec and is settled the same way:
**guests can browse and hold a basket, but cannot checkout.** An order belongs
to a user, so a guest registers or signs in and `POST /carts/me/merge` carries
the basket across. That is why the merge endpoint exists.

### What the seed plants on purpose

Each of these exists because a demo or a test is impossible without it, and each
is asserted at the end of `V2__seed.sql` so a careless edit fails `make up-node`
rather than surfacing three phases later as a flaky test.

- **`TOTE-M` holds exactly one unit** — the concurrency demo fires 20 concurrent
  checkouts at it; exactly one may win.
- **`kitchen-knife-set` is fully out of stock** — the sold-out UI state, which is
  otherwise the kind of thing nobody notices is unstyled until a demo.
- **Three products have variants at differing prices** — `sort=price_asc` needs
  something to sort, and `min_price_cents` needs something to be wrong about.
- **One draft and one archived product** — without them, "the catalogue shows
  only active products" is an untested claim.
- **A category tree with real depth**, and one product filed directly on a root —
  so `categorySlug=clothing` must return both that product and everything under
  its children, which is the only thing that exercises the recursive CTE.

`make up-node` and `make up-java` cannot work until `apps/api-node` and
`apps/api-java` have Dockerfiles (tasks 2.8 and 5.1); they now say so instead of
failing with a buildx error. **`make up-infra`** brings up Postgres, Redis, Flyway
and the gateway with no application images, which is what Phase 2 develops
against.

The gateway resolves its upstreams per request rather than declaring an `upstream`
block, because nginx resolves those once at config load and exits if a name does
not resolve — meaning the gateway could not start before a backend existed, and a
backend restart would take it down. Resolving late turns that into a 503, served
as `problem+json` so a down backend does not break the client's error handling.

ADRs written so far: **001** Flyway owns the schema, **002** money as integer
minor units, **003** no PostgreSQL ENUM, **008** UUIDv7 generated by the
application. 004–007 belong to later phases.

ADR-008 records the UUID decision 1.3 called for: **UUIDv7 generated by the
application**, ordered on the canonical string form so TypeScript, Java and SQL
all sort identically. It is not in the board's ADR register (001–007) and needs a
row adding there.

## Phase 2 — NestJS Backend

The reference implementation. Whatever it does becomes what Phase 5 has to
match, so the parts the contract cannot express get written down as they are
built — not reverse-engineered from TypeScript two phases later.

| # | Task | Priority | Est. | Done when |
| --- | --- | --- | --- | --- |
| 2.1 | [Foundation: Prisma, Problem filter, logging, health, cursor codec](https://app.clickup.com/t/z8v9xnfz5d) ✅ | Urgent | 16h | Any error at all comes back as `problem+json`; no HTML error page can escape |
| 2.2 | [Auth: register, login, JWT guard, refresh rotation](https://app.clickup.com/t/z8v9xnfz5g) ✅ | High | 13h | Reusing a rotated refresh token revokes the whole token family |
| 2.3 | [Catalog: categories, product list, search, detail](https://app.clickup.com/t/z8v9xnfz5j) ✅ | High | 12h | Walking the cursor to the end returns every row, none twice, none missed |
| 2.4 | [Cart: resolver, CRUD, guest-to-user merge](https://app.clickup.com/t/z8v9xnfz5p) ✅ | High | 12h | Guest adds two items → registers → items survive → logout/login → still there |
| 2.5 | ⭐ [Checkout: idempotency, variant locking, stock reservation](https://app.clickup.com/t/z8v9xnfz5q) ✅ | Urgent | 24h | 20 concurrent checkouts on one remaining unit → exactly one succeeds |
| 2.6 | [Orders & Payments: history, cancel, mock provider, webhook](https://app.clickup.com/t/z8v9xnfz5t) ✅ | High | 15h | Same webhook delivered five times decrements stock once |
| 2.7 | [Admin: products, inventory delta, order status machine](https://app.clickup.com/t/z8v9xnfz5w) | Normal | 9h | `delta: -999` → 409; customer token → 403 |
| 2.8 | [Dockerize + unit tests for the hard parts](https://app.clickup.com/t/z8v9xnfz5x) | High | 9h | `make clean && make up-node` from a clean tree serves every endpoint |

### What 2.1 settled

- `docs/cursor-format.md` and `tests/fixtures/cursor-vectors.json` specify the
  cursor codec so 5.3 can port it rather than reverse-engineer it. The codec
  writes its JSON by hand rather than through a serialiser, because serialisers
  disagree about escaping non-ASCII and every `name_asc` cursor carries Thai text.
- `docs/problem-types.md` is the full `type`/`title` registry. Both are part of
  the contract: a parity test compares titles too.
- Implicit type conversion is off in the validation pipe. It had silently coerced
  a JSON number into a string so `@IsString()` accepted it, while Jackson would
  have rejected the same body — a parity failure with no behavioural cause.
- Host ports for Postgres and Redis are 55432 and 56379, not the defaults, because
  a locally installed instance shadows the published port and connections then
  fail authentication in a way that looks like bad credentials.

### What 2.2 settled

`docs/auth-tokens.md` specifies the claim set, the refresh rotation rules, and the
argon2 parameters, so 5.4 ports from a document. Three things found while building
it:

- `@nestjs/jwt` v12 is ESM-only. A CommonJS Nest build can load it only through
  Node's `require(esm)`, which Jest's runtime cannot do at all and which the
  node:22 runtime image should not be relying on. Replaced with `jsonwebtoken`
  directly — one less wrapper, and the algorithm is pinned on sign *and* verify so
  an `alg: none` token cannot be accepted.
- Prisma cannot see the unique index on `lower(email)` or the partial unique
  indexes on `carts`, because both are expressions. So uniqueness is enforced by
  the database alone, and registration attempts the insert and translates `P2002`
  rather than pre-checking — which would be a race in any case.
- Guest-cart claiming here only covers the case where the account has no basket.
  When it has one the two must be merged, and that is `POST /carts/me/merge` in
  2.4; doing half of it here would put the same summing rule in two places.

### Verified against a real database

Docker Desktop failed during 2.1 and 2.2, so both were committed with their
database-dependent claims flagged as unverified. Its `docker-desktop` WSL distro had
become corrupted; unregistering it and letting Docker Desktop rebuild it restored
builds. Everything then checked out:

- The api-node image builds; `make up-node` brings up five services, all healthy,
  and the container's own healthcheck passes.
- **The seeded demo accounts log in.** The argon2id hashes written by
  `V2__seed.sql` verify against the running application — seed, migration and auth
  agree end to end.
- The rotation chain and family revocation behave as specified, and a duplicate
  registration returns 409 rather than 500 (the `P2002` translation works against
  the real `lower(email)` index).
- Guest-cart claiming moves `user_id`, `token_hash` and `expires_at` together, as
  `carts_single_owner_check` requires.
- All 22 schema constraint checks pass on the rebuilt database.
- Ten concurrent refreshes of one token: exactly one succeeded, and the family was
  left with **zero** live tokens — see `docs/auth-tokens.md`.

### What 2.3 settled

The product listing is one raw SQL query, not the Prisma query builder, and each of
three reasons rules the builder out on its own: `categorySlug` needs a recursive CTE
for the subtree; the cursor predicate is a row-value comparison `(sort_col, id) < (:v, :i)`
which the builder would render as `sort_col < :v AND id < :i` — a different and wrong
condition that drops every tied row; and search needs a trigram `ILIKE` against the
expression index. **The Java port needs a native query for the same three reasons.**

`GET /products` is covered by an integration suite that runs against a real
PostgreSQL with the seed applied (`npm run test:integration`), because every claim
here is a database behaviour a double could not check. 44 tests, including walking
the cursor to exhaustion under all four sorts and asserting no row is seen twice or
missed, and that archiving a row from page one does not shift page two.

`npm test` excludes those and stays green without Docker; the integration suite skips
loudly rather than failing when no database is reachable.

### What 2.4 settled

ADR-006 records why the basket is in Postgres rather than Redis, and the reason is
specific to this project: in Redis a basket is whatever bytes the application chose,
the contract cannot describe a format that never crosses the wire, and two backends
could serialise it completely differently while both returning identical JSON. The
divergence would surface only in the cross-backend test — the one place it could not
be localised.

Two things the tests caught:

- Both cart `POST` endpoints were returning Nest's default **201** where the contract
  says **200**. They return the updated basket, not a resource the client can address.
- `@nestjs/schedule` v12 is ESM-only, like `@nestjs/jwt` before it. The sweeper is a
  plain interval instead — it needed one timer, not a scheduling framework.

Adding to a basket still **reserves nothing**, which is asserted directly:
`stock_reserved` is untouched, and two shoppers can both hold the last unit. The loser
finds out at checkout, which is where the 409 belongs. Merging likewise does **not**
stock-check: signing in must never lose a basket because something sold out in the
meantime.

### What 2.5 settled

`docs/idempotency.md` specifies the canonical hash, ADR-004 the lock ordering, ADR-005
the key design. The measured results, against a real PostgreSQL:

- **20 concurrent checkouts on one unit → exactly one 201 and nineteen 409s**, with
  `stock_reserved = 1` and one held reservation afterwards. The task's definition of
  done, demonstrated rather than argued.
- **12 shoppers whose baskets share two variants in opposite orders → all 12 succeed,
  zero 5xx.** Without ascending-id lock ordering that is the classic deadlock, and
  PostgreSQL would kill one transaction — surfacing as a 500, not a 409.
- **8 concurrent retries of one key → one order number**, the rest 409
  `checkout-in-progress`.

Two decisions worth knowing before porting:

- Variants are locked **one row at a time** in sorted order, not with
  `WHERE id = ANY(...) ORDER BY id FOR UPDATE`. That single-query form looks
  equivalent but PostgreSQL does not guarantee rows are *locked* in the order they are
  returned, so the planner may reintroduce the deadlock under exactly the concurrency
  this protects against (ADR-004).
- The canonical hasher **omits object keys holding `undefined`**, matching
  `JSON.stringify`. Not cosmetic: the hash is taken over the rebuilt DTO, and
  `class-transformer` materialises absent optional fields as `undefined` properties —
  without the rule, adding an optional field would change the fingerprint of every
  request that omits it. Found by the first integration run, which 422'd on every
  checkout.

**2.5 was the task the whole project exists for.** It is the one that gets asked
about, and the one that makes this not a CRUD tutorial. Two rules from it bind
Phase 5 exactly:

- **Lock variants in ascending UUID order.** Two carts sharing items in
  opposite orders deadlock otherwise — A locks X waits for Y, B locks Y waits
  for X. Sorting first means the loser just waits.
- **Canonical hash**: parse the body, sort keys recursively, serialise with no
  whitespace, SHA-256, lowercase hex. The same body with keys in a different
  order must hash identically in both languages.

Also non-negotiable: a 409 for insufficient stock lists **every** short line in
one response, not just the first. And `POST /payments/{id}/confirm` marks the
payment `processing` and nothing more — stock is decremented by the webhook, the
way a real provider works. Collapsing that asymmetry means the webhook path
never gets tested.

### What 2.6 settled

The asymmetry the task insists on is now demonstrable rather than asserted. Confirming
a payment marks it `processing` and moves **nothing**; only the webhook decrements
stock. Verified live: confirm left `on_hand=16 reserved=2` untouched, then the mock
provider's own two-second timer fired a genuine signed HTTP callback to
`/webhooks/payment` and the order became `paid` with `on_hand=14 reserved=0`.

The provider makes a **real HTTP request back to the service** rather than calling the
handler in process. Calling in process would be simpler and would exercise none of the
things that actually break: the HMAC over the raw bytes, the JSON parse, the dedupe.

Deduplication is the unique index on `(provider, event_id)` with
`ON CONFLICT DO NOTHING` — the same event delivered five times is acknowledged five
times and applied once, asserted directly against `stock_on_hand`.

The webhook answers **200 for everything** except a signature that does not verify:
applied, duplicate, unknown event type, unknown payment, and even an event that could
not be processed. A non-2xx makes a real provider retry forever for something that
will fail identically.

One test-infrastructure change: integration suites now run with `--runInBand`. They
share one database and mutate the same seeded stock rows, so in parallel they raced
each other — two suites' stock assertions failed together while each passed alone.

## Phase 3 — React Frontend

| # | Task | Priority | Est. | Done when |
| --- | --- | --- | --- | --- |
| 3.0 | 🎨 [Design foundation: tokens, Thai font, component library, wireframes](https://app.clickup.com/t/z8v9xnfz7v) ✅ | High | 12h | Tokens in `tailwind.config.ts`, shadcn themed, four wireframes, Thai vowels not clipped |
| 3.1 | [Scaffold + generated API client + query layer](https://app.clickup.com/t/z8v9xnfz61) | High | 8h | Change a field in `openapi.yaml` → `make gen-client` → `tsc` points at every use |
| 3.2 | [Auth store, refresh interceptor, guest cart token](https://app.clickup.com/t/z8v9xnfz63) | High | — | — |
| 3.3 | [Catalog, product detail, cart pages](https://app.clickup.com/t/z8v9xnfz67) | High | — | — |
| 3.4 | ⭐ [Checkout flow: form, idempotency key, payment, confirmation](https://app.clickup.com/t/z8v9xnfz69) | Urgent | — | — |
| 3.5 | [Admin UI + error handling + dockerize web](https://app.clickup.com/t/z8v9xnfz6a) | Normal | — | — |

### What 3.0 settled

Tokens live in `apps/web/src/index.css` under `@theme`. **The DoD names
`tailwind.config.ts`; Tailwind v4 is CSS-first and that file no longer holds the
theme** — the intent, one place rather than scattered across class attributes, is
what `@theme` is for.

The Thai guard is a test, not a note. Every type size carries its own line-height
(1.6 body, never below 1.35) and `npm test` fails on any tight-leading utility in
`src/`. **It immediately caught three shadcn components** — card title, dialog title
and label all ship `leading-none`, and all three carry Thai copy in this shop.

Contrast is computed, not eyeballed: the test converts the oklch tokens to luminance
and asserts every text/background pair at 4.5:1 (3:1 for large text and the focus
ring). That turns "checked with devtools" into something that survives a palette edit.

The brand ramp is called `brand`, not `accent`, because shadcn reserves `accent` for
the subtle hover surface — one name meaning two things is how a design system starts
lying. A bridging `@theme` block maps shadcn's token names onto the ramp, so its
components stay exactly as the registry ships them and survive an upgrade.

Two things the shadcn CLI got wrong and that are worth knowing before the next
`add`: it generated `import { cn } from "cn"` (an unrelated npm package) instead of
`@/lib/utils` and installed it, and it pulled in `next-themes` for a dark mode this
project deliberately does not build. Both removed.

3.0 runs **before** 3.3. Two reasons it is a task and not an afterthought:
someone opening the demo link judges it in five seconds from the picture, and
without tokens fixed up front every page drifts a little from the last one.

The iron rule from 3.1: **never hand-write an API type.** Import from
`@/api/schema`. A hand-written interface throws away the entire benefit of
working contract-first — the build stops being able to catch a backend that has
drifted.

## Phase 4 — Contract Tests & CI

One suite, two backends, and a report that says whether they agree.

| # | Task | Priority | Done when |
| --- | --- | --- | --- |
| 4.1 | [Test harness + Schemathesis property testing](https://app.clickup.com/t/z8v9xnfz6b) | Urgent | — |
| 4.2 | [Scenario tests: auth flow, cart merge, happy path](https://app.clickup.com/t/z8v9xnfz6e) | High | — |
| 4.3 | ⭐ [Concurrency, idempotency & cross-backend tests](https://app.clickup.com/t/z8v9xnfz6j) | Urgent | — |
| 4.4 | [GitHub Actions matrix + parity report generator](https://app.clickup.com/t/z8v9xnfz6p) | High | — |

4.3 is where the shared database pays off: a cursor issued by Node has to page
correctly against Java, and a checkout retried with the same `Idempotency-Key`
against the *other* backend has to replay rather than double-charge. That is
only possible because the idempotency keys and the cart live in Postgres, not
in per-process memory or Redis.

## Phase 5 — Spring Boot Port

| # | Task | Priority | Done when |
| --- | --- | --- | --- |
| 5.1 | [Scaffold Spring Boot + JPA entities + ddl-auto validate](https://app.clickup.com/t/z8v9xnfz6r) | High | — |
| 5.2 | [Serialization & error parity: Jackson, Problem, validation](https://app.clickup.com/t/z8v9xnfz6v) | Urgent | — |
| 5.3 | [Port the shared codecs: cursor + canonical hashing](https://app.clickup.com/t/z8v9xnfz6z) | Urgent | — |
| 5.4 | [Port the modules: auth, catalog, cart, orders, payments, admin](https://app.clickup.com/t/z8v9xnfz70) | High | — |
| 5.5 | ⭐ [Port checkout + get CI green on both](https://app.clickup.com/t/z8v9xnfz72) | Urgent | — |

`ddl-auto: validate`, never `update`. Flyway owns the schema; JPA and Prisma are
both readers. The moment either one is allowed to write, the other drifts.

## Phase 6 — Ship & Present

| # | Task | Priority | Done when |
| --- | --- | --- | --- |
| 6.1 | [README + remaining ADRs + Postman collection](https://app.clickup.com/t/z8v9xnfz79) | Urgent | — |
| 6.2 | [Demo GIF of the backend swap + make the seed look like a real shop](https://app.clickup.com/t/z8v9xnfz7b) | High | — |
| 6.3 | [Deploy the demo + update CV and GitHub profile](https://app.clickup.com/t/z8v9xnfz7c) | High | — |

## Reference

[📚 Project Documentation & Reference Hub](https://app.clickup.com/t/z8v9xnfz54) —
the cross-implementation rules, the schema decisions and their reasons, the ADR
register, and the two algorithms the contract cannot express. Kept open for the
whole project; new findings go there. The rules that matter most day to day are
copied into `CLAUDE.md` so they are in front of whoever is writing code.

Task 2.7 (admin) is the first thing to cut if time runs short. Anything cut gets
written up in ADR-007 rather than quietly dropped.
