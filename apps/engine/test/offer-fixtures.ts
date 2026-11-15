import { REVIEW_FIELDS } from '@le/shared';

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
