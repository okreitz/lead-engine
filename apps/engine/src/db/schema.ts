// Drizzle schema for SPEC §3. Timestamps are integer milliseconds since the epoch;
// ids are prefixed random strings (see `ids.ts`).
//
// Deliberate differences from SPEC §3:
// - No `linkedinUrl` on Company or Contact: we never store LinkedIn-derived data (CLAUDE.md).
// - Auth tables (`sessions`, `api_tokens`), the offer version table, the provider cache and
//   free-quota counters are added; SPEC §3 doesn't list them but §4/§8/§10 need them.
// - Thread (stream 2) adds the matched phrase, a label, persona, self-promo flag, scoring status,
//   snooze, the edited reply draft and the created account; `conversation_sources` keeps each
//   source's schedule, cursor and last result per workspace, and `engine_state` the Bluesky cursor.
// - IpCompany and IpLookupCache carry `workspaceId`: ipapi.is data is licensed to the workspace
//   whose key fetched it, and form fills belong to the workspace's own sites. Daily dropped-traffic
//   counters (`visit_daily`) and daily session salts (`daily_salts`) are added for stream 1.
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();
const ts = (name: string) => integer(name);

// ---------------------------------------------------------------- tenancy and auth

export interface WorkspaceSettings {
  /** Pipeline stages, in board order. */
  stages?: string[];
  /** Priority = fit·fit + intent·intent. */
  scoreWeights?: { fit: number; intent: number };
  /** Accounts at or above this fit score are "qualified". */
  fitThreshold?: number;
  /** Optional per-stream budget shares (0–1). Enforced only when `enforceSubCaps` is true. */
  subCaps?: Partial<Record<'personas' | 'conversations' | 'visits' | 'llm', number>>;
  enforceSubCaps?: boolean;
  /** Which LLM adapter offer drafts and scoring use. */
  llmAdapter?: 'claude-cli' | 'anthropic-api' | 'fake';
  llmModel?: string;
  /** Stream 2 (conversations) options. */
  conversations?: { stackexchangeSites?: string[]; dailyScoringCap?: number };
}

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  allowedCountries: json<string[]>('allowed_countries').notNull().default(['US']),
  monthlyBudgetUsd: real('monthly_budget_usd').notNull().default(50),
  timezone: text('timezone').notNull().default('America/New_York'),
  settings: json<WorkspaceSettings>('settings').notNull().default({}),
  createdAt: ts('created_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const memberships = sqliteTable(
  'memberships',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);

/** Browser sessions. `id` is the SHA-256 of the cookie value; the raw token is never stored. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    csrfToken: text('csrf_token').notNull(),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** Bearer tokens for automation and Ground Control. Only the SHA-256 is stored. */
export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  scope: text('scope', { enum: ['read', 'write'] }).notNull(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
});

/** BYO provider keys, AES-256-GCM under LE_MASTER_KEY (see `crypto/secrets.ts`). */
export const providerKeys = sqliteTable(
  'provider_keys',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    encryptedKey: text('encrypted_key').notNull(),
    createdAt: ts('created_at').notNull(),
    /** Last time a provider call used this key (shown in Settings). */
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.provider] })],
);

// ---------------------------------------------------------------- offer profile

