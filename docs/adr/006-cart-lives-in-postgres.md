# ADR-006: The cart lives in PostgreSQL, not Redis

Status: Accepted · Date: 2026-09-29

## Context

A shopping basket is the textbook case for Redis. It is short-lived, written far more
often than it is read from cold, needs a TTL for guests, and losing one is an
annoyance rather than a financial event. Every instinct says cache.

This project has a constraint that overrides the instinct: the basket has to be
readable and writable by **two independent implementations** of one contract, and a
single test suite has to prove they agree.

That changes what the storage choice costs. In Redis, a basket is whatever bytes the
application chose to put there — a hash, a JSON blob, a list of packed strings. The
contract cannot describe that format, because it never crosses the wire. So the two
backends would have to agree on it out of band, and nothing would check that they had:
the parity suite compares HTTP responses, and two implementations can serialise a
basket completely differently while both producing the same JSON for
`GET /carts/me`. The divergence would only surface the first time a basket was written
by one backend and read by the other — which is exactly the cross-backend scenario
task 4.3 exists to exercise, and exactly the one that would fail for a reason no test
could localise.

There is also a smaller, sharper problem. The guest basket has to survive being
claimed at registration, which means a row in `carts` gaining a `user_id`. If the
basket were in Redis and the claim were in Postgres, that single logical operation
would span two stores with no transaction over both.

## Decision

`carts` and `cart_items` are ordinary PostgreSQL tables.

- One basket per user, enforced by a partial unique index on `carts(user_id)`.
- One basket per guest token, enforced by a partial unique index on
  `carts(token_hash)`; only the SHA-256 of the token is stored.
- `carts_single_owner_check` makes "belongs to a user" and "belongs to a guest token"
  mutually exclusive and jointly exhaustive, with `expires_at` present exactly when
  the basket is a guest's.
- One line per variant, enforced by a unique index on `cart_items(cart_id, variant_id)`
  — which is what makes add-to-cart an upsert rather than a source of duplicate lines.
- No price column on `cart_items`. Line totals are recomputed from the variant on
  every read.

Redis keeps the jobs where a cache is the right tool and losing it is survivable: the
category tree, rate limiting, and the sweeper lock.

## Alternatives considered

- **Redis with a documented serialisation format.** The honest version of the Redis
  option: write the format down as carefully as `docs/cursor-format.md` documents the
  cursor codec, and have both backends implement it. Rejected because it adds a third
  hand-specified binary-compatible format to a project that already has two, and
  unlike those two it buys nothing the contract needs — the cursor codec and the
  canonical hash exist because the *contract* requires them, whereas this would exist
  only because of the storage choice.
- **Redis as a write-through cache over the Postgres tables.** Keeps Postgres
  authoritative and makes reads fast. Rejected as premature: a basket is read by
  exactly one shopper, so there is no fan-out to amortise, and every cache is a
  second place for the two implementations to disagree about invalidation. Worth
  revisiting only under measured load (`docs/future.md`).
- **Redis for guest baskets, Postgres for user baskets.** Tempting, because guests are
  the volume and the ones with a TTL. Rejected because it makes the claim-at-
  registration path a cross-store move with no transaction, and because it doubles
  every cart code path in both backends — one of which would be the one with a bug.
- **Client-side basket, in localStorage, posted at checkout.** No server storage at
  all. Rejected because prices then cannot be live — the client would show whatever it
  cached until checkout — and because the basket would not follow a shopper between
  devices, which is most of why an account is worth creating.

## Consequences

- Every basket mutation is a database write. At this project's scale that is
  irrelevant, and it is the thing that makes the basket testable across backends.
- Guest baskets accumulate rows and need collecting. `CartSweeperService` deletes
  expired ones daily, and the resolver already filters on `expires_at` so an
  uncollected row is never handed back. Cleanup being late is harmless.
- Reading a basket is a join across `cart_items`, `product_variants`, `products` and
  `product_images`. One query, indexed, and it is what makes live pricing possible.
- The `carts_single_owner_check` constraint means claiming a guest basket must move
  `user_id`, `token_hash` and `expires_at` **together**. A partial claim is rejected by
  the database rather than producing a basket in an impossible state — verified in
  `tests/schema/verify-constraints.sql`.
- Losing Redis entirely does not affect the basket at all, which is the project's
  standing rule: the cache makes things faster and never changes an answer.
