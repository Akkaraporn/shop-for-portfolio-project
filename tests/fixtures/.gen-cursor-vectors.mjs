// Regenerates cursor-vectors.json from the canonical encoding.
//
//   node tests/fixtures/.gen-cursor-vectors.mjs > tests/fixtures/cursor-vectors.json
//
// Kept beside the fixture so the vectors are reproducible rather than magic
// strings. This mirrors encodeCursor in apps/api-node/src/common/pagination/
// cursor.ts deliberately: if the two ever disagree, the Node test suite fails,
// which is the point of having both.
//
// Changing the format here is a breaking change for every cursor already held by
// a client. Do not regenerate casually.

function jsonString(value) {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0);
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
    if (code < 0x20) {
      out += '\\u' + code.toString(16).padStart(4, '0');
      continue;
    }
    out += char;
  }
  return out + '"';
}

const encode = (sortValue, id) =>
  Buffer.from(
    `{"v":${jsonString(sortValue)},"i":${jsonString(id)}}`,
    'utf8',
  ).toString('base64url');

const cases = [
  {
    name: 'newest',
    sortValue: '2026-03-14T08:21:05.123Z',
    id: '01930002-0000-7000-8000-000000000001',
    note: 'An RFC 3339 millisecond timestamp, as the newest sort produces.',
  },
  {
    name: 'price',
    sortValue: '129000',
    id: '01930002-0000-7000-8000-00000000000b',
    note: 'min_price_cents as a string, never a JSON number.',
  },
  {
    name: 'price-zero',
    sortValue: '0',
    id: '01930002-0000-7000-8000-00000000000c',
    note: 'Zero must not become an empty string or be omitted.',
  },
  {
    name: 'name-thai',
    sortValue: 'เสื้อยืดคอกลม ผ้าฝ้ายออร์แกนิก',
    id: '01930002-0000-7000-8000-000000000001',
    note: 'The case that breaks a JSON library configured to escape non-ASCII. Must be raw UTF-8.',
  },
  {
    name: 'name-thai-tone-marks',
    sortValue: 'กางเกงขาสั้นผ้าฝ้าย',
    id: '01930002-0000-7000-8000-000000000007',
    note: 'Combining vowels and tone marks: multi-byte sequences that must survive byte-identically.',
  },
  {
    name: 'name-latin',
    sortValue: 'Oxford Button-Down Shirt',
    id: '01930002-0000-7000-8000-000000000004',
    note: 'Plain ASCII, the easy case, included so a failure here localises the bug quickly.',
  },
  {
    name: 'quote-in-value',
    sortValue: 'a "quoted" name',
    id: '01930002-0000-7000-8000-000000000002',
    note: 'The quote is escaped, and nothing else about the string changes.',
  },
  {
    name: 'backslash-in-value',
    sortValue: 'back\\slash',
    id: '01930002-0000-7000-8000-000000000003',
    note: 'The backslash is doubled.',
  },
  {
    name: 'empty-value',
    sortValue: '',
    id: '01930002-0000-7000-8000-000000000005',
    note: 'An empty sort value is still a valid cursor.',
  },
  {
    name: 'emoji',
    sortValue: 'thread 🧵',
    id: '01930002-0000-7000-8000-000000000006',
    note: 'Outside the BMP: a surrogate pair, where per-code-unit iteration would split the character.',
  },
];

const document = {
  $comment:
    'Shared cursor codec vectors. Both implementations must reproduce every ' +
    'cursor string below exactly. Read by the Node suite ' +
    '(apps/api-node/src/common/pagination/cursor.spec.ts) and by the Java port ' +
    '(task 5.3). Format specified in docs/cursor-format.md. Regenerate with ' +
    'tests/fixtures/.gen-cursor-vectors.mjs.',
  format:
    'base64url, unpadded, of {"v":<sortValue>,"i":<id>} with no whitespace',
  vectors: cases.map((c) => ({ ...c, cursor: encode(c.sortValue, c.id) })),
};

process.stdout.write(JSON.stringify(document, null, 2) + '\n');
