import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  NonCanonicalValueError,
  canonicalHash,
  canonicalJson,
} from './canonical-json';

/**
 * The vectors are shared with the Java port (task 5.3), which runs the same file.
 *
 * They are the actual contract for this algorithm: if both implementations reproduce
 * these canonical strings and these hashes, a checkout retried against the *other*
 * backend replays instead of being judged a different request — which is the
 * cross-backend demo the project exists to show.
 */
interface Vector {
  name: string;
  value: unknown;
  canonical: string;
  sha256: string;
  note?: string;
}

const vectors: Vector[] = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../../tests/fixtures/canonical-hash-vectors.json'),
    'utf8',
  ),
).vectors;

describe('canonical JSON', () => {
  describe('shared vectors', () => {
    it.each(vectors)('serialises $name to the agreed bytes', (vector) => {
      expect(canonicalJson(vector.value)).toBe(vector.canonical);
    });

    it.each(vectors)('hashes $name to the agreed digest', (vector) => {
      expect(canonicalHash(vector.value)).toBe(vector.sha256);
    });
  });

  describe('key order independence', () => {
    it('is the whole point: reordering keys must not change the hash', () => {
      const a = { alpha: '1', beta: '2', gamma: '3' };
      const b = { gamma: '3', alpha: '1', beta: '2' };

      expect(canonicalJson(a)).toBe(canonicalJson(b));
      expect(canonicalHash(a)).toBe(canonicalHash(b));
    });

    it('sorts recursively, including inside arrays', () => {
      const a = { outer: { z: '1', a: '2' }, list: [{ q: '1', b: '2' }] };
      const b = { list: [{ b: '2', q: '1' }], outer: { a: '2', z: '1' } };

      expect(canonicalHash(a)).toBe(canonicalHash(b));
    });

    it('does not reorder arrays, because a sequence is part of the request', () => {
      expect(canonicalHash({ items: ['a', 'b'] })).not.toBe(
        canonicalHash({ items: ['b', 'a'] }),
      );
    });
  });

  describe('what a different request looks like', () => {
    const base = {
      paymentMethod: 'card',
      shippingAddress: { city: 'กรุงเทพมหานคร', postalCode: '10110' },
    };

    it.each([
      ['a changed value', { ...base, paymentMethod: 'promptpay' }],
      [
        'a changed nested value',
        { ...base, shippingAddress: { ...base.shippingAddress, postalCode: '10120' } },
      ],
      ['an added field', { ...base, note: 'leave at the door' }],
      ['a removed field', { shippingAddress: base.shippingAddress }],
      ['a null where a value was', { ...base, paymentMethod: null }],
    ])('%s changes the hash', (_name, variant) => {
      expect(canonicalHash(variant)).not.toBe(canonicalHash(base));
    });
  });

  describe('strings', () => {
    it('emits non-ASCII as raw UTF-8, never as \\u escapes', () => {
      // The case that breaks a serialiser configured to escape non-ASCII, and the
      // reason this is hand-rolled rather than JSON.stringify.
      const canonical = canonicalJson({ name: 'สมชาย ใจดี' });
      expect(canonical).toBe('{"name":"สมชาย ใจดี"}');
      expect(canonical).not.toContain('\\u0e');
    });

    it('escapes only what RFC 8259 requires', () => {
      expect(canonicalJson('a"b')).toBe('"a\\"b"');
      expect(canonicalJson('a\\b')).toBe('"a\\\\b"');
      expect(canonicalJson('a\nb')).toBe('"a\\nb"');
      expect(canonicalJson('a\tb')).toBe('"a\\tb"');
      // Not escaped: the forward slash, which some serialisers escape by default.
      expect(canonicalJson('a/b')).toBe('"a/b"');
    });

    it('escapes a control character with no short form as lowercase \\u00xx', () => {
      expect(canonicalJson('')).toBe('"\\u0007"');
      expect(canonicalJson('')).toBe('"\\u001f"');
    });

    it('keeps a surrogate pair intact', () => {
      expect(canonicalJson('🧵')).toBe('"🧵"');
      expect([...canonicalJson('🧵')]).toHaveLength(3); // quote, emoji, quote
    });

    it('sorts keys by code unit, which for ASCII is alphabetical', () => {
      // Capitals sort before lowercase, as they do in Java's String.compareTo.
      expect(canonicalJson({ b: '1', A: '2', a: '3' })).toBe(
        '{"A":"2","a":"3","b":"1"}',
      );
    });
  });

  describe('numbers', () => {
    it('renders integers in base 10', () => {
      expect(canonicalJson(0)).toBe('0');
      expect(canonicalJson(42)).toBe('42');
      expect(canonicalJson(-42)).toBe('-42');
      expect(canonicalJson(129000)).toBe('129000');
    });

    it('normalises negative zero', () => {
      // String(-0) is "0" in JavaScript but "-0.0" in Java. They are the same number.
      expect(canonicalJson(-0)).toBe('0');
      expect(canonicalHash({ n: -0 })).toBe(canonicalHash({ n: 0 }));
    });

    it('refuses a non-integer rather than guessing a rendering', () => {
      // There is no rendering of a double that every language agrees on: JavaScript
      // gives 1e-7, Java gives 1.0E-7. Refusing removes the whole class of problem.
      expect(() => canonicalJson(1.5)).toThrow(NonCanonicalValueError);
      expect(() => canonicalJson(0.1)).toThrow(/integers only/);
    });

    it('refuses an integer beyond the safe range', () => {
      expect(() => canonicalJson(Number.MAX_SAFE_INTEGER + 2)).toThrow(
        NonCanonicalValueError,
      );
    });

    it('refuses non-finite numbers, which are not JSON anyway', () => {
      expect(() => canonicalJson(NaN)).toThrow(NonCanonicalValueError);
      expect(() => canonicalJson(Infinity)).toThrow(NonCanonicalValueError);
    });
  });

  describe('structure', () => {
    it('emits no whitespace anywhere', () => {
      const canonical = canonicalJson({
        a: [1, 2, { b: 'c' }],
        d: { e: null, f: true },
      });
      expect(canonical).toBe('{"a":[1,2,{"b":"c"}],"d":{"e":null,"f":true}}');
    });

    it('preserves null rather than dropping the key', () => {
      expect(canonicalJson({ a: null })).toBe('{"a":null}');
      expect(canonicalHash({ a: null })).not.toBe(canonicalHash({}));
    });

    it('handles empty containers', () => {
      expect(canonicalJson({})).toBe('{}');
      expect(canonicalJson([])).toBe('[]');
    });

    it('produces a lowercase hex digest of the expected length', () => {
      expect(canonicalHash({ a: '1' })).toMatch(/^[0-9a-f]{64}$/);
    });

    it('survives a JSON.parse round trip, which is how a body actually arrives', () => {
      const body = { z: 'ล', a: [3, 1, 2], n: { y: true, x: null } };
      expect(canonicalHash(JSON.parse(JSON.stringify(body)))).toBe(
        canonicalHash(body),
      );
    });
  });
});
