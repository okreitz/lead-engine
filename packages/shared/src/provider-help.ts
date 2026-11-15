/**
 * One source of truth for every provider key and instance setting: what it is for, what it
 * costs, where to create it and the minimum scope. Used by Settings → Provider keys, every
 * "missing key" message, and the "Getting your keys" table in docs/providers.md.
 * Links are checked against the vendor's own pages; the date is `PROVIDER_HELP_CHECKED`.
 */

export const PROVIDER_HELP_CHECKED = '2026-11-15';

export interface ProviderHelp {
  /** Key id in Settings (`provider_keys.provider`) or the instance setting's id. */
  id: string;
  label: string;
  /** workspace-key: BYO key in Settings; instance-env: env var on the server. */
  kind: 'workspace-key' | 'instance-env';
  /** `later`: listed for completeness, used from a later phase. */
  status: 'active' | 'later';
  usedFor: string;
  cost: string;
  /** Where the key is created; a docs page when the vendor has no direct page. */
  createUrl: string;
  createUrlIsDocs: boolean;
  /** Minimum permission or scope to choose, where that applies. */
  scope: string | null;
  /** Environment variable for instance settings. */
  env?: string;
}

export const PROVIDER_HELP: ProviderHelp[] = [
  {
    id: 'icypeas',
    label: 'Icypeas',
    kind: 'workspace-key',
    status: 'active',
    usedFor: 'Email finder and verifier (never Find People)',
    cost: 'from $19/month for 1,000 credits; verify 0.1 credit, find 1 credit only when found',
    createUrl: 'https://api-doc.icypeas.com/authentication.md',
    createUrlIsDocs: true,
    scope: null,
  },
  {
    id: 'ipapi',
    label: 'ipapi.is',
    kind: 'workspace-key',
    status: 'later',
    usedFor: 'Website visitor company lookup (stream 1)',
    cost: 'free key: 1,000 lookups/day',
    createUrl: 'https://ipapi.is/pricing.html',
    createUrlIsDocs: true,
    scope: null,
  },
  {
    id: 'serper',
    label: 'Serper',
    kind: 'workspace-key',
    status: 'later',
    usedFor: 'Reddit threads via Google search (stream 2)',
    cost: '2,500 free queries; paid packs start at $50 (capped at $0 here)',
    createUrl: 'https://serper.dev/',
    createUrlIsDocs: true,
    scope: null,
  },
  {
    id: 'anthropic',
    label: 'Anthropic API',
    kind: 'workspace-key',
    status: 'active',
    usedFor: 'LLM for offer drafts, fit scoring and people extraction',
    cost: 'claude-haiku-5-5: $0.10 / $0.50 per million input / output tokens',
    createUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    createUrlIsDocs: true,
    scope: null,
  },
  {
    id: 'sec-user-agent',
    label: 'SEC EDGAR User-Agent',
    kind: 'instance-env',
    status: 'active',
    env: 'LE_SEC_USER_AGENT',
    usedFor: 'EDGAR import and officers; SEC requires a declared contact (no key)',
    cost: 'free; at most 10 requests/second',
    createUrl: 'https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data',
    createUrlIsDocs: true,
    scope: 'a contact like "Lead Engine admin@yourdomain.com"',
  },
];

export function helpFor(id: string): ProviderHelp | undefined {
  return PROVIDER_HELP.find((h) => h.id === id);
}

/** The key a message is about ("no Icypeas key: add it in Settings → Provider keys"). */
export function keyHelpForText(text: string): ProviderHelp | undefined {
  if (!/key/i.test(text)) return undefined;
  return PROVIDER_HELP.find(
    (h) => h.kind === 'workspace-key' && text.toLowerCase().includes(h.label.toLowerCase()),
  );
}
