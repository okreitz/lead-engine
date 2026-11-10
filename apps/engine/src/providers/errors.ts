/** A paid call was refused because the workspace budget (or a sub-cap) is used up. */
export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  constructor(
    /** Shown in the UI next to waiting jobs, e.g. "budget reached". */
    public readonly reason: string,
  ) {
    super(reason);
  }
}

/** The provider has no key for this workspace (and no instance fallback). */
export class ProviderKeyMissingError extends Error {
  override name = 'ProviderKeyMissingError';
  constructor(public readonly provider: string) {
    super(`no ${provider} key configured for this workspace`);
  }
}

/**
 * A provider call failed. `usd`/`units` record what it cost anyway (e.g. the claude CLI
 * spends before checking --max-budget-usd), so the ledger stays honest.
 */
export class ProviderCallError extends Error {
  override name = 'ProviderCallError';
  constructor(
    message: string,
    public readonly cost: { usd: number; units: number; estimated?: boolean } | null = null,
    public readonly retryable = true,
  ) {
    super(message);
  }
}
