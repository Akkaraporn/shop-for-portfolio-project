import { useSyncExternalStore } from 'react';

import { apiFetch, configureClient, ProblemError, type Schemas } from '@/api/client';

/**
 * The client-side session. Get this wrong and users are signed out at random, with
 * nothing in any log to explain why.
 *
 * Storage:
 * - **Access token: memory only.** Anything in localStorage is readable by any script
 *   an XSS gets onto the page. Losing it on reload costs one refresh call.
 * - **Refresh token: localStorage.** A deliberate demo-grade trade-off. In production
 *   it belongs in an `httpOnly; Secure; SameSite=Strict` cookie that script cannot read
 *   at all — this project keeps it in localStorage so both backends can stay pure
 *   JSON APIs, and says so in the README rather than doing the wrong thing quietly.
 * - **Guest cart token: localStorage.** Not a credential for anything but a basket.
 *
 * The part that matters most is `refresh`, below.
 */

type User = Schemas['User'];
type TokenPair = Schemas['TokenPair'];
type AuthSession = Schemas['AuthSession'];

const REFRESH_KEY = 'vc.refreshToken';
const CART_KEY = 'vc.cartToken';

interface SessionState {
  /** 'unknown' until bootstrap has decided, so guards do not bounce a signed-in user. */
  status: 'unknown' | 'signed-in' | 'signed-out';
  user: User | null;
}

let state: SessionState = { status: 'unknown', user: null };
let accessToken: string | null = null;
const listeners = new Set<() => void>();

function setState(next: SessionState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function useSession(): SessionState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

// --- storage, all of it guarded: private windows and blocked site data throw ---

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // The session still works for this tab; it just will not survive a reload.
  }
}

export const cartToken = {
  get: () => read(CART_KEY),
  clear: () => write(CART_KEY, null),
};

// --- refresh ------------------------------------------------------------------

let inFlight: Promise<boolean> | null = null;

/**
 * Gets a fresh access token, and never runs two rotations at once.
 *
 * The backend rotates refresh tokens and treats a consumed one presented again as
 * theft — revoking the whole family. Measured in task 2.2: ten simultaneous
 * refreshes of one token left **zero** live tokens, the winner's included. So a
 * client that refreshes twice concurrently does not lose a request, it loses the
 * session. Two layers stop that:
 *
 * 1. **Within a tab**, one shared promise. A page firing five requests that all 401
 *    at once awaits a single refresh.
 * 2. **Across tabs**, a Web Lock. Two tabs share one refresh token in localStorage, and
 *    a per-tab promise cannot see the other tab. Holding the lock, the token is
 *    re-read *inside* it: if the other tab has already rotated, this tab picks up the
 *    new token instead of replaying the consumed one.
 *
 * Resolves false — and signs out — only when the server has actually refused.
 */
export function refresh(): Promise<boolean> {
  inFlight ??= withCrossTabLock(rotate).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function withCrossTabLock<T>(work: () => Promise<T>): Promise<T> {
  // Web Locks are in every current browser; the fallback only matters to very old
  // ones, which then get per-tab protection rather than none.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('vc.refresh', work);
  }
  return work();
}

async function rotate(): Promise<boolean> {
  const token = read(REFRESH_KEY); // read inside the lock — see above

  if (!token) {
    signedOut();
    return false;
  }

  try {
    const pair = await apiFetch<TokenPair>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: token },
    });
    accept(pair);
    return true;
  } catch (error) {
    if (error instanceof ProblemError) {
      // Refused: expired, revoked, or reuse detected. The session is over.
      signedOut();
      return false;
    }
    // Offline. The refresh token may still be good; keep it and let the caller fail.
    return false;
  }
}

function accept(pair: TokenPair): void {
  accessToken = pair.accessToken;
  write(REFRESH_KEY, pair.refreshToken);
}

function signedOut(): void {
  accessToken = null;
  write(REFRESH_KEY, null);
  setState({ status: 'signed-out', user: null });
}

// --- the operations pages call --------------------------------------------------

/**
 * Called after a successful login or register. Moves the guest basket across before
 * anything else reads the cart.
 *
 * A merge that fails does not fail the sign-in: a lost basket is a disappointment, a
 * sign-in that errors because of it is a lost customer. Register already claims the
 * guest basket server-side when the account has none; merge is idempotent, so calling
 * it anyway is safe and covers login into an account that already has a basket.
 */
async function establish(session: AuthSession): Promise<void> {
  accept(session.tokens);

  const guest = cartToken.get();
  if (guest) {
    try {
      await apiFetch('/carts/me/merge', { method: 'POST', body: { cartToken: guest } });
    } catch (error) {
      console.warn('guest basket could not be merged', error);
    }
    cartToken.clear();
  }

  setState({ status: 'signed-in', user: session.user });
}

export async function login(email: string, password: string): Promise<void> {
  const session = await apiFetch<AuthSession>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  await establish(session);
}

export async function register(
  email: string,
  password: string,
  fullName: string,
): Promise<void> {
  const session = await apiFetch<AuthSession>('/auth/register', {
    method: 'POST',
    body: { email, password, fullName },
  });
  await establish(session);
}

export async function logout(): Promise<void> {
  const token = read(REFRESH_KEY);
  signedOut();
  // Always 204 server-side; failure here changes nothing for the user.
  await apiFetch('/auth/logout', {
    method: 'POST',
    body: token ? { refreshToken: token } : {},
  }).catch(() => undefined);
}

let bootstrapping: Promise<void> | null = null;

/**
 * Runs once per page load: restore the session from the refresh token, then ask the
 * server who we are.
 *
 * Memoised, not merely called from an effect, because React StrictMode mounts twice in
 * development — and two bootstraps would be two concurrent refreshes, which is the
 * exact scenario above that ends the session.
 */
export function bootstrap(): Promise<void> {
  bootstrapping ??= (async () => {
    if (!read(REFRESH_KEY) || !(await refresh())) {
      setState({ status: 'signed-out', user: null });
      return;
    }
    try {
      const user = await apiFetch<User>('/auth/me');
      setState({ status: 'signed-in', user });
    } catch {
      signedOut();
    }
  })();
  return bootstrapping;
}

// --- wiring into the API client --------------------------------------------------

configureClient({
  headers: () => {
    const headers: Record<string, string> = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    // Always sent when present. The backend ignores it when a valid access token wins,
    // and it is what keeps a guest's basket when theirs has expired.
    const guest = cartToken.get();
    if (guest) headers['X-Cart-Token'] = guest;
    return headers;
  },
  onResponse: (response) => {
    // The backend echoes the current guest token on every guest response, and silently
    // replaces an expired one. Storing whatever came back last is all it takes.
    const issued = response.headers.get('x-cart-token');
    if (issued && !accessToken) write(CART_KEY, issued);
  },
  onUnauthorized: async () => (read(REFRESH_KEY) ? refresh() : false),
});

// Another tab signed out: follow it, rather than carrying a session whose refresh
// token no longer exists.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === REFRESH_KEY && event.newValue === null && state.status === 'signed-in') {
      accessToken = null;
      setState({ status: 'signed-out', user: null });
    }
  });
}
