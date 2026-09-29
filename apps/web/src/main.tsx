import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createQueryClient } from '@/api/query-client';
import { Toaster } from '@/components/ui/sonner';
import { DesignSystem } from '@/design-system';

import './index.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('#root is missing from index.html');
}

/**
 * Task 3.0 ships the design system and nothing else — the real pages arrive with
 * 3.3, and the API client with 3.1. Until then the design system *is* the app, which
 * is the point: the tokens get looked at before anything is built on them.
 */
const queryClient = createQueryClient();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DesignSystem />
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  </StrictMode>,
);
