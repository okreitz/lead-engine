import { REVIEW_FIELDS } from '@le/shared';
import type { AppContext } from '../src/api/context.ts';
import { offers, offerVersions, workspaces } from '../src/db/schema.ts';

export function draft(overrides: object = {}) {
  return {
    name: 'Acme Rockets',
    summary: 'Acme sells reusable rockets to logistics teams.',
    valueProps: ['Cheaper launches'],
    competitors: ['SpaceY'],
    icp: {
      industries: ['Logistics', 'Aerospace'],
      naics: ['4841'],
      employeeRange: '51-500',
      revenueRange: null,
      states: ['CA', 'TX'],
      techUses: ['Salesforce'],
      techAvoids: ['SAP'],
      mustHave: [],
      exclude: ['government'],
    },
    personas: [
      {
        title: 'VP Operations',
        seniority: 'VP',
        department: 'Operations',
        pains: ['slow shipping'],
        titleKeywords: ['operations'],
      },
    ],
    intentPhrases: Array.from({ length: 25 }, (_, i) => ({
      phrase: `need faster launches ${i}`,
      kind: 'seeking',
      negative: ['job'],
    })),
    ...overrides,
  };
}

/** What the model returns: the draft plus a "why" per field. */
export function llmDraft(overrides: object = {}) {
  return {
    ...draft(overrides),
    rationale: [
      { field: 'summary', why: 'The homepage says it sells rockets to logistics teams.' },
      { field: 'icp.industries', why: 'Customers named on the homepage are carriers.' },
    ],
  };
}

export const ACCEPT_ALL = Object.fromEntries(REVIEW_FIELDS.map((f) => [f, 'accepted']));

/**
 * Inserts an approved offer version with the given ICP overrides (no draft job). Returns the
 * version id. `opts.key` gives a second offer distinct ids (`off_<key>`, `ofv_<key>`).
 */
export function approveOffer(
  ctx: AppContext,
  icp: object = {},
  extra: object = {},
  opts: { key?: string; name?: string; websiteUrl?: string; approvedAt?: number } = {},
): string {
  const now = ctx.now();
  const ws = ctx.db.select().from(workspaces).get()!;
  const key = opts.key ?? String(now);
  const offerId = `off_${key}`;
  ctx.db
    .insert(offers)
    .values({
      id: offerId,
      workspaceId: ws.id,
      name: opts.name ?? 'X',
      websiteUrl: opts.websiteUrl ?? 'https://x.com',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const id = `ofv_${key}`;
  ctx.db
    .insert(offerVersions)
    .values({
      id,
      offerId,
      workspaceId: ws.id,
      version: 1,
      status: 'approved',
      source: 'human',
      data: draft({ icp: { ...draft().icp, ...icp }, ...extra }),
      createdAt: now,
      updatedAt: now,
      approvedAt: opts.approvedAt ?? now,
    })
    .run();
  return id;
}
