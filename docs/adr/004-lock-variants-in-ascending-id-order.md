# ADR-004: Lock variants in ascending id order, one at a time

Status: Accepted · Date: 2026-09-29

## Context

Checkout takes a pessimistic row lock on every variant in the basket, re-verifies
stock under that lock, and increments `stock_reserved`. Two things then have to be
decided: what order the locks are taken in, and how they are taken.

The order matters because of the oldest concurrency bug there is. Two shoppers, two
baskets sharing the same two variants in opposite orders:

```
A: cart [X, Y]   locks X, waits for Y
B: cart [Y, X]   locks Y, waits for X
```

Neither can proceed. PostgreSQL's deadlock detector notices after `deadlock_timeout`
(one second by default) and kills one transaction with SQLSTATE `40P01`. The victim
surfaces as a **500** — not a 409 — so a shopper is told the shop is broken when in
fact their order was perfectly placeable. It is also load-dependent, which means it
passes every test written before anyone thought to run two checkouts at once.

The second decision is subtler and is the reason this ADR exists rather than a
comment. The obvious implementation is one query:

```sql
SELECT ... FROM product_variants WHERE id = ANY($1) ORDER BY id FOR UPDATE
```

That looks like it takes the locks in ascending id order. It usually does. But
PostgreSQL does not guarantee it: `ORDER BY` constrains the order rows are *returned*,
not the order they are *locked*. The planner is free to use a bitmap heap scan and
lock in physical order, and it becomes more likely to as the table grows or statistics
change. The failure that reappears is exactly the one this design is meant to prevent,
under exactly the concurrency that makes it hard to reproduce.

## Decision

Sort the variant ids in the application, then lock them **one at a time** in that
order, each with its own `SELECT ... FOR UPDATE`.

```ts
const ordered = [...new Set(variantIds)].sort();
for (const id of ordered) {
  await tx.$queryRaw`SELECT ... FROM product_variants v ... WHERE v.id = ${id}::uuid FOR UPDATE OF v`;
}
```

Ordering is on the **canonical lowercase hyphenated UUID string** (ADR-008), the one
form where TypeScript's `sort()`, Java's `String.compareTo` and SQL's `ORDER BY id`
all agree.

The same rule binds everything that locks variants, not just checkout. The reservation
sweeper sorts its locks the same way, because a sweeper and a checkout touching the
same variant in different orders deadlock just as readily as two checkouts.

## Alternatives considered

- **One query with `ORDER BY id FOR UPDATE`.** Fewer round trips and the common idiom.
  Rejected for the reason above: the ordering is not guaranteed, and the failure it
  reintroduces is silent, intermittent and load-dependent. The cost of the alternative
  is a handful of round trips inside a transaction that is already doing a dozen
  writes.
- **Optimistic locking with a version column.** No locks held, retry on conflict. A
  perfectly good design, and rejected for a project-specific reason: the Java port
  would have to reproduce the retry behaviour exactly, including how many times and
  with what backoff, or the two backends would give different answers under the
  concurrency test in 4.3. Pessimistic locking has one observable behaviour — you wait,
  then you win or you get a 409 — which is far easier to match.
- **`SELECT ... FOR UPDATE NOWAIT` or `SKIP LOCKED`.** Would turn contention into an
  immediate failure instead of a wait. Rejected because under the demo's own
  conditions — twenty people going for the last unit — nineteen of them would get a
  lock error rather than the honest "out of stock" answer they should get.
- **Serialisable isolation.** Correct, and it moves the problem rather than solving it:
  serialisation failures would need a retry loop that both implementations must match.
- **A single advisory lock over the whole checkout.** Trivially deadlock-free and it
  serialises every checkout in the system, which throws away all concurrency to fix a
  problem that sorting solves.

## Consequences

- One round trip per distinct variant, inside the transaction. For a realistic basket
  that is one to five extra queries against a local socket.
- Locks are held for the duration of the checkout transaction, so it must stay short.
  Nothing slow belongs inside it — no HTTP calls to a payment provider, which is part
  of why `confirm` is a separate request and the webhook is what fulfils an order.
- The transaction timeout is raised to 15 seconds, well above what this work takes, so
  a timeout mid-flight cannot roll back an order the client already believes in. Still
  bounded, so nothing can hold locks indefinitely.
- Duplicate variant ids are collapsed before locking. A basket cannot contain the same
  variant twice — the unique index on `cart_items(cart_id, variant_id)` prevents it —
  but locking the same row twice in one transaction is harmless and deduplicating is
  cheaper than reasoning about whether it can happen.
- **This is testable, and tested.** Twelve shoppers with baskets holding the same two
  variants in opposite orders all check out successfully, with zero 5xx. Before the
  ordering rule that scenario is a deadlock; the test would go red rather than the bug
  going unnoticed.
