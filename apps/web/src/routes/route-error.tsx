import { isRouteErrorResponse, useRouteError } from 'react-router';

import { ErrorState } from '@/components/state/error-state';

/**
 * What a page shows when it throws while rendering.
 *
 * Mounted as the `errorElement` of a pathless route *inside* the layout, so a crash in
 * one page leaves the header, search and basket working — the shopper can navigate
 * away instead of facing a blank screen. Nothing technical is shown: a stack trace
 * means nothing to a shopper, and the console already has it.
 */
export function RouteError() {
  const error = useRouteError();

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <ErrorState
        title="หน้านี้แสดงผลไม่สำเร็จ"
        // A router 404/400 response is not an API problem; anything else may be one,
        // and then its traceId is worth quoting.
        error={isRouteErrorResponse(error) ? undefined : error}
        onRetry={() => window.location.reload()}
      />
    </main>
  );
}

/**
 * The last resort, for a crash in the layout itself. It cannot rely on the header or
 * the design-system chrome still working, so it is deliberately bare.
 */
export function RootError() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <ErrorState
        title="ร้านค้าแสดงผลไม่สำเร็จ"
        description="ลองโหลดหน้าใหม่อีกครั้ง หากยังไม่ได้ กรุณากลับไปที่หน้าแรก"
        onRetry={() => window.location.assign('/')}
      />
    </main>
  );
}