export const offers = sqliteTable('offers', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  websiteUrl: text('website_url').notNull(),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

/**
 * One row per offer version. `data` holds the `OfferProfile` (packages/shared). Streams only
 * use the `approved` version; editing an approved version creates a new draft version.
 */
export const offerVersions = sqliteTable(
  'offer_versions',
  {
    id: text('id').primaryKey(),
    offerId: text('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status', {
      enum: ['drafting', 'draft', 'approved', 'superseded', 'failed'],
    }).notNull(),
    data: json<unknown>('data'),
    source: text('source', { enum: ['llm', 'human'] }).notNull(),
    /** User input for the draft: notes and competitors. */
    input: json<{ notes?: string; competitors?: string[] }>('input'),
    /** Pages the draft was built from: url + title, no content. */
    pages: json<{ url: string; title?: string }[]>('pages'),
    error: text('error'),
    /** Per-field model rationale from the draft ("why"), keyed by field path. */
    rationale: json<Record<string, string>>('rationale'),
    /** Per-field human review of LLM-drafted values: accepted | edited | rejected. */
    review: json<Record<string, 'accepted' | 'edited' | 'rejected'>>('review'),
    jobId: text('job_id'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    approvedAt: ts('approved_at'),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('offer_versions_offer_version_uq').on(t.offerId, t.version)],
);

// ---------------------------------------------------------------- company universe and CRM

export const companies = sqliteTable(
  'companies',
  {
    id: text('id').primaryKey(),
    domain: text('domain').notNull().unique(),
    name: text('name').notNull(),
    country: text('country').notNull(),
    state: text('state'),
    city: text('city'),
    industry: text('industry'),
    naics: text('naics'),
    sizeRange: text('size_range'),
    foundedYear: integer('founded_year'),
    sources: json<string[]>('sources').notNull().default([]),
    tech: json<string[]>('tech').notNull().default([]),
    techCheckedAt: ts('tech_checked_at'),
    /** True once a public dataset (PDL, SEC EDGAR, SAM.gov) listed the company: the ICP filter only
     * searches these, so companies other workspaces added by hand or from visits never leak. */
    universe: integer('universe', { mode: 'boolean' }).notNull().default(false),
    /** Parsed `sizeRange` bounds for SQL filtering (max null = open-ended). */
    sizeMin: integer('size_min'),
    sizeMax: integer('size_max'),
    /** Normalised legal name (lower case, no punctuation or suffixes) for dataset matching. */
    nameKey: text('name_key'),
    /** SEC EDGAR central index key and ticker, for public companies. */
    cik: text('cik'),
    ticker: text('ticker'),
    /** Which dataset filled each firmographic field, e.g. { industry: 'pdl' } (source dots). */
    origins: json<Record<string, string>>('origins').notNull().default({}),
    /** Email pattern learned from addresses published on the company's own site. */
    emailPattern: text('email_pattern'),
    emailPatternExamples: integer('email_pattern_examples'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    index('companies_universe_state_idx').on(t.universe, t.state),
    index('companies_name_key_idx').on(t.nameKey),
    index('companies_cik_idx').on(t.cik),
  ],
);

export interface ScoreReasons {
  fit: string[];
  intent: string[];
}

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    stage: text('stage').notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    fitScore: real('fit_score'),
    intentScore: real('intent_score').notNull().default(0),
    priority: real('priority').notNull().default(0),
    scoreReasons: json<ScoreReasons>('score_reasons'),
    scoredAt: ts('scored_at'),
    firstSource: text('first_source', {
      enum: ['visits', 'conversations', 'personas', 'manual'],
    }).notNull(),
    firstSourceAt: ts('first_source_at').notNull(),
    status: text('status', { enum: ['active', 'suppressed', 'archived'] })
      .notNull()
      .default('active'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('accounts_workspace_company_uq').on(t.workspaceId, t.companyId),
    index('accounts_workspace_priority_idx').on(t.workspaceId, t.priority),
  ],
);

export const EMAIL_STATUSES = [
  'verified',
  'pattern_verified',
  'risky',
  'catch_all',
  'unknown',
  'invalid',
] as const;

export const contacts = sqliteTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    title: text('title'),
    seniority: text('seniority'),
    department: text('department'),
    personaMatch: text('persona_match'),
    email: text('email'),
    /** Lower-cased domain part of `email`, for suppression checks. */
    emailDomain: text('email_domain'),
    emailStatus: text('email_status', { enum: EMAIL_STATUSES }),
    phone: text('phone'),
    status: text('status', { enum: ['active', 'suppressed'] })
      .notNull()
      .default('active'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    index('contacts_account_idx').on(t.accountId),
    index('contacts_workspace_email_idx').on(t.workspaceId, t.email),
  ],
);

/** Provenance per field (SPEC §9). */
export const fieldSources = sqliteTable(
  'field_sources',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    entity: text('entity', { enum: ['company', 'account', 'contact'] }).notNull(),
    entityId: text('entity_id').notNull(),
    field: text('field').notNull(),
    source: text('source').notNull(),
    url: text('url'),
    fetchedAt: ts('fetched_at').notNull(),
    confidence: real('confidence').notNull(),
  },
  (t) => [index('field_sources_entity_idx').on(t.entity, t.entityId)],
);

