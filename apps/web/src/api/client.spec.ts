import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkError, ProblemError, apiFetch, configureClient } from './client';
import { shouldRetry } from './query-client';

/** Awaits a request expected to fail and returns what it threw, typed for assertions. */
async function caught(promise: Promise<unknown>): Promise<ProblemError> {
  try {
    await promise;
  } catch (error) {
    return error as ProblemError;
  }
  throw new Error('expected the request to fail');
}

const respond = (status: number, body: unknown, contentType = 'application/json') =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });

describe('apiFetch', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { origin: 'http://shop.test' } });
    configureClient({});
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('prefixes /api/v1 and drops undefined query values', async () => {
    fetchMock.mockResolvedValue(respond(200, { items: [], hasMore: false }));

    await apiFetch('/products', { query: { sort: 'price_asc', q: undefined, limit: 5 } });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v1/products');
    expect(url.searchParams.get('sort')).toBe('price_asc');
    expect(url.searchParams.get('limit')).toBe('5');
    // An optional filter passed through as undefined must not become "?q=undefined".
    expect(url.searchParams.has('q')).toBe(false);
  });

  it('turns a problem+json response into a typed ProblemError', async () => {
    fetchMock.mockResolvedValue(
      respond(
        409,
        {
          type: 'https://errors.example.com/insufficient-stock',
          title: 'Insufficient stock',
          status: 409,
          traceId: 'trace-123',
          errors: [{ field: 'items[0]', message: 'Only 1 left' }],
        },
        'application/problem+json',
      ),
    );

    const error = await caught(apiFetch('/checkout', { method: 'POST', body: {} }));

    expect(error).toBeInstanceOf(ProblemError);
    expect(error.status).toBe(409);
    // Pages switch on the slug, never on status or message text.
    expect(error.slug).toBe('insufficient-stock');
    expect(error.traceId).toBe('trace-123');
    expect(error.problem.errors).toHaveLength(1);
  });

  it('synthesises a Problem when something in front of the gateway returns HTML', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>Bad Gateway</html>', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'text/html', 'x-request-id': 'edge-9' },
      }),
    );

    const error = await caught(apiFetch('/health'));

    // One error shape for callers, whatever produced the failure.
    expect(error).toBeInstanceOf(ProblemError);
    expect(error.status).toBe(502);
    expect(error.traceId).toBe('edge-9');
  });

  it('wraps a failed connection in NetworkError', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(apiFetch('/health')).rejects.toBeInstanceOf(NetworkError);
  });

  it('lets an abort through untouched, since the caller asked for it', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const error = await caught(apiFetch('/health'));
    expect(error).not.toBeInstanceOf(NetworkError);
    expect(error.name).toBe('AbortError');
  });

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiFetch('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('sends a JSON body with its content type', async () => {
    fetchMock.mockResolvedValue(respond(200, {}));
    await apiFetch('/carts/me/items', { method: 'POST', body: { quantity: 2 } });

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"quantity":2}');
  });

  it('applies the hooks task 3.2 will register', async () => {
    const seen: number[] = [];
    configureClient({
      headers: () => ({ Authorization: 'Bearer abc' }),
      onResponse: (r) => seen.push(r.status),
    });
    fetchMock.mockResolvedValue(respond(200, {}));

    await apiFetch('/auth/me');

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer abc');
    expect(seen).toEqual([200]);
  });
});

describe('shouldRetry', () => {
  const problem = (status: number) =>
    new ProblemError({ type: 'https://errors.example.com/x', title: 'x', status });

  it('never retries a 4xx — the same request fails the same way', () => {
    expect(shouldRetry(0, problem(422))).toBe(false);
    expect(shouldRetry(0, problem(409))).toBe(false);
  });

  it('never retries a 5xx from the API either — that needs a traceId, not repetition', () => {
    expect(shouldRetry(0, problem(500))).toBe(false);
  });

  it('retries a network failure, twice at most', () => {
    const offline = new NetworkError(new TypeError('Failed to fetch'));
    expect(shouldRetry(0, offline)).toBe(true);
    expect(shouldRetry(1, offline)).toBe(true);
    expect(shouldRetry(2, offline)).toBe(false);
  });
});
