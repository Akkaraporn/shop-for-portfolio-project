# ADR-002: Money as integer minor units

Status: Accepted · Date: 2026-09-29

## Context

Every price, subtotal and total crosses the wire as JSON, is stored in one
PostgreSQL database, and is produced by two implementations that must agree byte
for byte. Money is the field most likely to break that agreement, for a reason
that has nothing to do with either language being wrong.

**JSON has no decimal type.** A JSON number is a decimal literal with no declared
scale, and every serialiser is free to render the same value differently.
Measured in this project's Node 24:

```js
JSON.stringify(129.50)  // "129.5"   — trailing zero gone
JSON.stringify(129.0)   // "129"     — looks like an integer now
```

So a "decimal" price cannot survive a round trip with its scale intact. That is
not a JavaScript defect; it is what a JSON number is.

The two ORMs then diverge on top of that. Prisma's `Decimal` serialises to a JSON
*string* to preserve precision, while Jackson's `BigDecimal` serialises to a JSON
*number* that keeps its scale (`129.50`). Same database row, two different JSON
values — `"129.5"` from one backend and `129.50` from the other — and the
difference is invisible until a client does arithmetic on it or a contract test
compares responses. This half is documented library behaviour rather than
something measured here; there is no Java toolchain on this machine yet, and it
should be confirmed in Phase 5.

Floating point is a separate disqualifier, also measured:

```js
0.1 + 0.2 === 0.3   // false  → 0.30000000000000004
1290.50 * 3         // 3871.5           (fine here, not in general)
129050 * 3          // 387150           (exact, always)
```

## Decision

Money is an integer count of the currency's minor unit — satang for THB.
`BIGINT` in PostgreSQL, `integer` in the OpenAPI schema, and every such field
name ends in `Cents`: `priceCents`, `subtotalCents`, `shippingCents`,
`totalCents`, `minPriceCents`, `unitPriceCents`, `lineTotalCents`.

The naming is enforced rather than trusted. Two Spectral rules in
`contract/.spectral.yaml` fail the build if a field ending in `Cents` is not an
integer, or if a field is named like money (`...price`, `...amount`, `...total`,
`...fee`) without the suffix. A `NUMERIC` cannot quietly reappear later.

## Alternatives considered

- **`NUMERIC` in the database, decimal string in JSON** (`"129.50"`). Precise, and
  it does preserve scale. Rejected because every consumer must parse the string
  before doing anything with it, which means each language picks its own decimal
  library and the two must then agree on rounding — replacing one shared problem
  with two independent ones. It also makes ordinary arithmetic in the frontend
  require a dependency.
- **`NUMERIC` in the database, JSON number on the wire.** Rejected by the
  measurements above: the scale is lost in serialisation, so the two backends
  cannot be made to agree on the rendering even though they agree on the value.
- **`DOUBLE PRECISION` / float.** Rejected. `0.1 + 0.2 !== 0.3` is enough on its
  own, and the errors compound across line totals.
- **A structured money object**, `{ "amount": 12950, "currency": "THB", "scale": 2 }`.
  Self-describing and the right answer for a genuinely multi-currency system.
  Rejected as three fields carrying one number in a single-currency shop; it
  triples the surface every schema and test has to cover. `currency` is carried
  once per response instead, which marks the seam without paying for it.
- **Storing satang but exposing decimals at the API edge.** Rejected because the
  conversion then happens twice, in two languages, and the rounding rule becomes
  another thing the contract cannot express and the parity suite must police.

## Consequences

- Display is the frontend's job: one formatter that divides by 100 and renders
  `฿1,290.50`, used everywhere. Nothing else in the system ever divides.
- Integers are exact in JavaScript up to `Number.MAX_SAFE_INTEGER`
  (9,007,199,254,740,991), which in satang is about THB 90 trillion. No BigInt
  handling needed, and no silent precision loss at any plausible order value.
- There is no sub-satang precision. THB has no smaller unit, so this costs
  nothing for prices — but it means any future percentage-based discount needs an
  explicit rounding rule written down before it is implemented. That is one of
  the reasons coupons and promotions are out of scope (`docs/future.md`).
- `BIGINT` rather than `INTEGER` costs four bytes a row and removes any question
  about headroom.
- The Spectral rules make this decision self-enforcing, which matters more than
  the decision itself: an ADR nobody re-reads is a comment, whereas a failing
  lint is a conversation.
- Phase 5 should verify the Jackson half of the Context above with a real
  serialisation test rather than trusting this document.
