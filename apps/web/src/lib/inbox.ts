'use client';
import type {
  BuyingStage,
  InboxTab,
  ThreadFeedback,
  ThreadLabel,
  ThreadSource,
  ThreadState,
} from '@le/shared';
import { api } from '@/lib/api';

export interface Thread {
  id: string;
  source: ThreadSource;
  sourceLabel: string;
  url: string;
  title: string;
  excerpt: string;
  author: string | null;
  postedAt: number;
  matchedPhrase: string;
  phraseKind: string;
  scoreStatus: 'pending' | 'scored' | 'failed' | 'skipped';
  intent: number | null;
  label: ThreadLabel | null;
  pain: string | null;
  stage: BuyingStage | null;
  persona: string | null;
  reason: string | null;
  suggestedReply: string | null;
  replyDraft: string | null;
  companyMentioned: { name: string; domain: string | null } | null;
  selfPromo: boolean;
  state: ThreadState;
  feedback: ThreadFeedback | null;
  snoozed: boolean;
  snoozedUntil: number | null;
  accountId: string | null;
  meta: Record<string, unknown>;
  expiresAt: number;
  canCreateAccount: boolean;
  createAccountReason: string | null;
  company: { id: string; name: string; domain: string } | null;
}

export interface InboxList {
  threads: Thread[];
  counts: Record<InboxTab, number>;
}

export interface SourceStatus {
  source: ThreadSource;
  label: string;
  schedule: string;
  enabled: boolean;
  key: string | null;
  keyConfigured: boolean | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: 'ok' | 'error' | 'waiting' | null;
  lastError: string | null;
  lastFound: number | null;
  lastNew: number | null;
  live?: {
    connected: boolean;
    workspaces: number;
    events: number;
    matched: number;
    lastEventAt: number | null;
    lastError: string | null;
  } | null;
}

export interface SourcesResponse {
  sources: SourceStatus[];
  settings: { stackexchangeSites: string[] };
}

export function fetchInbox(tab: InboxTab, source: string | null, minIntent: number | null) {
  const p = new URLSearchParams({ tab });
  if (source) p.set('source', source);
  if (minIntent !== null) p.set('minIntent', String(minIntent));
  return api<InboxList>(`/inbox?${p.toString()}`);
}

export const fetchSources = () => api<SourcesResponse>('/conversations/sources');

export function updateThread(
  id: string,
  body: {
    state?: 'new' | 'replied' | 'dismissed';
    feedback?: ThreadFeedback | null;
    snoozeDays?: number;
    replyDraft?: string | null;
  },
) {
  return api<Thread>(`/inbox/${id}`, { method: 'PATCH', body });
}

export function createAccount(id: string) {
  return api<{ accountId: string; created: boolean; company: { name: string; domain: string } }>(
    `/inbox/${id}/account`,
    { method: 'POST' },
  );
}

export function ago(ms: number, now = Date.now()): string {
  const m = (now - ms) / 60_000;
  if (m < 1) return 'now';
  if (m < 60) return `${Math.floor(m)}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}
