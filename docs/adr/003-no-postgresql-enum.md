# ADR-003: No PostgreSQL ENUM

Status: Accepted · Date: 2026-09-29

## Context

The schema has seven closed sets of values: user role, product status, order
status, payment status, payment method, reservation status, and idempotency key
status. PostgreSQL's native `ENUM` is the obvious way to model them, and the
contract already specifies how they appear on the wire — lowercase snake_case
strings, never integers.

Two problems make a native enum the wrong tool here, and both come from the
schema being shared by two ORMs rather than owned by one.

**The ORMs map them differently.** Prisma represents a native PostgreSQL enum as
a generated TypeScript enum. Hibernate needs `@Enumerated` plus, in practice, an
`AttributeConverter` to map a Java enum onto the type. Each side is then coupling
its type system to a database type that neither owns, and `ddl-auto: validate`
becomes fussy about a mapping that has no single obviously-correct form.

**Adding a value becomes a coordinated deployment.** `ALTER TYPE ... ADD VALUE`
is a schema change to a type that both applications have compiled expectations
about. It cannot be used in the same transaction that then uses the new value,
and the new value is invisible to any backend whose enum definition predates it —
so the migration and both deployments have to land together. For a project whose
entire premise is that either backend can be swapped in at any moment, a change
that requires both to move in lockstep is a direct contradiction.

## Decision

`VARCHAR` with a `CHECK` constraint listing the permitted values.

```sql
status varchar(24) NOT NULL DEFAULT 'pending_payment',
CONSTRAINT orders_status_check CHECK (status IN (
    'pending_payment', 'paid', 'fulfilled', 'completed',
    'cancelled', 'expired', 'payment_failed'
))
```

The database still rejects every value outside the set — the guarantee is
identical — but the column's type is a string that both ORMs map to a string
without ceremony, and the set of legal values belongs to the migration rather
than to a type either application has an opinion about.

Verified in `tests/schema/verify-constraints.sql`: inserting an order with status
`'shipped'` is rejected.

## Alternatives considered

- **Native `ENUM`.** Four bytes per value instead of the string, and ordering
  follows declaration order rather than the alphabet. Rejected for the two
  reasons above; neither benefit is worth anything here. Storage is irrelevant at
  this scale, and nothing in the API orders by an enum column.
- **Lookup tables with foreign keys.** The most normalised option, and it makes
  the value set queryable at runtime. Rejected as seven extra tables and seven
  extra joins to express seven closed sets that change only when the code
  changes. A value set that ships with a deployment is not reference data.
- **No database constraint; validate in the application only.** Rejected because
  the two implementations would then each be the only thing standing between a
  typo and a corrupt row, and they would have to be wrong in the same way to stay
  consistent. The database is the one place a rule can be enforced once for both.
- **A `DOMAIN` over `text` with the `CHECK` attached.** Genuinely appealing: the
  constraint is defined once and reused across columns. Rejected because ORM
  introspection support for domains is uneven — `prisma db pull` does not model
  them usefully — and the whole point is that both ORMs read this schema without
  friction.

## Consequences

- Adding a status is an ordinary migration that replaces one `CHECK` constraint.
  No type surgery, no lockstep deployment, and the old backend keeps working
  because a string is a string.
- A `CHECK` cannot be enumerated at runtime the way a type can. Nothing needs to:
  the invalid-transition 409 has to report which states are reachable from the
  current one, and that is a state machine in code, not a list of values in the
  database. It would need to live in code even with a native enum.
- Ordering a `VARCHAR` status column sorts alphabetically, not in lifecycle order.
  No endpoint does this, and if one ever needs to, it needs an explicit sort key
  rather than an accident of declaration order.
- A violation raises `check_violation` rather than `invalid_text_representation`.
  The global Problem filter (task 2.1) maps constraint violations to 409, so both
  backends must classify this the same way.
- The permitted values now exist in three places: the `CHECK` constraint, the
  OpenAPI enum, and each implementation's type. The contract is the source of
  truth and the Spectral rule `enum-values-are-snake-case` keeps its half honest,
  but adding a value means touching a migration and the contract together. That
  duplication is the real price of this decision, and it is smaller than the
  coordinated deployment it replaces.
