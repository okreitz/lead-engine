'use client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [client] = useState(() => {
    // An expired session anywhere sends the user back to the login page.
    const onError = (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) router.replace('/login');
    };
    return new QueryClient({
      queryCache: new QueryCache({ onError }),
      mutationCache: new MutationCache({ onError }),
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5_000 },
      },
    });
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
