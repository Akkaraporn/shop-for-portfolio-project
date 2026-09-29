# ADR-005: Idempotency keys live in the shared database

Status: Accepted · Date: 2026-09-29

## Context

`POST /checkout` reserves stock, creates an order, and creates a payment. A duplicate
is expensive in a way no other operation here is: the shopper sees two orders, stock
is reserved twice, and unwinding it is manual.

Duplicates are not hypothetical. The request that most needs protection is the one
after a timeout, where the client genuinely cannot tell whether the first attempt
succeeded — and that is precisely when a client retries.

Three things had to be decided: where the keys live, what a key is compared against,
and what happens to a key when the request fails.

## Decision

**Keys live in `idempotency_keys`, in the shared PostgreSQL database**, scoped
`(user_id, endpoint, idempotency_key)` with a unique index.

**`Idempotency-Key` is required, not optional**, on this one endpoint.

**A key is compared against a canonical hash of the request body**, specified in
[`docs/idempotency.md`](../idempotency.md) and pinned by shared vectors.

**A failed attempt releases its key.** Only successful responses are stored and
replayed.

The state machine:

| the key is… | the answer |
| --- | --- |
| absent | claim it, do the work |
| `in_progress` | 409 `checkout-in-progress` |
| `completed`, hash matches | replay the stored response, `Idempotency-Replayed: true` |
| `completed`, hash differs | 422 `idempotency-key-reused` |

Claiming happens in its **own** transaction so the row is visible to concurrent
requests immediately; completing happens **inside** the checkout transaction so the
stored response and the order commit together.

## Alternatives considered

- **Keys in Redis.** The usual choice: a `SET NX` with a TTL is exactly this shape, and
  it is faster. Rejected because it would break the demo this project exists for. The
  two backends share one database and nothing else, so a key written by NestJS must be
  visible to Spring Boot for a retry to replay across the swap. In Redis it would be,
  only if both were pointed at the same instance and agreed on a serialisation the
  contract cannot describe — the same argument as ADR-006. In Postgres it is a row, and
  the unique index does the arbitration for free.
- **Optional `Idempotency-Key`.** More forgiving, and what most APIs do. Rejected
  because a client that must opt in to safety will forget on the path that matters.
  Making it mandatory costs a client one `randomUUID()` and removes an entire class of
  support incident.
- **Key alone, without a request hash.** Simpler. Rejected because a client that reuses
  a key for a genuinely different order would silently receive the first order back,
  and believe its second order exists. The hash turns a silent wrong answer into a 422
  that names the bug.
- **Replaying failures as well as successes.** Stripe does this. Rejected because the
  common failure here is `insufficient-stock`, which is *transient* — restocking, or
  another shopper's reservation expiring, changes the answer. Replaying a stale 409
  would tell a shopper an item is unavailable when it is back. A failed attempt
  committed nothing, so there is nothing to protect by holding the key.
- **Blocking on an in-flight duplicate instead of 409.** Nicer for the client, which
  would get the real answer rather than "try again". Rejected because it ties up a
  worker for as long as the original takes, and a client retrying during a slow
  checkout would queue behind itself — turning one slow request into several.
- **A single transaction for claim and work.** Fewer moving parts. Rejected because it
  does not work: the `in_progress` row would be invisible to other transactions until
  commit, so two concurrent requests with the same key would both pass the check. The
  two-phase split is what makes the claim mean anything.

## Consequences

- A retry against the **other backend** replays instead of placing a second order.
  This is the project's headline demonstration, and it is a consequence of this
  decision rather than an extra feature.
- Every checkout writes an extra row and updates it. Negligible next to the order,
  items, reservations, payment and outbox event it sits alongside.
- The table grows and needs collecting. Keys carry `expires_at` (24 hours) and the
  index on it is there for a sweeper; cleanup is not yet implemented, which is
  acceptable because nothing reads an expired key — `begin` treats a missing row as
  claimable. Worth adding with the other maintenance jobs.
- The window between claiming a key and completing it is covered by releasing the key
  on **any** thrown error. If the process dies between the two, the key is left
  `in_progress` and that client's retries get 409 until it expires. The alternative —
  no claim until the work is done — permits duplicates, which is strictly worse. A
  reaper that releases stale `in_progress` keys older than the checkout timeout would
  close this properly and belongs with the cleanup job above.
- `response_body` is stored as JSONB, so a replay returns byte-equivalent JSON without
  re-reading the order. It also means a replayed response does **not** reflect later
  changes to the order — correct, because it is a replay of what was said, not a fresh
  read. A client wanting current state calls `GET /orders/{orderNumber}`.
- The `failed` status in the schema's `CHECK` is unused. Left in place: it costs
  nothing and a future reaper may want to distinguish abandoned keys from released
  ones.
