import { canonicalString } from '../canonical/canonical-json';
import { Problems } from '../problem/problem.exception';

/**
 * The cursor codec.
 *
 * OpenAPI cannot describe this, which makes it one of the two places where the
 * two implementations can silently disagree (the other is the canonical request
 * hash used for idempotency). A cursor issued by the Node backend must page
 * correctly against the Java one, so the encoding is specified byte for byte in
 * `docs/cursor-format.md` and pinned by the shared vectors in
 * `tests/fixtures/cursor-vectors.json`.
 *
 * The wire format is `base64url(canonicalJson)`, unpadded, where canonicalJson is
 * exactly:
 *
 *     {"v":<string>,"i":<string>}
 *
 * Three decisions make that reproducible in another language:
 *
 * 1. **`v` before `i`, always.** Two keys in a fixed order, so there is nothing
 *    for a serialiser to sort differently.
 *
 * 2. **`v` is always a string**, even when the underlying column is a number or a
 *    timestamp. A price cursor carrying `129000` as a JSON number would invite
 *    every language to render it its own way — `1.29E+5`, `129000.0` — and a
 *    timestamp as a number would lose the timezone it was rendered in.
 *
 * 3. **The JSON is written by hand, not by a JSON library.** This is the
 *    non-obvious one. Serialisers disagree about non-ASCII: some emit raw UTF-8,
 *    some escape everything above U+007F as `\uXXXX`, and Jackson can be
 *    configured either way. `name_asc` cursors carry Thai product names, so that
 *    difference would change the bytes, change the base64, and break paging
 *    across backends. Parsing is unambiguous, so decoding uses the standard
 *    library; only writing is hand-rolled.
 */
export interface CursorPayload {
  /** The value of the sort column for the last row on the page, as a string. */
  sortValue: string;
  /** The tiebreaker: that row's id. Without it, equal sort values duplicate or vanish. */
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  // canonicalString is shared with the idempotency hash, so the codebase has exactly
  // one JSON string escaper and the Java side has exactly one to match.
  const json = `{"v":${canonicalString(payload.sortValue)},"i":${canonicalString(payload.id)}}`;
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, or throws a 422 `invalid-cursor` problem.
 *
 * Every failure mode is one response: a truncated cursor, a cursor from another
 * deployment, a hand-crafted one, or a value that was never a cursor. Cursors are
 * opaque, so there is nothing more specific a client could usefully be told.
 */
export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;

  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw Problems.invalidCursor();
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { v?: unknown }).v !== 'string' ||
    typeof (parsed as { i?: unknown }).i !== 'string'
  ) {
    throw Problems.invalidCursor();
  }

  const { v, i } = parsed as { v: string; i: string };
  return { sortValue: v, id: i };
}

/** What a list endpoint returns, matching the contract's `Page` envelope. */
export interface Page<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * Builds a `Page` from a query that fetched one row more than the client asked
 * for.
 *
 * Asking for `limit + 1` is how `hasMore` is known without a second `COUNT(*)`
 * over the same predicate: if the extra row came back there is another page. The
 * extra row is dropped before the page is returned, and the cursor is taken from
 * the last row that survives — never from the dropped one, which would skip it.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  cursorFor: (row: T) => CursorPayload,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    hasMore,
    ...(hasMore && last ? { nextCursor: encodeCursor(cursorFor(last)) } : {}),
  };
}
