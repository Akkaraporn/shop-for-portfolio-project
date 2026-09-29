# Idempotency

The second of the two things OpenAPI cannot describe. (The first is
[the cursor codec](cursor-format.md).)

`Idempotency-Key` is a header the contract can declare, but what makes it *mean*
anything is a fingerprint of the request it belongs to — and that fingerprint has to
be computed byte-identically by both backends. Get it wrong and a checkout retried
against the other backend is judged a **different** request and rejected with 422,
which is the worst possible answer to a retry.

**Test vectors: [`tests/fixtures/canonical-hash-vectors.json`](../tests/fixtures/canonical-hash-vectors.json).**
Both implementations must reproduce every canonical string and every hash in that
file. It is the real contract; this document explains it.

## The fingerprint

```
request_hash = lowercase_hex( sha256( utf8( canonicalJson(body) ) ) )
```

### canonicalJson

| rule | |
| --- | --- |
| **Object keys sorted**, recursively | By UTF-16 code unit, which for ASCII keys is alphabetical. Capitals before lowercase, matching Java's `String.compareTo`. |
| **Array order preserved** | An array is a sequence; reordering it is a different request. |
| **No whitespace** | Anywhere. |
| **Integers only** | See below. |
| **Strings escaped minimally** | Quote, backslash, and C0 controls — the five short forms, otherwise `\u00xx` lowercase. Everything else raw UTF-8, including all non-ASCII. |
| **`null` preserved** | A key set to null is not the same as an absent key. |
| **`undefined` omitted** | An object key holding `undefined` is dropped; `undefined` inside an array becomes `null`. Exactly `JSON.stringify` semantics. |

That last rule is not theoretical. The value hashed is the request **rebuilt from its
validated DTO**, not the raw parsed body, and `class-transformer` materialises a DTO's
absent optional fields as own properties set to `undefined`. Without this rule, adding
an optional field to a DTO would change the fingerprint of every request that omits it.

### Why integers only

There is no rendering of a non-integer double that every language agrees on.
JavaScript gives `1e-7` and `100000`; Java's `Double.toString` gives `1.0E-7` and
`100000.0`. Each difference changes the hash.

Restricting the canonical form to integers removes the whole class of problem, and
costs nothing: money is already integer satang (ADR-002) and no request body in this
contract carries a fractional number. A body containing one is refused with **422**,
naming the offending value — the request is well-formed JSON, it just contains
something that cannot be fingerprinted identically in two languages.

`-0` normalises to `0`. Same number, and `String(-0)` is `"0"` in JavaScript but
`"-0.0"` in Java.

### Why the JSON is hand-written

Same reason as the cursor codec: serialisers disagree about non-ASCII. Some emit raw
UTF-8, some escape everything above U+007F, and Jackson does either depending on
configuration. A Thai `recipientName` in a shipping address would change the bytes,
change the hash, and make a cross-backend retry look like a different request.

Both implementations share **one** escaping routine internally —
`canonicalString` is used by the canonical hasher and the cursor codec alike, so there
is exactly one thing for the Java side to match.

## The state machine

Keys are scoped `(user_id, endpoint, idempotency_key)`, enforced by a unique index.
One client's key can never collide with another's, and the same key may be reused on a
different endpoint.

| the key is… | the answer |
| --- | --- |
| absent | claim it, do the work |
| present, `in_progress` | **409** `checkout-in-progress` |
| present, `completed`, hash matches | **replay** the stored response, with `Idempotency-Replayed: true` |
| present, `completed`, hash differs | **422** `idempotency-key-reused` |

A mismatched hash is refused rather than resolved in either direction, because neither
is safe: replaying returns an order for a request that was never made, and proceeding
lets one key stand for two different requests.

An in-flight duplicate gets 409 rather than being blocked on. Holding the connection
open would tie up a worker for as long as the original takes, and a client retrying
during a slow checkout would queue behind itself.

### Two transactions, and why they cannot be one

```
Phase A   INSERT the key as in_progress            -- its own transaction
Phase B   lock, verify, create the order,          -- one transaction
          UPDATE the key to completed
```

Phase A commits on its own so the row is **visible to other requests immediately**.
Inside one big transaction it would stay invisible until commit, and two concurrent
requests with the same key would both sail past the check.

Phase B records the response **inside** the transaction that creates the order, so the
two commit together. A response recorded outside could survive a rollback and replay
an order that does not exist.

### Failure releases the key

Only **successful** responses are ever replayed. A failed attempt deletes its key, so a
retry is a genuine fresh attempt — which is what a client wants, since stock may have
changed. A failed checkout committed nothing, so there is nothing to protect.

Stripe replays errors too; here re-attempting is more useful and no less safe. The
`failed` status remains in the schema's `CHECK` for future use but is not written.

Completed keys expire after 24 hours.

## Concurrency, measured

Against a real PostgreSQL 16, in `checkout.integration-spec.ts`:

- **20 concurrent checkouts, one unit in stock** → exactly one 201, nineteen 409
  `insufficient-stock`. Afterwards `stock_reserved = 1`, `stock_on_hand = 1`, one held
  reservation. Nothing oversold.
- **8 concurrent retries of the same key** → exactly one order number across every
  success; the rest are 409 `checkout-in-progress`. Never two orders.
- **12 shoppers whose baskets share two variants in opposite orders** → all 12 succeed,
  zero 5xx. Without ascending-id lock ordering this is the classic deadlock, and
  PostgreSQL would kill one transaction — surfacing as a 500, not a 409.

## What the Java port must match

1. The canonical form and hash, byte for byte. Run the shared vectors.
2. The four-way state machine above, including which cases are 409 and which are 422.
3. **Lock ordering.** Variants are locked in ascending id order, compared as the
   canonical lowercase string (ADR-008). This is the deadlock defence, and it only
   works if both implementations sort identically.
4. Locking **one row at a time** in that order, not `WHERE id = ANY(...) ORDER BY id
   FOR UPDATE`. PostgreSQL does not guarantee rows are *locked* in the order they are
   returned — the planner may use a bitmap scan and lock in physical order, silently
   reintroducing the deadlock under exactly the concurrency this protects against. See
   ADR-004.
5. Everything the sweeper touches follows the same lock ordering. The rule is not
   "checkout sorts its locks", it is "everything that locks variants sorts them the
   same way".

## Implementation

- Canonical JSON: [`common/canonical/canonical-json.ts`](../apps/api-node/src/common/canonical/canonical-json.ts)
- Key state machine: [`checkout/idempotency.service.ts`](../apps/api-node/src/checkout/idempotency.service.ts)
- Checkout transaction: [`checkout/checkout.service.ts`](../apps/api-node/src/checkout/checkout.service.ts)
- Java: tasks 5.3 (codecs) and 5.5 (checkout)
