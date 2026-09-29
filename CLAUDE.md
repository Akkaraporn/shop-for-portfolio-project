# CLAUDE.md

One web store API, defined once in OpenAPI and implemented twice — NestJS
(`apps/api-node`) and Spring Boot (`apps/api-java`) — against one PostgreSQL
schema owned by Flyway. A single contract suite runs against both and proves
they are interchangeable.

The plan lives in `TASKS.md` and, in full, on the
[ClickUp board](https://app.clickup.com/90182767626/v/o/s/1100450000000236).

## Commands

```
make up-infra       # Postgres + Redis + Flyway + gateway, no app images needed
make up-node        # whole stack, gateway -> NestJS   (needs apps/api-node/Dockerfile)
make up-java        # whole stack, gateway -> Spring Boot (needs apps/api-java/Dockerfile)
make down           # stop, keep the database volume
make clean          # stop and wipe the volume (next up re-seeds)
make lint-contract  # Spectral over contract/openapi.yaml
make gen-client     # regenerate apps/web/src/api/schema.d.ts from the contract
make gen-prisma     # re-run migrations, then prisma db pull (never the reverse)
make test-parity    # parity suite against whichever backend is up
make db-verify      # prove the schema's constraints reject what they claim to
make db-psql        # psql shell on the dev database
make hooks          # install the git hooks (once per clone)
```

The gateway is at `http://localhost:8080`; the API lives under `/api/v1`.
`GET /__gateway/health` is answered by nginx itself and reports which backend it
is proxying to, so it works even when that backend is down.

`make up-node` serves the built shop at http://localhost:8080; `npm run dev` in
`apps/web` gives hot reload at :5173 against the same backend.

## Who owns what

| Artifact | Owns |
| --- | --- |
| `contract/openapi.yaml` | Every endpoint's shape. Source of truth. |
| `migrations/V1__init.sql` | The entire schema — 15 tables. |
| `migrations/V2__seed.sql` | Demo data, with a self-check that fails the migration if it half-applies. |
| `tests/schema/verify-constraints.sql` | `make db-verify` — tries to break every guarantee. |
| `docs/adr/*.md` | Why each decision was made. |
| `docs/cursor-format.md` | The cursor codec, byte for byte. Java ports from this. |
| `docs/problem-types.md` | Every `type` URI and title. Part of the contract. |
| `docs/auth-tokens.md` | JWT claims, refresh rotation, argon2 parameters. Java ports from this. |
| `docs/idempotency.md` | The canonical request hash and the key state machine. |
| `tests/fixtures/canonical-hash-vectors.json` | Shared hash vectors. Both backends must match. |
| `tests/fixtures/cursor-vectors.json` | Shared vectors. Both backends must reproduce them. |
| `docs/future.md` | What was deliberately not built. |

Flyway owns the schema. Prisma reads it with `db pull`; JPA reads it with
`ddl-auto: validate`. **Never** `prisma migrate`, **never** `ddl-auto: update` —
the moment one ORM can write the schema, the other drifts. `prisma/migrations/`
is deleted on purpose.

Changing `contract/openapi.yaml` after code exists means changing two languages
plus the tests, so close the contract first (task 1.2) and update the affected
ClickUp tasks whenever it does change.

## Settled scope decisions

These are answered in the contract and must not be relitigated in code.

- **`sort=price_asc` reads `products.min_price_cents`**, a denormalised copy of
  the cheapest active variant's price. Never a `MIN()` subquery — it cannot use
  an index. Both backends maintain the column on every variant reprice, insert,
  and archive.
- **Shipping is a flat `SHIPPING_FLAT_CENTS` per order.** No zones, no tables.
- **One currency, THB.** `currency` is on every money-bearing response; no
  endpoint takes it as input.
- **Guests browse and hold a basket; they cannot checkout.** An order belongs to
  a user, which is what `POST /carts/me/merge` exists for.

## Cross-implementation rules

Both backends must satisfy every one of these, byte for byte, or the parity
suite fails.

1. **Money is an integer count of minor units.** Field names end in `Cents`.
   Never a float, never a decimal string. Jackson renders `BigDecimal("129.50")`
   as `129.50` while Prisma renders `Decimal` as `"129.5"` — the same row, two
   different JSON values, and nothing notices until a client does arithmetic.
2. **Timestamps are RFC 3339 UTC, millisecond precision, `Z` suffix** —
   `2026-03-14T08:21:05.123Z`.
3. **Public IDs are lowercase hyphenated UUID strings.**
4. **Every error is `application/problem+json`** (RFC 9457). There is no second
   error shape, and a stack trace never reaches a response body.
5. **Enums are lowercase snake_case strings**, never integers. Stored as
   `VARCHAR` + `CHECK`, never a PostgreSQL `ENUM`.
6. **Unknown query parameters are ignored**, not rejected.
7. **An absent optional field is omitted** from the body, not sent as `null` —
   unless the schema declares it nullable.
8. **Every list returns the `Page` envelope**, even with one item.

## The two things the contract cannot express

These are where independent implementations drift, so they are written down
rather than inferred from the TypeScript.

**Cursor codec** (`docs/cursor-format.md`, written during task 2.1):
`base64url(JSON.stringify({ v: sortValue, i: id }))`, no padding — Java uses
`Base64.getUrlEncoder().withoutPadding()`. Key order is exactly `v` then `i`, and
`sortValue` is always a string even when the underlying value is numeric, to
avoid precision differences. Paging query:
`WHERE (sort_col, id) < (:v, :i) ORDER BY sort_col DESC, id DESC LIMIT :n+1` —
fetch one extra row to learn `hasMore`, then drop it. `id` is always the
tiebreaker; without it, rows with equal sort values duplicate or vanish between
pages.

**Canonical request hash** (`docs/idempotency.md`, written during task 2.5):
parse the body, sort keys recursively, serialise with no whitespace, SHA-256,
lowercase hex. The same body with keys in a different order must produce the
same hash in both languages.

## Node backend conventions

- **`src/bootstrap.ts` owns the global pipeline** — filter, validation pipe, and
  the request-id middleware. `main.ts` and every HTTP test call `configureApp`, so
  a test can never verify a pipeline that differs from production.
- **The request-id middleware is registered with `app.use`, not a module's
  `configure()`.** Module middleware only covers that module's routes, so a 404 on
  an unclaimed path would have no `traceId` — the one case a caller most needs
  something to quote.
- **Never enable `enableImplicitConversion`.** It coerces request bodies, so a
  JSON number passes `@IsString()`. Jackson is strict by default and rejects the
  same body, which is a parity failure created purely by a convenience setting.
  Query and path DTOs declare `@Type(() => Number)` explicitly instead.
- **Throw `ProblemException` with a slug from the registry**, never a bare
  `HttpException` and never a hand-built body. The filter is the only place that
  assembles a response, so `traceId` and `instance` cannot be forgotten.
- **Nothing reads `process.env` except `config/env.ts`.** An unvalidated variable
  entering elsewhere makes the zod schema stop being the whole truth.
- **Authentication is on by default.** `JwtAuthGuard` is an `APP_GUARD`, so an
  endpoint is protected unless it declares `@Public()` or `@OptionalAuth()` — a
  forgotten annotation fails closed. `RolesGuard` is registered after it and reads
  the user it attached, so the order in `AppModule` is significant.
- **No `@nestjs/jwt` and no Passport.** `@nestjs/jwt` v12 is ESM-only, which a
  CommonJS build can load only via Node's `require(esm)` — unavailable to Jest and
  a poor dependency for a production image. `jsonwebtoken` directly, with the
  algorithm pinned on both sign and verify.
- **`RedisService` never throws.** Every method returns a miss when the cache is
  unreachable, and `enableOfflineQueue: false` is what stops a Redis outage from
  presenting as request timeouts instead of cache misses.

## Catalogue conventions

- **The product listing is raw SQL** (`products.service.ts`). Keyset pagination needs
  a row-value comparison, the category filter needs a recursive CTE, and search needs
  a trigram `ILIKE` against an expression index — the query builder can express none
  of the three. Every user value is still a bound parameter; the only assembled SQL is
  the sort column and direction, from a fixed table keyed by a validated literal.
- **Name ordering is delegated to Postgres.** Both backends sort in the database
  rather than in application code, so they cannot disagree about Thai collation.
- **`productCount` on a category counts products filed *directly* in it**, not its
  subtree — while the `categorySlug` filter *does* include descendants. The two
  numbers legitimately differ for a parent.
- **A draft or archived product is a 404**, indistinguishable from one that never
  existed. Saying "exists but hidden" would leak the unpublished catalogue.
- **Escape `%` and `_` in search terms.** They are `ILIKE` wildcards; unescaped, a
  search for `%` returns the entire catalogue.

## Checkout conventions

- **Lock variants one at a time, in ascending id order**, everywhere — checkout and the
  sweeper both. `ORDER BY id FOR UPDATE` in one query does *not* guarantee lock order
  (ADR-004). Compare ids as the canonical lowercase string (ADR-008).
- **Nothing slow goes inside the checkout transaction.** It holds row locks; an HTTP
  call to a provider in there would hold them for a network round trip. That is why
  confirm is a separate request and the webhook fulfils the order.
- **Only successful responses are replayed.** A failed attempt releases its key, so a
  retry is a fresh attempt — `insufficient-stock` is transient and replaying a stale
  409 would deny a shopper an item that is back in stock.
- **The idempotency claim is its own transaction; the completion is inside the
  checkout transaction.** Merging them breaks the claim (invisible until commit);
  splitting the completion out breaks atomicity.
- **Canonicalise with `canonicalJson`, never `JSON.stringify`.** One escaper is shared
  with the cursor codec so there is one thing for Java to match.

## Orders and payments conventions

- **Confirm moves nothing.** It marks the payment `processing` and schedules the
  provider callback. The webhook is the only thing that decrements `stock_on_hand`.
  Collapsing the two leaves the webhook path untested and breaks the day a real
  provider is plugged in.
- **Settling decrements `stock_on_hand` *and* `stock_reserved`** by the same amount.
  Only the first leaves units reserved forever; only the second gives stock back while
  selling it.
- **The webhook answers 200 for everything** except a signature that fails to verify.
- **Verify the HMAC over `req.rawBody`**, never a re-serialised body. `rawBody: true`
  must be passed to `NestFactory.create` — and to `createNestApplication` in any test
  that exercises the webhook, or it fails closed and every delivery 401s.
- **Cancel is idempotent** (200 on an already-cancelled order) but a paid order is a
  genuine 409: that would be a refund.
- **Everything that releases or commits a reservation sorts variant locks the same
  way** as checkout — cancel, the sweeper, and the webhook all do (ADR-004).

## Admin conventions

- **`@Roles('admin')` sits on the controller class**, so a route added later cannot
  forget it.
- **The order state machine lives only in `admin/order-transitions.ts`.** The web app
  renders its buttons from the 409's `errors[]`, never from a copy of the table.
- **Stock moves by `adjust()` from `admin/stock-math.ts` under `FOR UPDATE`**; the
  pure functions there are the arithmetic every stock path shares.
- **Every product write calls `categories.invalidate()`**: the cached tree carries
  product counts.

## Cart conventions

- **Resolution order is fixed**: a valid access token wins and `X-Cart-Token` is
  ignored (combining them is a merge, an explicit endpoint); otherwise the token names
  a guest basket; otherwise one is created. An expired or unknown token yields a new
  basket, never a 404.
- **`X-Cart-Token` is sent on every guest response** and omitted for a user's basket.
- **Adding to the basket reserves nothing.** It 409s when stock is short, but two
  shoppers can both hold the last unit — reservation is checkout's job only.
- **Merging does not stock-check.** Signing in must not lose the basket because
  something sold out; checkout is where that becomes a 409 naming every short line.
- **Claiming a guest basket moves `user_id`, `token_hash` and `expires_at` together**,
  or `carts_single_owner_check` rejects the row.
- **No ESM-only Nest side packages.** `@nestjs/jwt` and `@nestjs/schedule` are both
  ESM at their current majors and unusable from a CommonJS build under Jest. Check
  `npm view <pkg> type` before adding one.

## Frontend conventions

- **Tokens live in `apps/web/src/index.css` under `@theme`**, not a
  `tailwind.config.ts` — Tailwind v4 is CSS-first. One neutral ramp, one `brand`
  ramp, three semantics, two radii, two shadows.
- **`brand` is the brand colour; `accent` is shadcn's hover surface.** Do not merge
  them. A bridging `@theme` block maps shadcn's names onto the ramp so its components
  stay upgradable.
- **Never `leading-tight` or `leading-none`.** Thai tone marks get clipped. Every type
  size already carries a safe line-height, and `npm test` in `apps/web` fails if a
  tight leading appears anywhere in `src/`.
- **After `npx shadcn add`, check two things**: it writes `import { cn } from "cn"`
  (a real, unrelated npm package) instead of `@/lib/utils`, and its components often
  carry `leading-none`.
- **Every empty state carries an action**, every error state surfaces the `traceId`,
  and loading uses a skeleton shaped like the content — not a spinner. See
  `src/components/state/`.
- **Vite proxies `/api` to the gateway in development**, so the browser sees one
  origin exactly as it does in production. No CORS is configured anywhere.

## Frontend session and checkout

- **Access token in memory, refresh token in localStorage** (a stated demo trade-off —
  production wants an httpOnly cookie). Only `src/auth/session.ts` touches them.
- **Never refresh concurrently**, in a tab or across tabs: `refresh()` shares one
  promise and holds a Web Lock, re-reading the token inside it. Two overlapping
  refreshes revoke the whole token family server-side.
- **User-scoped queries wait for `session.status !== 'unknown'`** and are keyed by user,
  or a reload asks as a guest before the session is restored.
- **The Idempotency-Key is created when the checkout page mounts**, and a ref — not
  `isPending` — guards against a second submit in the same tick.
- **Show errors with `describeError` or `<ErrorState error={…}>`**, which switch on the
  problem `type`. Never branch on `status` or message text — five problems share 409.
- **`npm run e2e` in `apps/web`** drives Chromium against the live stack
  (`make up-node` first). Anything the shopper does belongs there.

## Testing

`npm test` runs the unit and in-process HTTP suites and needs nothing. The
integration suites (`*.integration-spec.ts`, via `npm run test:integration`) need a
live database — `make up-infra` first — and skip loudly without one. They run
`--runInBand`: they share one database and mutate the same seeded stock rows, so in
parallel they race each other. Anything that is
genuinely a database behaviour belongs there: a double would only prove the double
works.

## Rules that are easy to get wrong

- **Lock variants in ascending UUID order** during checkout. Two carts sharing
  items in opposite orders deadlock otherwise. Both backends must sort
  identically or the cross-backend concurrency test fails.
- **Cart prices are live; order prices are frozen.** `GET /carts/me` recomputes
  line totals from current prices every time; `order_items` snapshots every
  field at checkout so editing or archiving a product cannot rewrite history.
- **Adding to the cart reserves nothing.** It returns 409 if the stock is not
  there, but the reservation happens only at checkout — otherwise stock sits
  locked against people who never buy.
- **Stock is adjusted by signed delta, never set absolutely.** Two admins each
  reading 40 and writing an absolute value silently lose one of the changes.
- **`availableStock` is `stock_on_hand - stock_reserved` computed at read time**
  and may already be stale. Checkout re-verifies under the row lock. Never make
  a sell/no-sell decision from it.
- **Payment confirm does not fulfil the order.** It marks the payment
  `processing`; the webhook is what decrements stock. Keeping that asymmetry is
  the only reason the webhook path ever gets tested.
- **Webhooks always return 200**, even for an unknown event type — a non-2xx
  makes a real provider retry forever. Verify the HMAC over the **raw** body
  (`rawBody: true` in `NestFactory.create`), not over a re-serialised object, and
  dedupe with `INSERT ... ON CONFLICT DO NOTHING` on `webhook_events`.
- **A 409 for insufficient stock lists every short line**, not just the first.
- **Idempotent means idempotent**: cancelling an already-cancelled order returns
  200 with the order; `POST /auth/logout` always returns 204; merging an unknown
  or already-merged cart token returns the current cart.
- **Computed state goes over the wire**, e.g. `cancellable` as a boolean. Three
  copies of a state machine (Node, Java, React) is three places to fix.
- **Never hand-write an API type in the frontend.** Import from `@/api/schema`,
  generated by `make gen-client`. A hand-written interface throws away the whole
  point of working contract-first.
- **Redis is optional by design.** Losing it entirely must make the system
  slower, never wrong. Nothing lives only in Redis.
- **403, not 404**, when a resource exists but is not yours.
- **Archive, never delete.** `order_items` holds `ON DELETE RESTRICT`.
- **Timestamps are `timestamptz(3)`.** The column truncates to milliseconds so
  both backends read back exactly what the API must render, instead of each
  rounding Postgres microseconds its own way.
- **IDs are UUIDv7 generated by the application** (`gen_random_uuid()` remains a
  column default for seeds and fixtures). Lock ordering compares the canonical
  lowercase string form, where TypeScript `sort()`, Java string compare, and SQL
  `ORDER BY id` all agree. See `docs/adr/008`.
- **Order numbers come from `nextval('order_number_seq')`**, formatted
  `ORD-<year>-<7 digits>`. The sequence is global, so numbering does not restart
  each year — a per-year reset would need a counter table (contention on every
  checkout) or a trigger (banned).
- **`min_price_cents` is maintained on write, never computed on read.** Both
  backends update it on variant insert, reprice, and deactivation.
- **Product search is trigram substring matching, not tsvector.** Use
  `WHERE (name || ' ' || description) ILIKE '%' || :q || '%'`. tsvector cannot
  work: Thai has no spaces between words, so the whole name becomes one token and
  a mid-word term matches nothing. Verified empirically, not assumed.

## Style

- UTF-8, LF, two-space indent — four for Java. See `.editorconfig`.
- Thai copy needs `line-height: 1.6` for body and no less than `1.35` for
  headings; Tailwind's `leading-tight` clips Thai vowels and tone marks.
- Scope creep is the top risk. Interesting ideas go in `docs/future.md` and are
  then left alone.
