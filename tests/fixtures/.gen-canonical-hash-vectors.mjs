// Regenerates canonical-hash-vectors.json.
//
//   node tests/fixtures/.gen-canonical-hash-vectors.mjs > tests/fixtures/canonical-hash-vectors.json
//
// Mirrors canonicalJson in apps/api-node/src/common/canonical/canonical-json.ts
// deliberately: if the two ever disagree, the Node suite fails, which is the point of
// having both. Changing the algorithm invalidates every idempotency key currently
// stored, so do not regenerate casually.
import { createHash } from 'node:crypto';

function canonicalString(value) {
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
    const code = char.codePointAt(0);
    if (code < 0x20) {
      out += '\\u' + code.toString(16).padStart(4, '0');
      continue;
    }
    out += char;
  }
  return out + '"';
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('integers only');
    return value === 0 ? '0' : value.toString(10);
  }
  if (typeof value === 'string') return canonicalString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${canonicalString(k)}:${canonicalJson(value[k])}`)
    .join(',')}}`;
}

const hash = (value) =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

const cases = [
  {
    name: 'empty-object',
    value: {},
    note: 'The degenerate case. Both implementations must agree even here.',
  },
  {
    name: 'flat-sorted',
    value: { a: '1', b: '2', c: '3' },
    note: 'Already in order; the baseline the next vector is compared against.',
  },
  {
    name: 'flat-unsorted',
    value: { c: '3', a: '1', b: '2' },
    note: 'Same content, different key order. MUST hash identically to flat-sorted — this is the entire purpose of canonicalisation.',
  },
  {
    name: 'nested-unsorted',
    value: { z: { y: '1', x: '2' }, a: [{ q: '1', p: '2' }] },
    note: 'Sorting is recursive, and applies inside objects nested in arrays.',
  },
  {
    name: 'array-order-preserved',
    value: { items: ['b', 'a', 'c'] },
    note: 'Arrays are sequences. Reordering them is a genuinely different request and must NOT hash the same.',
  },
  {
    name: 'integers',
    value: { zero: 0, negative: -42, large: 9007199254740991 },
    note: 'Base 10, no plus sign, no decimal point. -0 would normalise to 0.',
  },
  {
    name: 'booleans-and-null',
    value: { t: true, f: false, n: null },
    note: 'null is preserved, not dropped.',
  },
  {
    name: 'thai-address',
    value: {
      shippingAddress: {
        recipientName: 'สมชาย ใจดี',
        line1: '123 ถนนสุขุมวิท',
        city: 'กรุงเทพมหานคร',
        province: 'กรุงเทพมหานคร',
        postalCode: '10110',
        country: 'TH',
        phone: '0812345678',
      },
      paymentMethod: 'card',
    },
    note: 'The realistic case, and the one that breaks a serialiser configured to escape non-ASCII. Must be raw UTF-8.',
  },
  {
    name: 'escapes',
    value: { quote: 'a "b"', backslash: 'a\\b', newline: 'a\nb', tab: 'a\tb' },
    note: 'Only the RFC 8259 escapes, and the short forms where they exist.',
  },
  {
    name: 'control-character',
    value: { bell: '' },
    note: 'A C0 control with no short form: \\u0007, lowercase hex.',
  },
  {
    name: 'emoji-key-and-value',
    value: { '🧵': 'thread 🧵' },
    note: 'Outside the BMP, in a key as well as a value. Per-code-unit iteration would split the surrogate pair.',
  },
  {
    name: 'realistic-checkout',
    value: {
      paymentMethod: 'promptpay',
      note: 'ฝากไว้หน้าบ้านได้เลยครับ',
      shippingAddress: {
        recipientName: 'พิมพ์ชนก วงศ์สุวรรณ',
        phone: '0898765432',
        line1: '99/1 หมู่บ้านสวนหลวง',
        line2: 'ซอย 5',
        city: 'เมือง',
        province: 'เชียงใหม่',
        postalCode: '50000',
        country: 'TH',
      },
    },
    note: 'A whole CheckoutRequest as a client would actually send it.',
  },
];

const document = {
  $comment:
    'Shared canonical-hash vectors. Both implementations must reproduce every ' +
    'canonical string and every hash below exactly. Read by the Node suite ' +
    '(apps/api-node/src/common/canonical/canonical-json.spec.ts) and by the Java ' +
    'port (task 5.3). Algorithm specified in docs/idempotency.md. Regenerate with ' +
    'tests/fixtures/.gen-canonical-hash-vectors.mjs.',
  algorithm:
    'sha256(canonicalJson(body)) as lowercase hex; keys sorted recursively, no whitespace, integers only',
  vectors: cases.map((c) => ({
    ...c,
    canonical: canonicalJson(c.value),
    sha256: hash(c.value),
  })),
};

process.stdout.write(JSON.stringify(document, null, 2) + '\n');
