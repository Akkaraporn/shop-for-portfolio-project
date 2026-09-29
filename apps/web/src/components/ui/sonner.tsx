import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

/**
 * Toasts, wired to this project's tokens.
 *
 * shadcn's version reads the active theme from `next-themes`. There is no theme to
 * read: dark mode is deliberately not built (docs/future.md), so the dependency and
 * the hook are removed rather than carried for a feature that does not exist. The
 * tokens below come straight from index.css.
 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--surface-raised)',
          '--normal-text': 'var(--text-primary)',
          '--normal-border': 'var(--border-subtle)',
          '--border-radius': 'var(--radius-surface)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
