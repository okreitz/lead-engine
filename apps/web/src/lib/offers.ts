'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface OfferRow {
  id: string;
  name: string;
  websiteUrl: string;
  updatedAt: number;
  latest: { version: number; status: string } | null;
  approvedVersion: number | null;
}

/** Display name of an offer: its name, else its website. */
export const offerLabel = (o: Pick<OfferRow, 'name' | 'websiteUrl'>) => o.name || o.websiteUrl;

/** The workspace's offers (funnels), with helpers for pickers, filters and badges. */
export function useOffers() {
  const query = useQuery({ queryKey: ['offers'], queryFn: () => api<OfferRow[]>('/offers') });
  const all = query.data ?? [];
  const approved = all.filter((o) => o.approvedVersion !== null);
  const byId = new Map(all.map((o) => [o.id, o]));
  return {
    query,
    all,
    approved,
    /** More than one offer: show offer pickers, filters and badges. */
    multiple: all.length > 1,
    name: (id: string | null | undefined) => {
      if (!id) return null;
      const o = byId.get(id);
      return o ? offerLabel(o) : null;
    },
  };
}
