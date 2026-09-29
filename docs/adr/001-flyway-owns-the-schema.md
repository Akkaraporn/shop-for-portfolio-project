# ADR-001: Flyway owns the schema

Status: Accepted · Date: 2026-09-29

## Context

Two backends — NestJS with Prisma and Spring Boot with JPA — serve one contract
against one PostgreSQL database. Both of their ORMs want to own the schema, and
each does it a different way.

Prisma's model is that `schema.prisma` is the truth: `prisma migrate` diffs it
against the database and generates SQL. Hibernate's `ddl-auto: update` inspects
the entity classes and mutates the database to match them. Both work well when
one application owns its own database. Neither has any concept of a peer.

Whichever one is given ownership, the other becomes a follower that cannot
express anything the owner did not think of — and worse, a follower that drifts
silently. Hibernate's `update` never drops or narrows anything, so a column
Prisma renamed simply accumulates as a second column nobody notices. Prisma's
migrate, pointed at a database Hibernate has been mutating, sees the drift as
changes to be reverted.

The parity suite makes this sharper than it would be on a normal project. Its
entire premise is that both implementations read exactly the same schema. If the
schema is a function of one backend's source code, then a parity failure can
always be argued away as the other backend not having caught up, and the suite
stops being evidence of anything.

## Decision

Flyway owns all DDL, exclusively. Versioned SQL lives in `migrations/` and is
hand-written.

Both ORMs are demoted to readers:

- Prisma runs `db pull` to generate `schema.prisma` *from* the database, then
  `generate`. `prisma/migrations/` is deleted, and `prisma migrate` is never run.
  `make gen-prisma` is the whole loop.
- JPA runs `ddl-auto: validate`. It checks its entities against the live schema
  at boot and refuses to start on a mismatch.

The compose stack enforces the ordering: the Flyway container runs once and
exits, and both backends wait on
`depends_on: flyway: { condition: service_completed_successfully }`. It is
therefore not possible for a backend to boot against a schema that has not been
migrated.

## Alternatives considered

- **`prisma migrate` owns it, Spring Boot follows.** The natural choice, since
  the NestJS side is built first. Rejected because Prisma's migration SQL is
  generated for Prisma: it expresses what its own schema language can express,
  and the constraints this project depends on — the `CHECK` that keeps
  `stock_reserved <= stock_on_hand`, the partial unique indexes on `carts`, the
  `pg_trgm` expression index — are either unrepresentable or awkward in it. The
  schema would have been shaped by a client library rather than by the problem.
- **`ddl-auto: update` owns it.** Rejected outright. It is additive-only, so it
  cannot express a rename or a narrowing, and the schema becomes whatever
  sequence of entity edits happened to be applied in what order. Not reviewable,
  not reproducible.
- **Liquibase instead of Flyway.** Equivalent for this purpose. Flyway chosen for
  plain `.sql` files with no XML or YAML abstraction over DDL — the schema is
  read by humans writing two implementations against it, so it should be SQL.
- **A schema per backend, or two databases.** Removes the conflict entirely and
  also removes the point of the project. Shared state is what makes a cursor
  issued by Node usable against Java, and what makes a checkout retried against
  the other backend replay instead of double-charging.
- **`ddl-auto: none` rather than `validate`.** Simpler, and it is what most
  deployments use. Rejected because `validate` is a free parity check on every
  boot: it catches an entity mapping that has drifted from the schema at startup
  rather than at the first query that touches the column.

## Consequences

- Every schema change is hand-written SQL, then `make gen-prisma` before the Node
  side compiles against it. An extra step, and the one that makes the rest work.
- `ddl-auto: validate` is strict about type mappings. Getting a Java column type
  subtly wrong now fails at boot, loudly, instead of at runtime. This is the
  point, but it will cost time in Phase 5.
- Prisma features that assume it owns migrations are unavailable: no shadow
  database, no `migrate dev`, no `migrate diff` workflow.
- Flyway's `flyway_schema_history` table lives in the schema, so anything that
  counts tables has to exclude it.
- `db pull` regenerates `schema.prisma` wholesale, so hand edits to it are lost.
  Anything Prisma needs that cannot be derived from the database has to live
  outside that file.
- Because the ordering is enforced in compose rather than by convention, the
  failure mode "backend started before migrations finished" is structurally
  impossible rather than merely unlikely. That class of intermittent bug is
  extremely hard to diagnose when it does occur, which is why it is worth
  spending a `depends_on` condition to rule out.