export const deals = sqliteTable(
  'deals',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    stage: text('stage').notNull(),
    valueUsd: real('value_usd'),
    closedAt: ts('closed_at'),
    outcome: text('outcome', { enum: ['won', 'lost'] }),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('deals_account_idx').on(t.accountId)],
);

export const ACTIVITY_KINDS = [
  'note',
  'email',
  'call',
  'meeting',
  'reply',
  'stage_change',
] as const;

export const activities = sqliteTable(
  'activities',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    dealId: text('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
    body: text('body').notNull(),
    /** For stage changes: { from, to }. */
    meta: json<Record<string, unknown>>('meta'),
    at: ts('at').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('activities_account_idx').on(t.accountId, t.at)],
);

export const nextSteps = sqliteTable(
  'next_steps',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    dueAt: ts('due_at'),
    doneAt: ts('done_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('next_steps_account_idx').on(t.accountId)],
);

export const signals = sqliteTable(
  'signals',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    stream: text('stream', {
      enum: ['visits', 'conversations', 'personas', 'manual'],
    }).notNull(),
    kind: text('kind').notNull(),
    weight: real('weight').notNull(),
    occurredAt: ts('occurred_at').notNull(),
    payload: json<Record<string, unknown>>('payload').notNull().default({}),
    evidenceUrl: text('evidence_url'),
    expiresAt: ts('expires_at'),
  },
  (t) => [index('signals_account_idx').on(t.accountId, t.occurredAt)],
);

/** Saved table/board views (docs/ui.md §3.2). `userId` null = shared with the workspace. */
export interface SavedViewState {
  filters?: Record<string, string[]> | undefined;
  sort?: string | undefined;
  columns?: string[] | undefined;
  layout?: 'table' | 'board' | undefined;
}

export const savedViews = sqliteTable(
  'saved_views',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    entity: text('entity', { enum: ['accounts', 'pipeline'] }).notNull(),
    name: text('name').notNull(),
    state: json<SavedViewState>('state').notNull(),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('saved_views_workspace_idx').on(t.workspaceId, t.entity)],
);

// ---------------------------------------------------------------- company universe import

export const UNIVERSE_SOURCES = ['pdl', 'sec-edgar', 'sam'] as const;
export type UniverseSource = (typeof UNIVERSE_SOURCES)[number];
export const IMPORT_STATES = [
  'queued',
  'downloading',
  'processing',
  'paused',
  'done',
  'failed',
  'cancelled',
] as const;

/** Snapshot of the ICP prefilter an import ran with (null = all US companies with a website). */
export interface ImportFilter {
  industries: string[];
  employeeRange: string | null;
  states: string[];
  exclude: string[];
}

/**
 * One run of the company-universe import (SPEC §5.1 step 1), on the VPS as a resumable engine
 * job: stream-download to the data volume (HTTP Range resume), then stream-parse in slices,
 * keeping US companies with a website, and upsert them in batches.
 */
