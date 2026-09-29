import { createHash } from 'node:crypto';

/**
 * Canonical JSON, and the hash taken over it.
 *
 * This is the second of the two things OpenAPI cannot describe (the first is the
 * cursor codec). An idempotency key is only meaningful alongside a fingerprint of the
 * request it belongs to, and that fingerprint has to be computed identically by both
 * backends — otherwise a checkout retried against the other one is judged to be a
 * *different* request and rejected with 422, which is the worst possible answer to a
 * retry.
 *
 * Specified in `docs/idempotency.md` and pinned by the shared vectors in
 * `tests/fixtures/canonical-hash-vectors.json`.
 *
 * The rules:
 *
 * 1. **Object keys are sorted**, recursively, by their UTF-16 code units — which for
 *    the ASCII keys this API uses is plain alphabetical order. This is the whole point:
 *    a client that serialises its body with keys in a different order must still get
 *    the same hash.
 * 2. **Array order is preserved.** An array is a sequence, and reordering `items`
 *    genuinely is a different request.
 * 3. **No whitespace anywhere.**
 * 4. **Numbers must be integers** in the safe-integer range. See below.
 * 5. **Strings are escaped minimally**, non-ASCII emitted as raw UTF-8.
 * 6. `null` is preserved. An object key whose value is `undefined` is **omitted**,
 *    and `undefined` inside an array becomes `null` — exactly what `JSON.stringify`
 *    does, and necessary because the value hashed is a rebuilt object rather than the
 *    raw parsed body: `class-transformer` materialises a DTO's absent optional fields
 *    as own properties set to `undefined`, and a field the client never sent must not
 *    change the fingerprint.
 */

/**
 * Thrown when a value cannot be canonicalised. Surfaces as a 422 rather than a 500:
 * the request is well formed JSON but contains something this API refuses to
 * fingerprint.
 */
export class NonCanonicalValueError extends Error {
  constructor(readonly reason: string) {
    super(`Value cannot be canonicalised: ${reason}`);
    this.name = 'NonCanonicalValueError';
  }
}

/**
 * Serialises a parsed JSON value to its canonical form.
 *
 * Hand-rolled rather than `JSON.stringify` with a replacer, for the same reason the
 * cursor codec is: serialisers disagree about escaping non-ASCII, and Jackson can be
 * configured either way. A Thai `recipientName` in a shipping address would change the
 * bytes, change the hash, and make a cross-backend retry look like a different request.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      return canonicalNumber(value);

    case 'string':
      return canonicalString(value);

    case 'object':
      if (Array.isArray(value)) {
        // `undefined` in an array becomes null, as in JSON.stringify: an array's
        // length is part of its meaning, so a hole cannot simply be dropped.
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
      }
      return canonicalObject(value as Record<string, unknown>);

    case 'undefined':
      // Only reachable when a caller passes `undefined` at the top level, since
      // object keys and array holes are handled above. There is no JSON rendering of
      // it, and guessing one would let two different requests share a fingerprint.
      throw new NonCanonicalValueError(
        'undefined is not a JSON value; omit the field instead',
      );

    default:
      // function, symbol, bigint. None can come out of JSON.parse, so reaching here
      // means a caller passed something other than a parsed or rebuilt body.
      throw new NonCanonicalValueError(`unsupported type ${typeof value}`);
  }
}

/** SHA-256 of the canonical form, lowercase hex. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalObject(object: Record<string, unknown>): string {
  // Object.keys gives insertion order; sorting is what makes the output independent
  // of how the client happened to build its JSON.
  //
  // Keys holding `undefined` are dropped rather than rendered. This matters in
  // practice, not just in theory: an optional field the client omitted arrives here as
  // an own property set to `undefined` (class-transformer builds the whole DTO shape),
  // and including it would make the fingerprint depend on the DTO's declaration rather
  // than on what was actually sent.
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort();

  const members = keys.map(
    (key) => `${canonicalString(key)}:${canonicalJson(object[key])}`,
  );

  return `{${members.join(',')}}`;
}

/**
 * Integers only, in base 10.
 *
 * Floating point is refused rather than serialised, and this is a deliberate
 * restriction rather than laziness. There is no rendering of a non-integer double that
 * every language agrees on: JavaScript gives `1e-7` and `100000`, Java's
 * `Double.toString` gives `1.0E-7` and `100000.0`. Any of those differences changes the
 * hash. Defining the canonical form over integers only removes the entire class of
 * problem, and costs nothing here — money is already integer satang (ADR-002) and no
 * request body in this contract carries a fractional number.
 *
 * `-0` normalises to `0`: they are the same number, and `String(-0)` is `"0"` in
 * JavaScript but `"-0.0"` in Java.
 */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    // NaN and Infinity are not JSON in the first place.
    throw new NonCanonicalValueError(`non-finite number ${value}`);
  }

  if (!Number.isInteger(value)) {
    throw new NonCanonicalValueError(
      `non-integer number ${value}; this API canonicalises integers only`,
    );
  }

  if (!Number.isSafeInteger(value)) {
    throw new NonCanonicalValueError(
      `integer ${value} is outside the safe range and cannot be rendered identically in every language`,
    );
  }

  return value === 0 ? '0' : value.toString(10);
}

/**
 * Serialises one JSON string, minimally and deterministically.
 *
 * Escapes only what RFC 8259 requires: the quote, the backslash, and the C0 control
 * characters — the five with short forms as those, the rest as `\u00xx` with lowercase
 * hex. Everything else, including all non-ASCII, is emitted as raw UTF-8.
 *
 * Shared with the cursor codec, so there is exactly one escaping implementation in the
 * codebase and exactly one for the Java side to match.
 *
 * Iterates by code point, not UTF-16 code unit, so a character outside the BMP is not
 * split into surrogate halves.
 */
export function canonicalString(value: string): string {
  let out = '"';

  for (const char of value) {
    switch (char) {
      case '"':
        out += '\\"';
        continue;
      case '\\':
        out += '\\\\';
        continue;
      case '\b':
        out += '\\b';
        continue;
      case '\f':
        out += '\\f';
        continue;
      case '\n':
        out += '\\n';
        continue;
      case '\r':
        out += '\\r';
        continue;
      case '\t':
        out += '\\t';
        continue;
      default:
        break;
    }

    const code = char.codePointAt(0)!;

    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    out += char;
  }

  return `${out}"`;
}
