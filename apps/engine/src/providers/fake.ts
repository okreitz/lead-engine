import type { ProviderAdapter, ProviderResponse } from './types.ts';

export interface FakeEmailInput {
  fullName: string;
  domain: string;
}
export interface FakeEmailOutput {
  email: string | null;
  status: string;
}

/**
 * A provider for tests: no network, programmable results and costs. `calls` records every
 * input that actually reached the "provider".
 */
export function fakeProvider<I = FakeEmailInput, O = FakeEmailOutput>(
  options: {
    provider?: string;
    keyProvider?: string | null;
    costUsd?: number;
    estimateUsd?: number;
    cacheTtlMs?: number;
    freeQuota?: ProviderAdapter<I, O>['freeQuota'];
    maxPaidUsdPerMonth?: number;
    subjects?: ProviderAdapter<I, O>['subjects'];
    respond?: (input: I) => Partial<ProviderResponse<O>> & { value: O };
  } = {},
): ProviderAdapter<I, O> & { calls: I[] } {
  const calls: I[] = [];
  const costUsd = options.costUsd ?? 0.02;
  const adapter: ProviderAdapter<I, O> & { calls: I[] } = {
    calls,
    provider: options.provider ?? 'fake',
    operation: 'test',
    keyProvider: options.keyProvider ?? null,
    cacheTtlMs: options.cacheTtlMs ?? 3600_000,
    ...(options.freeQuota ? { freeQuota: options.freeQuota } : {}),
    ...(options.maxPaidUsdPerMonth !== undefined
      ? { maxPaidUsdPerMonth: options.maxPaidUsdPerMonth }
      : {}),
    subjects:
      options.subjects ??
      ((input: I) => {
        const domain = (input as { domain?: string }).domain;
        return domain ? { domains: [domain] } : {};
      }),
    estimateUsd: () => options.estimateUsd ?? costUsd,
    async call(input) {
      calls.push(input);
      const r = options.respond
        ? options.respond(input)
        : ({ value: { email: 'jane@example.com', status: 'verified' } } as unknown as { value: O });
      return { usd: costUsd, units: 1, confident: true, ...r };
    },
  };
  return adapter;
}
