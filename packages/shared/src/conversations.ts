import { z } from 'zod';

/**
 * Stream 2: conversation intent (SPEC §5.3). A thread is the lead: a public post where someone
 * asks for what the workspace sells. Nobody's identity is resolved, and replies are written and
 * posted by a person, never by the app.
 */

export const THREAD_SOURCES = ['hn', 'bluesky', 'stackexchange', 'github', 'reddit'] as const;
export type ThreadSource = (typeof THREAD_SOURCES)[number];

export const THREAD_SOURCE_LABELS: Record<ThreadSource, { short: string; label: string }> = {
  hn: { short: 'HN', label: 'Hacker News' },
  bluesky: { short: 'BSKY', label: 'Bluesky' },
  stackexchange: { short: 'SE', label: 'Stack Exchange' },
  github: { short: 'GH', label: 'GitHub' },
  reddit: { short: 'RDT', label: 'Reddit (via search)' },
};

/** How each source runs (SPEC §5.3 table). `live` = a stream, not a poll. */
export const THREAD_SOURCE_SCHEDULE: Record<
  ThreadSource,
  { everyMs: number | null; text: string }
> = {
  hn: { everyMs: 15 * 60_000, text: 'every 15 minutes' },
  bluesky: { everyMs: null, text: 'live' },
  stackexchange: { everyMs: 60 * 60_000, text: 'hourly' },
  github: { everyMs: 24 * 60 * 60_000, text: 'daily' },
  reddit: { everyMs: 24 * 60 * 60_000, text: 'daily, within the free Serper queries' },
};

/** Which workspace key a source needs (null = none). */
export const THREAD_SOURCE_KEY: Record<ThreadSource, string | null> = {
  hn: null,
  bluesky: null,
  stackexchange: 'stackexchange',
  github: 'github',
  reddit: 'serper',
};

export const THREAD_STATES = ['new', 'replied', 'dismissed', 'converted'] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export const THREAD_FEEDBACK = ['good', 'not_relevant'] as const;
export type ThreadFeedback = (typeof THREAD_FEEDBACK)[number];

/** Inbox labels (docs/ui.md §3.5, Octolens). `none` = no buying intent. */
export const THREAD_LABELS = ['buy_intent', 'alternative', 'pain', 'question', 'none'] as const;
export type ThreadLabel = (typeof THREAD_LABELS)[number];
export const THREAD_LABEL_TEXT: Record<ThreadLabel, string> = {
  buy_intent: 'Buy intent',
  alternative: 'Alternative',
  pain: 'Pain',
  question: 'Question',
  none: 'No intent',
};

export const BUYING_STAGES = [
  'problem_aware',
  'researching',
  'evaluating',
  'ready_to_buy',
  'using_competitor',
  'unknown',
] as const;
export type BuyingStage = (typeof BUYING_STAGES)[number];
export const BUYING_STAGE_TEXT: Record<BuyingStage, string> = {
  problem_aware: 'problem aware',
  researching: 'researching',
  evaluating: 'evaluating',
  ready_to_buy: 'ready to buy',
  using_competitor: 'uses a competitor',
  unknown: 'unknown',
};

/** Threads with this intent or more enter the inbox (SPEC §5.3 step 4). */
export const INBOX_MIN_INTENT = 2;

/** Unactioned threads expire (SPEC §5.3, §9 retention). */
export const THREAD_TTL_DAYS = 90;

/** Signal weight on an account created from a thread, by intent (SPEC §4.2). */
export const THREAD_SIGNAL_WEIGHTS: Record<number, number> = { 2: 3, 3: 5 };

/** Default Stack Exchange sites searched when the workspace hasn't chosen any. */
export const DEFAULT_STACKEXCHANGE_SITES = ['stackoverflow', 'softwarerecs', 'webapps'] as const;

/** Stack Exchange `site` api_parameter (e.g. `stackoverflow`, `superuser`, `dba`). */
export const stackExchangeSiteSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]{2,60}$/, 'a site id such as stackoverflow or superuser');

export const conversationSettingsSchema = z
  .object({
    stackexchangeSites: z.array(stackExchangeSiteSchema).min(1).max(8),
    /** Most threads scored by the LLM per workspace per day (each costs a fraction of a cent). */
    dailyScoringCap: z.number().int().min(0).max(2000),
  })
  .partial()
  .strict();
export type ConversationSettingsInput = z.infer<typeof conversationSettingsSchema>;

export const sourceToggleSchema = z.object({ enabled: z.boolean() }).strict();

/** PATCH /inbox/:id. Snooze hides a thread from Priority until the time given. */
export const threadUpdateSchema = z
  .object({
    state: z.enum(['new', 'replied', 'dismissed']).optional(),
    feedback: z.enum(THREAD_FEEDBACK).nullable().optional(),
    snoozeDays: z.number().int().min(0).max(30).optional(),
    replyDraft: z.string().max(4000).nullable().optional(),
  })
  .strict();
export type ThreadUpdate = z.infer<typeof threadUpdateSchema>;

export const INBOX_TABS = ['priority', 'all', 'replied', 'dismissed'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];
