# Web Store for portfolio

One web store API, defined once and implemented twice.

`contract/openapi.yaml` is the source of truth. Two backends implement it —
NestJS and Spring Boot — against a single PostgreSQL schema owned by Flyway. One
contract test suite runs against both and reports whether they agree.

```bash
cp .env.example .env
make up-infra    # Postgres + Redis + Flyway + gateway — works today
make up-node     # http://localhost:8080 — gateway -> NestJS        (from task 2.8)
make up-java     # same store, same URL, gateway -> Spring Boot     (from task 5.1)
```

Nothing in the browser changes between the last two commands. `GET /api/v1/health`
is the only way to tell which implementation answered.

## Why two backends

Because it is the only way to make the contract mean something. A spec that one
implementation satisfies is a description of that implementation. A spec two
independent implementations satisfy — sharing a database, passing the same
concurrency and idempotency tests, honouring cursors issued by the other — is an
actual contract.

The interesting failures are not in the CRUD. They are in the places OpenAPI
cannot describe: how a pagination cursor is encoded, and how a request body is
canonicalised before it is hashed for idempotency. Those are written down in
`docs/` precisely because two implementations will otherwise each invent their
own and drift.

## Layout

```
contract/openapi.yaml   source of truth: every endpoint's shape
migrations/             Flyway — owns the entire schema
apps/web/               React + Vite, types generated from the contract
apps/api-node/          NestJS (reference implementation)
apps/api-java/          Spring Boot (port; must match byte for byte)
tests/parity/           one suite, run against either backend
infra/                  compose stack + nginx gateway
docs/adr/               why each decision was made
TASKS.md                the plan
CLAUDE.md               the rules both implementations must follow
```

Run `make` with no arguments for the available commands.

## Status

Phase 1 in progress. The repo is scaffolded and **the contract is closed**: 25
paths, 26 operations, 46 schemas, clean under `make lint-contract`. Every
operation carries a description of what it returns and how it fails, so neither
backend has to guess.

The schema is in too: 15 tables, 36 check constraints, 50 indexes, applied by
Flyway and seeded with a shop that opens onto real products. `make db-verify`
proves the constraints reject what they claim to, by trying to break each one.

Demo accounts, all with the password `DemoPass123!`:
`admin@vibecode.shop` (admin), `somchai@example.com`, `pimchanok@example.com`.

Phase 1 is complete. The infrastructure runs: `make up-infra` brings up Postgres,
Redis, Flyway and the nginx gateway, all reporting healthy, and the backend swap
is already proven — pointing `BACKEND_HOST` at a different upstream changes which
implementation answers `/api/v1/health` with no client change at all.

Phase 2 is under way. `apps/api-node` has the foundation — zod-validated
configuration, an RFC 9457 exception filter that nothing escapes, pino logging
correlated by request id, `/health` and `/ready`, the cursor codec — and auth:
argon2id, a login that leaks neither timing nor which addresses are registered, and
refresh-token rotation that revokes a whole token family when a consumed token is
replayed. and the catalogue: a category tree cached in Redis, cursor-paginated product
listing with four sorts, trigram search that works on Thai, and product detail.

and the basket: guest baskets that survive registration, live pricing, and a merge
that is safe to retry.

And checkout, which is the point of the whole exercise: an idempotency key that
replays across a backend swap, variant locking that survives twenty people going for
the last unit, and a 409 that names every short line at once.

And the purchase completes: order history, cancellation that returns stock, and a
mock provider that posts a real signed webhook back — the only thing in the system
that decrements stock.

Phase 3 has begun with the design foundation: self-hosted Thai/Latin type with
line-heights that do not clip tone marks, a deliberately small palette whose contrast
is asserted arithmetically rather than eyeballed, shadcn components, and the
loading/empty/error states most portfolios skip.

**The shop now works in a browser**: browse, search in Thai, fill a basket as a guest,
register without losing it, check out, pay with a test card, and watch the order turn
paid when the provider's webhook lands. Run `make up-node`, then `npm run dev` in
`apps/web` and open http://localhost:5173.

The web app adds 72 unit tests and 10 end-to-end tests that drive a real Chromium
through that whole journey — including five simultaneous checkout submits producing
one order, two shoppers racing for the last unit, and two tabs refreshing a session at
the same instant.

Backend: 298 tests — 162 that need nothing, and 136 that run against a live PostgreSQL 16
because what they check (the recursive category CTE, keyset pagination, trigram
search, row locking under real concurrency) is database behaviour a test double could
not prove.

After cloning, install the hooks once — contract changes then lint before every
commit:

```bash
make hooks
```

See `TASKS.md` for the plan and
[the board](https://app.clickup.com/90182767626/v/o/s/1100450000000236) for
per-task detail.

## Decisions worth knowing up front

These are deliberate, not omissions. Full reasoning in `docs/adr/`.

- **Flyway owns the schema.** Prisma reads it (`db pull`); JPA validates against
  it (`ddl-auto: validate`). Neither ORM may write it, or the other drifts.
- **Money is integer minor units**, in fields ending `Cents`. Decimals serialise
  differently in Jackson and Prisma, which breaks the contract silently.
- **No PostgreSQL `ENUM`** — `VARCHAR` + `CHECK` gives the same guarantee without
  tying the schema to how one ORM maps native enums.
- **The cart lives in Postgres, not Redis.** In Redis it would force the two
  backends to agree on a serialisation format the contract cannot describe.
- **Idempotency keys live in the shared database**, so a checkout can be retried
  against the *other* backend and replay instead of double-charging.
- **Flat shipping rate, single currency (THB), no dark mode.** All three are
  scope decisions, recorded in `docs/future.md`.
