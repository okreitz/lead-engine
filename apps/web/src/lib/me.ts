'use client';
import { useQuery } from '@tanstack/react-query';
import { api, setCsrfToken } from './api';
import type { Me } from './types';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const me = await api<Me>('/auth/me');
      setCsrfToken(me.csrfToken);
      return me;
    },
  });
}
