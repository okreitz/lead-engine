// Drizzle schema for SPEC §3. Timestamps are integer milliseconds since the epoch;
// ids are prefixed random strings (see `ids.ts`).
//
// Deliberate differences from SPEC §3:
// - No `linkedinUrl` on Company or Contact: we never store LinkedIn-derived data (CLAUDE.md).
// - Auth tables (`sessions`, `api_tokens`), the offer version table, the provider cache and
//   free-quota counters are added; SPEC §3 doesn't list them but §4/§8/§10 need them.
// - Thread, Site, Visit, IpCompany and IpLookupCache arrive with streams 1 and 2 (Phases 3–4).
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

export const companies = sqliteTable('companies', {
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
  updatedAt: ts('updated_at').notNull(),
});

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
