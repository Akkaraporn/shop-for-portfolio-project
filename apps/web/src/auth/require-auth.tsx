import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { useSession } from './session';

/**
 * Sends a signed-out shopper to login, remembering where they were going.
 *
 * Waits while the session is still `unknown` — otherwise a signed-in user reloading
 * the checkout page is bounced to login for the half-second bootstrap takes, and then
 * lands somewhere other than where they were.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const location = useLocation();

  if (status === 'unknown') {
    return <p className="p-12 text-center text-muted-foreground">กำลังตรวจสอบการเข้าสู่ระบบ…</p>;
  }

  if (status === 'signed-out') {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return <>{children}</>;
}