export const universeImports = sqliteTable(
  'universe_imports',
  {
    id: text('id').primaryKey(),
    /** The workspace that started it (jobs belong to a workspace; companies are shared). */
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    source: text('source', { enum: UNIVERSE_SOURCES }).notNull(),
    /** Download URL; null when the file was placed in the data volume's imports folder. */
    url: text('url'),
    /** File name inside `<data dir>/imports/`. */
    fileName: text('file_name').notNull(),
    state: text('state', { enum: IMPORT_STATES }).notNull(),
    filter: json<ImportFilter>('filter'),
    bytesTotal: integer('bytes_total'),
    bytesDone: integer('bytes_done').notNull().default(0),
    /** Rows parsed so far; also the resume checkpoint (rows before it are already written). */
    rowsRead: integer('rows_read').notNull().default(0),
    /** Rows that passed the US, website and ICP filters. */
    rowsKept: integer('rows_kept').notNull().default(0),
    rowsInserted: integer('rows_inserted').notNull().default(0),
    rowsUpdated: integer('rows_updated').notNull().default(0),
    /** Why rows were dropped: { not_us, no_website, icp, invalid }. */
    dropped: json<Record<string, number>>('dropped').notNull().default({}),
    error: text('error'),
    jobId: text('job_id'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('universe_imports_workspace_idx').on(t.workspaceId, t.createdAt)],
);

// ---------------------------------------------------------------- stream 3: persona fit runs

/** SQL filter over universe companies (SPEC §5.1 step 2), prefilled from the approved ICP. */
export interface CandidateFilters {
  industries: string[];
  naics: string[];
  sizeMin: number | null;
  sizeMax: number | null;
  states: string[];
  foundedFrom: number | null;
  foundedTo: number | null;
  exclude: string[];
}

export interface PersonaRunCounts {
  candidates: number;
  scored: number;
  accounts: number;
  skipped: number;
  errors: number;
  techChecked: number;
}

/**
 * One "Find matching companies" run: candidates from the ICP filter, homepage fetch, optional
 * technographics, LLM fit score; candidates at or above the threshold become accounts.
 */
export const personaRuns = sqliteTable(
  'persona_runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    offerVersionId: text('offer_version_id')
      .notNull()
      .references(() => offerVersions.id, { onDelete: 'cascade' }),
    filters: json<CandidateFilters>('filters').notNull(),
    limit: integer('limit').notNull(),
    threshold: integer('threshold').notNull(),
    options: json<{ tech: boolean; people: boolean }>('options').notNull(),
    state: text('state', { enum: ['queued', 'running', 'done', 'failed', 'cancelled'] }).notNull(),
    counts: json<PersonaRunCounts>('counts').notNull(),
    estimateUsd: real('estimate_usd').notNull(),
    /** Why technographics were skipped (e.g. httpx not installed). */
    techNote: text('tech_note'),
    error: text('error'),
    jobId: text('job_id'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('persona_runs_workspace_idx').on(t.workspaceId, t.createdAt)],
);

export const personaCandidates = sqliteTable(
  'persona_candidates',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => personaRuns.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    /** Rule-based fit when selected (ranks the candidate list). */
    ruleFit: integer('rule_fit').notNull(),
    state: text('state', { enum: ['pending', 'scored', 'skipped', 'error'] }).notNull(),
    /** LLM homepage fit, its reasons and a quote checked against the page. */
    llmFit: integer('llm_fit'),
    fit: integer('fit'),
    reasons: json<string[]>('reasons'),
    evidence: text('evidence'),
    evidenceUrl: text('evidence_url'),
    note: text('note'),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    scoredAt: ts('scored_at'),
  },
  (t) => [
    uniqueIndex('persona_candidates_run_company_uq').on(t.runId, t.companyId),
    index('persona_candidates_run_idx').on(t.runId, t.state, t.position),
  ],
);

// ---------------------------------------------------------------- stream 1: website visits

/** A page path that marks buying intent on a site, e.g. { path: '/pricing', label: 'pricing' }. */
export interface IntentPage {
  path: string;
  label: string;
}

/** A website running the snippet (SPEC §5.2). `siteKey` is public: it is in the snippet. */
export const sites = sqliteTable(
  'sites',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    siteKey: text('site_key').notNull().unique(),
    intentPages: json<IntentPage[]>('intent_pages').notNull().default([]),
    /** Last event the collector accepted for this site (install check). */
    lastEventAt: ts('last_event_at'),
    /** Last install check: snippet found on the homepage or not. */
    checkedAt: ts('checked_at'),
    checkOk: integer('check_ok', { mode: 'boolean' }),
    checkNote: text('check_note'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('sites_workspace_domain_uq').on(t.workspaceId, t.domain)],
);

export const MATCH_SOURCES = ['form', 'ptr', 'asn', 'provider', 'manual'] as const;
export type MatchSource = (typeof MATCH_SOURCES)[number];

/**
 * A page view of a matched (US, business, company-identified) visitor. Unmatched traffic is
 * never stored; it only increments `visit_daily`. No IP: `sessionHash` is an HMAC of IP,
 * user agent and site under a salt that is deleted the next day.
 */
export const visits = sqliteTable(
  'visits',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sessionHash: text('session_hash').notNull(),
    path: text('path').notNull(),
    referrer: text('referrer'),
    utm: json<Record<string, string>>('utm'),
    /** How the company was matched, for the Match column and "Wrong company". */
    matchSource: text('match_source', { enum: MATCH_SOURCES }).notNull(),
    confidence: real('confidence').notNull(),
    ipCompanyId: text('ip_company_id'),
    at: ts('at').notNull(),
  },
  (t) => [
    index('visits_site_at_idx').on(t.siteId, t.at),
    index('visits_account_at_idx').on(t.accountId, t.at),
    index('visits_session_idx').on(t.sessionHash, t.accountId),
  ],
);

