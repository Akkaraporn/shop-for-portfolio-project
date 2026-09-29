import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NetworkError, ProblemError } from './client';
import { describeError, KNOWN_SLUGS, OFFLINE_MESSAGE, UNKNOWN_MESSAGE } from './problem-messages';

const problem = (slug: string, status: number, title = 'English title') =>
  new ProblemError({
    type: `https://errors.example.com/${slug}`,
    title,
    status,
    traceId: 'trace-123',
  });

describe('describeError', () => {
  it('maps a known type to Thai and keeps the traceId', () => {
    expect(describeError(problem('insufficient-stock', 409))).toEqual({
      message: 'สินค้าบางรายการไม่พอ กรุณาปรับจำนวน',
      traceId: 'trace-123',
    });
  });

  it('switches on the type, not the status: two 409s read differently', () => {
    const a = describeError(problem('checkout-in-progress', 409)).message;
    const b = describeError(problem('invalid-transition', 409)).message;
    expect(a).not.toEqual(b);
  });

  it('falls back to the English title for a type it does not know', () => {
    expect(describeError(problem('brand-new-problem', 409, 'Brand new problem')).message).toBe(
      'Brand new problem',
    );
  });

  it('says offline for a network failure, and something generic for anything else', () => {
    expect(describeError(new NetworkError(new TypeError('fetch failed'))).message).toBe(
      OFFLINE_MESSAGE,
    );
    expect(describeError(new Error('boom')).message).toBe(UNKNOWN_MESSAGE);
  });

  it('has a message for every type the contract publishes', () => {
    const doc = readFileSync(
      fileURLToPath(new URL('../../../../docs/problem-types.md', import.meta.url)),
      'utf8',
    );
    const published = [...doc.matchAll(/^\| `([a-z-]+)` \| \d{3} \|/gm)].map((m) => m[1]);
    expect(published.length).toBeGreaterThan(10);
    expect(published.filter((slug) => !KNOWN_SLUGS.includes(slug))).toEqual([]);
  });
});
