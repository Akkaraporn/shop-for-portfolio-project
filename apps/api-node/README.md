# api-node

The NestJS implementation, and the reference one: whatever this does is what the
Spring Boot port in Phase 5 has to match.

## `prisma migrate` is permanently disabled

Flyway owns the schema. Prisma is a **reader**.

```bash
make gen-prisma      # from the repo root: migrate, then db pull, then generate
```

- `prisma/migrations/` does not exist and must never be created.
- `prisma db push`, `prisma migrate dev`, `prisma migrate deploy` — none of them
  are run on this project. If you run one, revert the database from
  `migrations/V1__init.sql` and re-pull.
- `prisma/schema.prisma` is **generated output** below its `datasource` block.
  `db pull` rewrites the file wholesale, so hand edits are lost.
- Re-run `make gen-prisma` after every new Flyway migration, or the client's types
  and the database disagree and nothing tells you until a query fails.

Why: if Prisma owned migrations, Spring Boot could only follow, and the schema
would be shaped by what one client library can express — losing the `CHECK`
constraints, the partial unique indexes on `carts`, and the `pg_trgm` expression
index this project depends on. Full reasoning in
[ADR-001](../../docs/adr/001-flyway-owns-the-schema.md).

Prisma warns on `db pull` that it cannot represent the check constraints. That is
expected and is the point: they are enforced by the database for both backends,
regardless of what either ORM knows about them.

## Running it

From the repo root, the whole stack:

```bash
make up-node                 # gateway on :8080, API under /api/v1
```

Or on the host against the containerised data layer, which is the faster inner
loop while building a module:

```bash
make up-infra                # Postgres, Redis, Flyway, gateway
cd apps/api-node
DATABASE_URL="$DATABASE_URL_HOST" REDIS_URL="$REDIS_URL_HOST" npm run start:dev
```

`DATABASE_URL_HOST` and `REDIS_URL_HOST` are in `.env` — the host ports are
deliberately not 5432 and 6379, because a locally installed Postgres or Redis
would shadow the container and connections would fail authentication in a way that
looks like a credentials bug.

## Layout

```
src/
  bootstrap.ts              global filter, pipe, middleware — shared with the tests
  main.ts                   entry point
  config/                   zod-validated environment; nothing else reads process.env
  common/
    logging/                pino, and the request id in AsyncLocalStorage
    problem/                RFC 9457 filter, the type registry, the validation pipe
    pagination/             the cursor codec
  infra/
    prisma/                 the client; connects eagerly so misconfiguration fails at boot
    redis/                  optional by design — every method degrades, none throws
  health/                   /health and /ready
```

`bootstrap.ts` exists so the test suite configures its application through exactly
the function `main.ts` uses. A test that assembles its own pipeline cannot catch
the failures that matter here, which are precisely the ones where a global filter
or pipe is registered differently from production.

## Tests

```bash
npm test          # unit + in-process HTTP
npm run typecheck
```

No database or Redis is needed: the HTTP suites substitute both, which is how the
"Redis is down but readiness still passes" and "Postgres is down so readiness is
503" cases get tested at all.

The cursor suite reads
[`tests/fixtures/cursor-vectors.json`](../../tests/fixtures/cursor-vectors.json),
shared with the Java port. Those vectors are the contract for that codec.