/**
 * IP prefix → company domain (SPEC §5.2 "own IP map"). Ranges are stored as 32-hex-digit
 * IPv6 values (IPv4 as ::ffff:a.b.c.d) so a containment check is a string comparison.
 * `wrong` rows are corrections from "Wrong company": they block that match for the prefix.
 */
export const ipCompanies = sqliteTable(
  'ip_companies',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    prefix: text('prefix').notNull(),
    ipStart: text('ip_start').notNull(),
    ipEnd: text('ip_end').notNull(),
    /** Prefix length in IPv6 bits (an IPv4 /24 is 120), for "most specific wins". */
    prefixLen: integer('prefix_len').notNull(),
    companyDomain: text('company_domain').notNull(),
    source: text('source', { enum: MATCH_SOURCES }).notNull(),
    confidence: real('confidence').notNull(),
    wrong: integer('wrong', { mode: 'boolean' }).notNull().default(false),
    seenAt: ts('seen_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    index('ip_companies_lookup_idx').on(t.workspaceId, t.ipStart, t.ipEnd),
    uniqueIndex('ip_companies_prefix_uq').on(t.workspaceId, t.prefix, t.companyDomain),
  ],
);

/** Trimmed ipapi.is results per workspace, 30-day TTL (ipapi.is terms §2.2). */
export const ipLookupCache = sqliteTable(
  'ip_lookup_cache',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ip: text('ip').notNull(),
    result: json<Record<string, unknown>>('result').notNull(),
    fetchedAt: ts('fetched_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.ip] }),
    index('ip_lookup_cache_expires_idx').on(t.expiresAt),
  ],
);

export const VISIT_OUTCOMES = [
  'matched',
  'non_us',
  'bot',
  'isp',
  'mobile',
  'hosting',
  'vpn',
  'unmatched',
  'unclassified',
  'suppressed',
  'rate_limited',
] as const;
export type VisitOutcome = (typeof VISIT_OUTCOMES)[number];

/** Aggregate daily counters per site and outcome; the only trace dropped traffic leaves. */
export const visitDaily = sqliteTable(
  'visit_daily',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** UTC date, YYYY-MM-DD. */
    day: text('day').notNull(),
    outcome: text('outcome', { enum: VISIT_OUTCOMES }).notNull(),
    sessions: integer('sessions').notNull().default(0),
    pageviews: integer('pageviews').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.day, t.outcome] })],
);

/** The current day's random session salt; older salts are deleted, so hashes can't be linked. */
export const dailySalts = sqliteTable('daily_salts', {
  day: text('day').primaryKey(),
  salt: text('salt').notNull(),
});

// ---------------------------------------------------------------- stream 2: conversations

export const THREAD_SOURCE_IDS = ['hn', 'bluesky', 'stackexchange', 'github', 'reddit'] as const;

/** What the LLM said the poster named (only when they named it) and the US company it matched. */
export interface CompanyMention {
  name: string;
  domain: string | null;
}

/**
 * A public thread where someone may be asking for what the workspace sells (SPEC §3 Thread).
 * The thread is the lead: no identity resolution. For Reddit only URL, title and the search
 * snippet are stored. `externalId` is the source's own id (HN objectID, at:// URI, …).
 */
