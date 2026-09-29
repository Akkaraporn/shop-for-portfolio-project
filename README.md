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

**Phases 1–3 are complete: the shop runs end to end on the NestJS backend.**

```bash
make up-node        # then open http://localhost:8080
```

That one command builds and starts Postgres, Redis, Flyway, the API, the web app and
the gateway. The shopper can browse, search in Thai, fill a basket as a guest,
register without losing it, check out, pay with a test card, and watch the order turn
paid when the provider's webhook lands. The admin can create products with their
variants, adjust stock, and move paid orders through fulfilment.

Demo accounts, all with the password `DemoPass123!`:
`admin@vibecode.shop` (admin), `somchai@example.com`, `pimchanok@example.com`.
Test cards are offered as buttons on the payment step: one succeeds, one is declined.

What is proven, and how:

- **Backend — 371 tests.** 220 need nothing; 151 run against a live PostgreSQL 16,
  because what they check (keyset pagination, trigram search on Thai, twenty
  checkouts racing for the last unit, a webhook delivered five times decrementing
  stock once, two admins racing on one order) is database behaviour a double could
  not prove.
- **Web — 84 unit tests and 15 end-to-end tests** in a real Chromium against the
  built image: the whole purchase, five simultaneous checkout submits making one
  order, two tabs refreshing one session at the same instant, and the back office.
- **The schema** — 15 tables, 36 check constraints — and `make db-verify` tries to
  break every one of them.

Phase 5, the Spring Boot port, is next: the same contract, the same database, and the
same suites, which is what proves the two are interchangeable.

### The admin order queue has no state machine

The back office never decides which status an order may move to. It asks the server
to move the order to the status it already has — never a transition, so always a
`409 invalid-transition` with no side effect — and renders one button per state the
409 lists as reachable. If another admin moves the order in the meantime, the click's
own 409 carries the new list. The order state machine exists once per backend and
zero times in the frontend, so changing it cannot leave a stale copy in the UI.

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
