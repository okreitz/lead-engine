'use client';
import { api } from '@/lib/api';

export interface IntentPage {
  path: string;
  label: string;
}

export interface Site {
  id: string;
  domain: string;
  siteKey: string;
  intentPages: IntentPage[];
  snippet: string;
  lastEventAt: number | null;
  receiving: boolean;
  check: { at: number; ok: boolean; note: string | null } | null;
  createdAt: number;
}

export interface CollectorStatus {
  collectorUrl: string;
  ipapiKey: boolean;
  geo: { source: string | null; ready: boolean; updatedAt: number | null; error: string | null };
}

export interface VisitorCompany {
  accountId: string;
  name: string;
  domain: string;
  stage: string;
  priority: number;
  fitScore: number | null;
  visits: number;
  pages: number;
  lastAt: number;
  intentPages: { path: string; count: number }[];
  matchSource: string;
  confidence: number;
  path: string[];
}

export interface VisitorsReport {
  site: Site;
  days: number;
  kpi: {
    sessions: number;
    identified: number;
    matchRate: number;
    accounts: number;
    newAccounts: number;
  };
  outcomes: Record<string, { sessions: number; pageviews: number }>;
  companies: VisitorCompany[];
  hidden: number;
  status: CollectorStatus;
}

export const fetchSites = () => api<{ sites: Site[]; status: CollectorStatus }>('/sites');

export async function markWrongCompany(accountId: string) {
  return api<{ domain: string; prefixes: string[]; removedVisits: number }>('/visitors/wrong', {
    method: 'POST',
    body: { accountId },
  });
}

/** "High" from 0.9, "medium" from 0.6, else "low" (the Match column, docs/ui.md §3.6). */
export function confidenceLabel(c: number): string {
  return c >= 0.9 ? 'high' : c >= 0.6 ? 'medium' : 'low';
}

export const pct = (n: number) => `${Math.round(n * 100)}%`;
