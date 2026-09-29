# Cursor format

OpenAPI can say that `cursor` is a string. It cannot say what the string *is*, so
this is one of the two places where the two implementations can disagree without
the contract noticing. (The other is the canonical request hash, task 2.5.)

Written while building the Node side so the Java side can be ported from a
specification rather than reverse-engineered from TypeScript.

**Test vectors: [`tests/fixtures/cursor-vectors.json`](../tests/fixtures/cursor-vectors.json).**
Both implementations must reproduce every string in that file exactly. It is the
real contract; this document explains it.

## Format

```
cursor = base64url_unpadded( utf8( '{"v":' + json(sortValue) + ',"i":' + json(id) + '}' ) )
```

Nothing else. Two keys, `v` then `i`, both strings, no whitespace anywhere.

`v` is the value of the sort column for the last row on the page. `i` is that
row's id, which is the tiebreaker. A worked example:

| | |
| --- | --- |
| sortValue | `129000` |
| id | `01930002-0000-7000-8000-00000000000b` |
| canonical JSON | `{"v":"129000","i":"01930002-0000-7000-8000-00000000000b"}` |
| cursor | `eyJ2IjoiMTI5MDAwIiwiaSI6IjAxOTMwMDAyLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwYiJ9` |

## The three rules that make it reproducible

### 1. `v` before `i`, always

Two keys in a fixed order. There is nothing for a serialiser to sort differently,
and no map iteration order to depend on.

### 2. `v` is always a string

Even when the column is a `BIGINT` or a `timestamptz`. A price cursor carrying
`129000` as a JSON *number* would invite each language to render it its own way —
`129000`, `129000.0`, `1.29E+5` — and a timestamp as a number loses the rendering
its text form pinned down. Convert to string first, in a documented way:

| Sort | Column | `sortValue` is |
| --- | --- | --- |
| `newest` | `created_at` | RFC 3339 UTC, millisecond precision, `Z` suffix |
| `price_asc` / `price_desc` | `min_price_cents` | The integer in base 10, no separators, no sign for positives |
| `name_asc` | `name` | The string exactly as stored |

### 3. The JSON is written by hand, not by a JSON library

This is the non-obvious one, and the reason the vectors exist.

Serialisers disagree about non-ASCII. Some emit raw UTF-8; some escape everything
above U+007F as `\uXXXX`. Jackson can be configured either way, and its default
has changed across versions. `name_asc` cursors carry Thai product names, so that
difference changes the bytes, changes the base64, and breaks paging across
backends — while both sides look correct in isolation.

So writing is hand-rolled and specified. **Parsing is not**: JSON parsing is
unambiguous, so decode with the standard library.

#### Escaping, exactly

Escape only what RFC 8259 requires:

| Input | Output |
| --- | --- |
| `"` | `\"` |
| `\` | `\\` |
| U+0008 | `\b` |
| U+000C | `\f` |
| U+000A | `\n` |
| U+000D | `\r` |
| U+0009 | `\t` |
| other U+0000–U+001F | `\u00xx`, **lowercase** hex |
| everything else | emitted as-is, raw UTF-8 |

Note what is *not* escaped: `/`, and every character above U+007F.

Iterate by **code point**, not by UTF-16 code unit, so a character outside the
BMP is not split into surrogates. In Java that means `codePoints()`, not
`charAt()`. The `emoji` vector exists to catch this.

### 4. base64url, unpadded

RFC 4648 §5: `-` and `_` instead of `+` and `/`, and no `=` padding.

- Node: `Buffer.from(json, 'utf8').toString('base64url')` — unpadded already.
- Java: `Base64.getUrlEncoder().withoutPadding().encodeToString(json.getBytes(UTF_8))`.
  Forgetting `withoutPadding()` produces a cursor that differs only on some
  inputs — whenever the byte length is not a multiple of three — which is the
  worst kind of bug to find later.

## Using it in a query

```sql
WHERE (sort_col, id) < (:v, :i)
ORDER BY sort_col DESC, id DESC
LIMIT :limit + 1
```

Three things matter here:

- **`id` is always in both the predicate and the `ORDER BY`.** Without it, rows
  whose sort values tie either appear on two pages or on none. Every index in
  `V1__init.sql` ends in `id` for this reason.
- **Fetch `limit + 1` rows.** If the extra row comes back there is another page.
  That is how `hasMore` is known without a second `COUNT(*)` over the same
  predicate.
- **Drop the extra row before responding, and take the next cursor from the last
  row you keep.** Taking it from the dropped row skips that row entirely.

Flip the comparison and the `ORDER BY` direction together for ascending sorts:
`WHERE (sort_col, id) > (:v, :i) ORDER BY sort_col ASC, id ASC`.

The row-value comparison `(a, b) < (x, y)` is standard SQL and does the right
thing — it is *not* `a < x AND b < y`. Hibernate cannot express it in HQL, so the
Java side needs a native query. Do not substitute the naive conjunction; it drops
rows.

## Ordering ids

`id` is compared as its canonical lowercase hyphenated string. In that form
lexicographic string order, byte order, and PostgreSQL's `uuid` order all agree,
so `ORDER BY id` in SQL matches `sort()` in TypeScript and `compareTo` on
`String` in Java. See [ADR-008](adr/008-uuidv7-generated-by-the-application.md);
the same rule governs lock ordering at checkout.

## Errors

Every malformed cursor is one response: **422** with
`type: https://errors.example.com/invalid-cursor`. Truncated, from another
deployment, hand-crafted, or never a cursor at all — a cursor is opaque, so there
is nothing more specific a client could act on. Never 400, and never a 500.

## Implementations

- Node: [`apps/api-node/src/common/pagination/cursor.ts`](../apps/api-node/src/common/pagination/cursor.ts)
- Node tests: [`cursor.spec.ts`](../apps/api-node/src/common/pagination/cursor.spec.ts)
- Java: task 5.3, which must run the same vector file.

## Changing this

Any change invalidates every cursor a client is currently holding, including ones
in an open browser tab. There is no version field, deliberately — a format this
small should be got right rather than negotiated. If it ever must change, add a
version prefix outside the base64 so old cursors can be rejected with a clear
error instead of being misread.
