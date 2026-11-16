/**
 * One source of truth for every provider key and instance setting: what it is for, what it
 * costs, where to create it and the minimum scope. Used by Settings → Provider keys, every
 * "missing key" message, and the "Getting your keys" table in docs/providers.md.
 * Links are checked against the vendor's own pages; the date is `PROVIDER_HELP_CHECKED`.
 */

export const PROVIDER_HELP_CHECKED = '2026-11-16';

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
    id: 'anthropic',
    label: 'Anthropic API',
    kind: 'workspace-key',
    status: 'active',
    usedFor: 'LLM for offer drafts, fit scoring, people extraction and inbox thread scoring',
    cost: 'pay as you go; claude-haiku-5-5 is $0.10 / $0.50 per million input / output tokens',
    createUrl: 'https://platform.claude.com/settings/keys',
    createUrlIsDocs: false,
    scope: 'no scopes; set a monthly spend limit in the Claude Console as a second cap',
  },
  {
    id: 'aws-ses',
    label: 'Amazon SES',
    kind: 'workspace-key',
    status: 'active',
    usedFor: 'Email validation (SES Email Validation API), before Icypeas; never sending',
    cost: '$0.01 per address validated; no free tier for validation',
    createUrl: 'https://console.aws.amazon.com/iam/home#/users',
    createUrlIsDocs: false,
    scope:
      'an IAM user whose only policy allows ses:GetEmailAddressInsights on Resource "*"; create an access key ("Other"), then enter the key ID, secret and SES region',
  },
  {
    id: 'icypeas',
    label: 'Icypeas',
    kind: 'workspace-key',
    status: 'active',
    usedFor: 'Email finder (and verifier when neither Reacher nor SES is set); never Find People',
    cost: 'from $19/month for 1,000 credits; verify 0.1 credit, find 1 credit only when found',
    createUrl: 'https://app.icypeas.com/bo/api',
    createUrlIsDocs: false,
    scope: 'turn on "Activate API Access", then copy the API key (no scopes)',
  },
  {
    id: 'ipapi',
    label: 'ipapi.is',
    kind: 'workspace-key',
    status: 'active',
    usedFor:
      'Website visitors (stream 1): classifies US visitor IPs (business, ISP, mobile, hosting, VPN) and names the company',
    cost: 'free key: 1,000 lookups/day, commercial use allowed; capped at the free tier here ($0 paid)',
    createUrl: 'https://ipapi.is/app/signup',
    createUrlIsDocs: false,
    scope:
      'no scopes; the key is shown at ipapi.is/app after signup. One account per workspace (their terms forbid sharing a key)',
  },
  {
    id: 'serper',
    label: 'Serper',
    kind: 'workspace-key',
    status: 'active',
    usedFor:
      'Inbox (stream 2): Reddit threads found through Google search (site:reddit.com), daily; only URL, title and snippet are kept',
    cost: '2,500 free queries once, no card; paid packs start at $50, so paid queries are capped at $0 here',
    createUrl: 'https://serper.dev/api-keys',
    createUrlIsDocs: false,
    scope: 'no scopes; one Serper account per workspace (their terms allow one account per person)',
  },
  {
    id: 'stackexchange',
    label: 'Stack Exchange',
    kind: 'workspace-key',
    status: 'active',
    usedFor: 'Inbox (stream 2): Stack Exchange question search (/search/advanced), hourly',
    cost: 'free; 10,000 requests/day per IP with a key',
    createUrl: 'https://stackapps.com/applications',
    createUrlIsDocs: false,
    scope:
      'register an application, then "Generate API Key" (no OAuth, no client secret needed); set an expiry date',
  },
  {
    id: 'github',
    label: 'GitHub',
    kind: 'workspace-key',
    status: 'active',
    usedFor: 'Inbox (stream 2): issue search (REST) and discussion search (GraphQL), daily',
    cost: 'free; 30 searches/minute and 5,000 GraphQL points/hour per token',
    createUrl: 'https://github.com/settings/personal-access-tokens/new',
    createUrlIsDocs: false,
    scope:
      'fine-grained token, Repository access "Public repositories", no permissions (it can only read public data)',
  },
  {
    id: 'ipinfo',
    label: 'IPinfo Lite',
    kind: 'instance-env',
    status: 'active',
    env: 'LE_IPINFO_TOKEN',
    usedFor:
      'Optional country/ASN database for the collector instead of DB-IP Lite (downloaded at runtime, never shipped)',
    cost: 'free; CC BY-SA 4.0, attribution "IP address data is powered by IPinfo"',
    createUrl: 'https://ipinfo.io/signup',
    createUrlIsDocs: false,
    scope: 'no scopes; the token is at ipinfo.io/dashboard/token',
  },
  {
    id: 'dbip',
    label: 'DB-IP Lite',
    kind: 'instance-env',
    status: 'active',
    env: 'none (default, no account)',
    usedFor: 'Country and ASN of visitor IPs, downloaded monthly to the data volume',
    cost: 'free; CC BY 4.0, attribution "IP Geolocation by DB-IP" on pages using results',
    createUrl: 'https://db-ip.com/db/lite.php',
    createUrlIsDocs: true,
    scope: null,
  },
  {
    id: 'sam',
    label: 'SAM.gov',
    kind: 'workspace-key',
    status: 'later',
    usedFor: 'Optional monthly entity extract (not built yet)',
    cost: 'free; 10 requests/day without a SAM.gov role',
    createUrl: 'https://open.gsa.gov/api/entity-api/',
    createUrlIsDocs: true,
    scope:
      'public API key from your SAM.gov Account Details page (shown once after re-entering your password)',
  },
  {
    id: 'sec-user-agent',
    label: 'SEC EDGAR User-Agent',
    kind: 'instance-env',
    status: 'active',
    env: 'LE_SEC_USER_AGENT',
    usedFor: 'EDGAR import and officers; SEC requires a declared contact instead of a key',
    cost: 'free; at most 10 requests/second',
    createUrl: 'https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data',
    createUrlIsDocs: true,
    scope: 'a contact like "Lead Engine admin@yourdomain.com"',
  },
  {
    id: 'pdl',
    label: 'People Data Labs company dataset',
    kind: 'instance-env',
    status: 'active',
    env: 'Settings → Company data (download link)',
    usedFor: 'Company universe import; no key, a download form',
    cost: 'free; CC BY 4.0',
    createUrl: 'https://www.peopledatalabs.com/company-dataset',
    createUrlIsDocs: false,
    scope: 'request the US file; paste the link they send into Settings → Company data',
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

/** The "Getting your keys" table in docs/providers.md, generated from `PROVIDER_HELP`. */
export function providerHelpMarkdown(): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const rows = PROVIDER_HELP.map(
    (h) =>
      `| ${h.label}${h.status === 'later' ? ' (later phase)' : ''} | ${h.kind === 'workspace-key' ? 'Settings → Provider keys' : cell(h.env ?? '')} | ${cell(h.usedFor)} | ${cell(h.cost)} | [${h.createUrlIsDocs ? 'docs' : 'create'}](${h.createUrl}) | ${cell(h.scope ?? '—')} |`,
  );
  return [
    `Generated from \`PROVIDER_HELP\` in \`packages/shared/src/provider-help.ts\` (links checked ${PROVIDER_HELP_CHECKED}). "docs" means the vendor has no direct key page.`,
    '',
    '| Provider | Where it goes | Used for | Cost | Link | Minimum scope |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}
