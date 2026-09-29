import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProblemException } from '../problem/problem.exception';
import { buildPage, decodeCursor, encodeCursor } from './cursor';

/**
 * The vectors are shared with the Java port (task 5.3), which runs the same file.
 * They are the actual contract for this codec: if both implementations reproduce
 * these exact strings, a cursor issued by either pages correctly against the
 * other, which is what the cross-backend test in 4.3 relies on.
 */
interface Vector {
  name: string;
  sortValue: string;
  id: string;
  cursor: string;
  note?: string;
}

// src/common/pagination -> apps/api-node -> apps -> repo root
const VECTORS_PATH = join(
  __dirname,
  '../../../../../tests/fixtures/cursor-vectors.json',
);

const vectors: Vector[] = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')).vectors;

describe('cursor codec', () => {
  describe('shared vectors', () => {
    it.each(vectors)('encodes $name to the agreed bytes', (vector) => {
      expect(encodeCursor({ sortValue: vector.sortValue, id: vector.id })).toBe(
        vector.cursor,
      );
    });

    it.each(vectors)('decodes $name back to its payload', (vector) => {
      expect(decodeCursor(vector.cursor)).toEqual({
        sortValue: vector.sortValue,
        id: vector.id,
      });
    });
  });

  describe('format guarantees', () => {
    const payload = { sortValue: '129000', id: '01930002-0000-7000-8000-00000000000f' };

    it('produces unpadded base64url', () => {
      const cursor = encodeCursor(payload);
      expect(cursor).not.toContain('=');
      expect(cursor).not.toContain('+');
      expect(cursor).not.toContain('/');
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('orders the keys v then i', () => {
      const json = Buffer.from(encodeCursor(payload), 'base64url').toString('utf8');
      expect(json).toBe(
        '{"v":"129000","i":"01930002-0000-7000-8000-00000000000f"}',
      );
    });

    it('emits no whitespace', () => {
      const json = Buffer.from(encodeCursor(payload), 'base64url').toString('utf8');
      expect(json).not.toMatch(/\s/);
    });

    it('emits non-ASCII as raw UTF-8 rather than \\u escapes', () => {
      const json = Buffer.from(
        encodeCursor({ sortValue: 'เสื้อยืด', id: 'x' }),
        'base64url',
      ).toString('utf8');
      expect(json).toContain('เสื้อยืด');
      expect(json).not.toContain('\\u0e2a');
    });

    it('round-trips every value type a sort column can produce', () => {
      const cases = [
        '2026-03-14T08:21:05.123Z',
        '129000',
        '0',
        'เสื้อยืดคอกลม ผ้าฝ้ายออร์แกนิก',
        'a"quoted"name',
        'back\\slash',
        'emoji 🧵 and ZWJ 👨‍👩‍👧',
        '',
      ];

      for (const sortValue of cases) {
        const id = '01930002-0000-7000-8000-000000000001';
        expect(decodeCursor(encodeCursor({ sortValue, id }))).toEqual({
          sortValue,
          id,
        });
      }
    });
  });

  describe('rejection', () => {
    it.each([
      ['not base64 at all', '!!!not-a-cursor!!!'],
      ['valid base64 that is not JSON', Buffer.from('hello').toString('base64url')],
      ['JSON that is not an object', Buffer.from('"hello"').toString('base64url')],
      ['object missing i', Buffer.from('{"v":"1"}').toString('base64url')],
      ['object missing v', Buffer.from('{"i":"1"}').toString('base64url')],
      ['v of the wrong type', Buffer.from('{"v":1,"i":"a"}').toString('base64url')],
      ['i of the wrong type', Buffer.from('{"v":"1","i":null}').toString('base64url')],
      ['null', Buffer.from('null').toString('base64url')],
      ['empty string', ''],
    ])('rejects %s as a 422 problem', (_name, cursor) => {
      let thrown: unknown;
      try {
        decodeCursor(cursor);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ProblemException);
      const problem = thrown as ProblemException;
      expect(problem.slug).toBe('invalid-cursor');
      expect(problem.getStatus()).toBe(422);
    });
  });

  describe('buildPage', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) => ({
      id: `id-${n}`,
      sort: `${n}`,
    }));
    const cursorFor = (row: { id: string; sort: string }) => ({
      sortValue: row.sort,
      id: row.id,
    });

    it('drops the probe row and reports hasMore when it came back', () => {
      const page = buildPage(rows, 5, cursorFor);
      expect(page.items).toHaveLength(5);
      expect(page.hasMore).toBe(true);
      expect(page.items.at(-1)!.id).toBe('id-5');
    });

    it('takes the cursor from the last kept row, not the dropped one', () => {
      const page = buildPage(rows, 5, cursorFor);
      // id-6 was fetched only to learn hasMore. A cursor pointing at it would
      // skip id-6 entirely on the next page.
      expect(decodeCursor(page.nextCursor!)).toEqual({
        sortValue: '5',
        id: 'id-5',
      });
    });

    it('omits nextCursor on the last page', () => {
      const page = buildPage(rows.slice(0, 3), 5, cursorFor);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeUndefined();
      expect('nextCursor' in page).toBe(false);
    });

    it('handles an exactly-full page with nothing beyond it', () => {
      const page = buildPage(rows.slice(0, 5), 5, cursorFor);
      expect(page.items).toHaveLength(5);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeUndefined();
    });

    it('handles an empty result', () => {
      const page = buildPage([], 5, cursorFor);
      expect(page.items).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeUndefined();
    });
  });
});
