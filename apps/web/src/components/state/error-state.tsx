import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';

import { describeError } from '@/api/problem-messages';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ErrorStateProps {
  title?: string;
  /** What went wrong, in words a shopper can act on. Never a status code alone. */
  description?: string;
  onRetry?: () => void;
  /** The traceId from the Problem response, so a report can be tied to a log line. */
  traceId?: string;
  /**
   * The thrown error. When given, the description and traceId come from it — the Thai
   * message for its problem `type` — unless passed explicitly.
   */
  error?: unknown;
  className?: string;
}

/**
 * The screen a shopper sees when a request failed.
 *
 * Two things it always does: say what to try next, and surface the `traceId` when
 * there is one. Every error this API returns carries a traceId that matches its log
 * lines, and showing it turns "it broke" into something that can actually be looked
 * up — but quietly, because it means nothing to most readers.
 */
export function ErrorState({
  title = 'มีบางอย่างผิดพลาด',
  description,
  onRetry,
  traceId,
  error,
  className,
}: ErrorStateProps) {
  const described = error === undefined ? undefined : describeError(error);
  description ??=
    described?.message ??
    'โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง หากยังไม่ได้ กรุณารอสักครู่แล้วลองอีกที';
  traceId ??= described?.traceId;

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-4 rounded-lg border border-border bg-card px-6 py-12 text-center',
        className,
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-[var(--color-danger-bg)] text-[var(--color-danger)]">
        <AlertTriangle className="size-6" aria-hidden="true" />
      </span>

      <div className="flex max-w-prose flex-col gap-2">
        <h2 className="text-lg font-medium text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      {onRetry ? (
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw className="size-4" aria-hidden="true" />
          ลองอีกครั้ง
        </Button>
      ) : null}

      {traceId ? (
        <p className="text-xs text-muted-foreground">
          รหัสอ้างอิง: <code className="font-mono">{traceId}</code>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The offline case, separated because the advice is different: retrying is pointless
 * until the connection is back, so the wording says so rather than offering a button
 * that will fail again.
 */
export function OfflineState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <WifiOff className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">
        ดูเหมือนว่าการเชื่อมต่ออินเทอร์เน็ตหลุด ตรวจสอบการเชื่อมต่อแล้วลองใหม่
      </p>
      {onRetry ? (
        <Button variant="outline" onClick={onRetry}>
          ลองอีกครั้ง
        </Button>
      ) : null}
    </div>
  );
}
