import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The refresh race, which task 2.2 measured on the server: ten concurrent refreshes of
 * one token left **zero** live tokens. A client that lets two refreshes overlap does
 * not lose a request — it loses the session. These tests pin the client half.
 */

const store = new Map<string, string>();
const fetchMock = vi.fn();

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });
}

/** A single-process stand-in for the Web Locks API: one holder at a time, FIFO. */
function fakeLocks() {
  let tail = Promise.resolve();
  return {
    request: <T>(_name: string, work: () => Promise<T>): Promise<T> => {
      const run = tail.then(work);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

async function freshSession() {
  vi.resetModules();
  return import('./session');
}

beforeEach(() => {
  store.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('window', { location: { origin: 'http://shop.test' }, addEventListener: () => {} });
  vi.stubGlobal('navigator', { locks: fakeLocks() });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('refresh', () => {
  it('runs one rotation for five concurrent callers', async () => {
    store.set('vc.refreshToken', 'R1');
    fetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return json(200, { accessToken: 'A2', refreshToken: 'R2', tokenType: 'Bearer', expiresIn: 900 });
    });

    const { refresh } = await freshSession();
    const results = await Promise.all(Array.from({ length: 5 }, () => refresh()));

    expect(results).toEqual([true, true, true, true, true]);
    // The whole point: one call. Five would present R1 five times, and the server
    // would revoke the family on the second.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.get('vc.refreshToken')).toBe('R2');
  });

  it('re-reads the token inside the lock, so a second tab never replays a consumed one', async () => {
    // Tab A has already rotated R1 -> R2 while this tab waited for the lock.
    store.set('vc.refreshToken', 'R2');
    fetchMock.mockResolvedValue(
      json(200, { accessToken: 'A3', refreshToken: 'R3', tokenType: 'Bearer', expiresIn: 900 }),
    );

    const { refresh } = await freshSession();
    await refresh();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.refreshToken).toBe('R2');
  });

  it('signs out when the server refuses, and clears the stored token', async () => {
    store.set('vc.refreshToken', 'R1');
    fetchMock.mockResolvedValue(
      json(401, { type: 'https://errors.example.com/token-reuse-detected', title: 'x', status: 401 }),
    );

    const { refresh } = await freshSession();

    expect(await refresh()).toBe(false);
    expect(store.has('vc.refreshToken')).toBe(false);
  });

  it('keeps the refresh token when the network is down, because it may still be good', async () => {
    store.set('vc.refreshToken', 'R1');
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const { refresh } = await freshSession();

    expect(await refresh()).toBe(false);
    expect(store.get('vc.refreshToken')).toBe('R1');
  });
});

describe('the 401 interceptor', () => {
  it('refreshes once and retries the original request with the new token', async () => {
    store.set('vc.refreshToken', 'R1');
    fetchMock
      .mockResolvedValueOnce(json(401, { type: 'https://errors.example.com/unauthorized', title: 'x', status: 401 }))
      .mockResolvedValueOnce(json(200, { accessToken: 'A2', refreshToken: 'R2', tokenType: 'Bearer', expiresIn: 900 }))
      .mockResolvedValueOnce(json(200, { items: [] }));

    await freshSession();
    const { apiFetch } = await import('@/api/client');
    const result = await apiFetch<{ items: unknown[] }>('/orders');

    expect(result).toEqual({ items: [] });
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer A2');
  });

  it('does not refresh on a 401 from an auth endpoint', async () => {
    store.set('vc.refreshToken', 'R1');
    fetchMock.mockResolvedValue(
      json(401, { type: 'https://errors.example.com/invalid-credentials', title: 'x', status: 401 }),
    );

    await freshSession();
    const { apiFetch } = await import('@/api/client');
    await apiFetch('/auth/login', { method: 'POST', body: {} }).catch(() => undefined);

    // A wrong password is the answer, not a reason to refresh.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('guest cart token', () => {
  it('stores the token the server issues for a guest', async () => {
    fetchMock.mockResolvedValue(json(200, { items: [] }, { 'x-cart-token': 'G1' }));

    await freshSession();
    const { apiFetch } = await import('@/api/client');
    await apiFetch('/carts/me');

    expect(store.get('vc.cartToken')).toBe('G1');
  });

  it('merges the guest basket on login and then forgets the token', async () => {
    store.set('vc.cartToken', 'G1');
    fetchMock
      .mockResolvedValueOnce(
        json(200, {
          user: { id: 'u', email: 'a@b.c', fullName: 'x', role: 'customer', createdAt: '2026-01-01T00:00:00.000Z' },
          tokens: { accessToken: 'A1', refreshToken: 'R1', tokenType: 'Bearer', expiresIn: 900 },
        }),
      )
      .mockResolvedValueOnce(json(200, { items: [] }));

    const { login } = await freshSession();
    await login('a@b.c', 'pw');

    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('/api/v1/carts/me/merge');
    expect(JSON.parse(init.body)).toEqual({ cartToken: 'G1' });
    expect(init.headers.Authorization).toBe('Bearer A1');
    expect(store.has('vc.cartToken')).toBe(false);
  });

  it('does not fail the sign-in when the merge fails', async () => {
    store.set('vc.cartToken', 'G1');
    fetchMock
      .mockResolvedValueOnce(
        json(200, {
          user: { id: 'u', email: 'a@b.c', fullName: 'x', role: 'customer', createdAt: '2026-01-01T00:00:00.000Z' },
          tokens: { accessToken: 'A1', refreshToken: 'R1', tokenType: 'Bearer', expiresIn: 900 },
        }),
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { login } = await freshSession();
    await expect(login('a@b.c', 'pw')).resolves.toBeUndefined();
  });
});
