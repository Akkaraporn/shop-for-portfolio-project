# VibeCode Store

One web store API, defined once and implemented twice.

`contract/openapi.yaml` is the source of truth. Two backends implement it —
NestJS and Spring Boot — against a single PostgreSQL schema owned by Flyway. One
contract test suite runs against both and reports whether they agree.

```bash
cp .env.example .env
make up-node     # http://localhost:8080 — gateway -> NestJS
make up-java     # same store, same URL, gateway -> Spring Boot
```

Nothing in the browser changes between those two commands. `GET /api/v1/health`
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

Next: `V1__init.sql` and the seed data (task 1.3), then the NestJS
implementation. No backend code exists yet.

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