export const threads = sqliteTable(
  'threads',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    source: text('source', { enum: THREAD_SOURCE_IDS }).notNull(),
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    excerpt: text('excerpt').notNull(),
    author: text('author'),
    postedAt: ts('posted_at').notNull(),
    matchedPhrase: text('matched_phrase').notNull(),
    phraseKind: text('phrase_kind').notNull(),
    scoreStatus: text('score_status', { enum: ['pending', 'scored', 'failed', 'skipped'] })
      .notNull()
      .default('pending'),
    intent: integer('intent'),
    label: text('label'),
    pain: text('pain'),
    stage: text('stage'),
    persona: text('persona'),
    suggestedReply: text('suggested_reply'),
    /** The person's edit of the suggested reply (never posted by the app). */
    replyDraft: text('reply_draft'),
    companyMentioned: json<CompanyMention>('company_mentioned'),
    selfPromo: integer('self_promo', { mode: 'boolean' }).notNull().default(false),
    scoreReason: text('score_reason'),
    scoreError: text('score_error'),
    scoredAt: ts('scored_at'),
    state: text('state', { enum: ['new', 'replied', 'dismissed', 'converted'] })
      .notNull()
      .default('new'),
    feedback: text('feedback', { enum: ['good', 'not_relevant'] }),
    feedbackAt: ts('feedback_at'),
    snoozedUntil: ts('snoozed_until'),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    /** Source details shown in the UI (site, tags, repository); never personal data. */
    meta: json<Record<string, unknown>>('meta').notNull().default({}),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('threads_workspace_url_uq').on(t.workspaceId, t.url),
    index('threads_inbox_idx').on(t.workspaceId, t.state, t.intent),
    index('threads_score_idx').on(t.workspaceId, t.scoreStatus),
    index('threads_external_idx').on(t.source, t.externalId),
    index('threads_expires_idx').on(t.expiresAt),
  ],
);

/** Schedule, cursor and last result of each source per workspace. */
export const conversationSources = sqliteTable(
  'conversation_sources',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    source: text('source', { enum: THREAD_SOURCE_IDS }).notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    cursor: json<Record<string, unknown>>('cursor').notNull().default({}),
    lastRunAt: ts('last_run_at'),
    nextRunAt: ts('next_run_at'),
    lastStatus: text('last_status', { enum: ['ok', 'error', 'waiting'] }),
    lastError: text('last_error'),
    /** Items the last run saw, and how many became new threads. */
    lastFound: integer('last_found'),
    lastNew: integer('last_new'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.source] })],
);

/** Small engine-wide values that must survive restarts (the Jetstream cursor). */
export const engineState = sqliteTable('engine_state', {
  key: text('key').primaryKey(),
  value: json<unknown>('value').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

// ---------------------------------------------------------------- control

/** `workspaceId` null = global. Values are lower-cased. */
export const suppressions = sqliteTable(
  'suppressions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['email', 'domain'] }).notNull(),
    value: text('value').notNull(),
    reason: text('reason').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('suppressions_value_idx').on(t.kind, t.value)],
);

export const costLedger = sqliteTable(
  'cost_ledger',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    operation: text('operation').notNull(),
    units: real('units').notNull(),
    usd: real('usd').notNull(),
    /** True when `usd` is a client-side estimate (e.g. the claude CLI's total_cost_usd). */
    estimated: integer('estimated', { mode: 'boolean' }).notNull().default(false),
    /** True when the call was covered by a free quota (usd = 0). */
    free: integer('free', { mode: 'boolean' }).notNull().default(false),
    stream: text('stream').notNull(),
    jobId: text('job_id'),
    /** The record the money was spent on, so every charge links back (docs/ui.md §1.3). */
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    meta: json<Record<string, unknown>>('meta'),
    at: ts('at').notNull(),
  },
  (t) => [index('cost_ledger_workspace_at_idx').on(t.workspaceId, t.at)],
);

/** Provider responses per workspace (BYO-key data is not shared across workspaces). */
export const providerCache = sqliteTable(
  'provider_cache',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    provider: text('provider').notNull(),
    operation: text('operation').notNull(),
    result: json<unknown>('result').notNull(),
    fetchedAt: ts('fetched_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

/** Free-quota counters, e.g. ipapi.is per day, Serper lifetime. */
export const quotaUsage = sqliteTable(
  'quota_usage',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    period: text('period').notNull(),
    used: integer('used').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.provider, t.period] })],
);

export const JOB_STATES = ['queued', 'running', 'waiting', 'done', 'failed'] as const;

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: json<Record<string, unknown>>('payload').notNull(),
    state: text('state', { enum: JOB_STATES }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAt: ts('run_at').notNull(),
    lastError: text('last_error'),
    /** Why a job is `waiting`, shown in the UI (e.g. "budget reached"). */
    waitReason: text('wait_reason'),
    result: json<unknown>('result'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('jobs_due_idx').on(t.state, t.runAt)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target: text('target').notNull(),
    at: ts('at').notNull(),
    details: json<Record<string, unknown>>('details').notNull().default({}),
  },
  (t) => [index('audit_log_workspace_at_idx').on(t.workspaceId, t.at)],
);
