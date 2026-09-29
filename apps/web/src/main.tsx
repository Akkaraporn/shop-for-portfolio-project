import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { createQueryClient } from '@/api/query-client';
import { bootstrap } from '@/auth/session';
import { Toaster } from '@/components/ui/sonner';
import { router } from '@/router';

import './index.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('#root is missing from index.html');
}

// Restore the session before anything asks the API for user-scoped data. Memoised
// inside, so StrictMode's double mount cannot start a second refresh.
void bootstrap();

const queryClient = createQueryClient();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  </StrictMode>,
);
