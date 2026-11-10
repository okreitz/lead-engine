/** Default local ports (SPEC §2, CLAUDE.md). */
export const PORTS = {
  web: 4500,
  engine: 4501,
  collector: 4511,
} as const;

/** Local mode binds to loopback only (CLAUDE.md "Bind and auth"). */
export const DEFAULT_HOST = '127.0.0.1';

/** v1 is US only (SPEC §9). */
export const ALLOWED_COUNTRIES = ['US'] as const;
export type AllowedCountry = (typeof ALLOWED_COUNTRIES)[number];

/** Default monthly spend cap per workspace, in USD (SPEC §8.1). */
export const DEFAULT_MONTHLY_BUDGET_USD = 50;

/** Collector request body cap in bytes (SPEC §5.2, §10). */
export const COLLECTOR_BODY_LIMIT_BYTES = 2048;

/** Default pipeline stages (SPEC §6). Workspaces may override them. */
export const DEFAULT_STAGES = [
  'New',
  'Researching',
  'Contacted',
  'Replied',
  'Meeting',
  'Proposal',
  'Won',
  'Lost',
] as const;

/** Stages that count as "contacted or later" for the ROI view (SPEC §8.3). */
export const QUALIFIED_STAGE_INDEX = 2;

/** Budget warning threshold as a share of the monthly budget (SPEC §8.1). */
export const BUDGET_WARNING_SHARE = 0.8;

/** Default fit threshold for accounts (SPEC §5.1 step 4). */
export const DEFAULT_FIT_THRESHOLD = 60;

/** Default priority weights (SPEC §4.2). */
export const DEFAULT_SCORE_WEIGHTS = { fit: 0.6, intent: 0.4 } as const;

/** Providers that accept a workspace (BYO) key. */
export const KEYED_PROVIDERS = ['ipapi', 'icypeas', 'serper', 'anthropic'] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];

export const STREAMS = ['visits', 'conversations', 'personas', 'manual'] as const;
export type Stream = (typeof STREAMS)[number];

/** Session cookie and CSRF header names shared by the web proxy and the engine. */
export const SESSION_COOKIE = 'le_session';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Paid actions ask for confirmation only when the estimate is over $1 or over 10% of what
 * is left of the month's budget (docs/ui.md §1.3); otherwise the estimate is just shown.
 */
export const COST_CONFIRM_USD = 1;
export const COST_CONFIRM_SHARE_OF_REMAINING = 0.1;
export function needsCostConfirm(estimateUsd: number, remainingUsd: number): boolean {
  return (
    estimateUsd > COST_CONFIRM_USD || estimateUsd > COST_CONFIRM_SHARE_OF_REMAINING * remainingUsd
  );
}
