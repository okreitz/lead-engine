/**
 * ipapi.is IP classification (docs/providers.md "ipapi.is", docs/developers page checked
 * 2026-11-15). One lookup is `POST https://api.ipapi.is` with `{"q": ip, "key": key}`: the key
 * goes in the JSON body so it never appears in a URL or a proxy log.
 *
 * - Each workspace uses its own key (terms §2.9); there is no instance key.
 * - Free tier: 1,000 lookups/day per key. Paid lookups are capped at $0, so the engine stays
 *   on the free tier; when it is used up, visits are counted as "unclassified" until midnight UTC.
 * - Results are cached for 30 days in `ip_lookup_cache` (terms §2.2 allow up to 30 days), per
 *   workspace, and only the fields the pipeline needs are kept.
 * - 403 and 429 back off for an hour: ipapi.is bans clients that keep sending after them.
 */
import { and, eq, gt, lte } from 'drizzle-orm';
import type { AppContext } from '../api/context.ts';
import { ipLookupCache } from '../db/schema.ts';
import { defaultHttp, readJson, type HttpFetch } from '../people/http.ts';
import { ProviderAuthError, ProviderCallError } from './errors.ts';
import { callProvider } from './index.ts';
import type { ProviderAdapter } from './types.ts';

export const IPAPI_URL = 'https://api.ipapi.is';
export const IPAPI_FREE_PER_DAY = 1000;
/** One-time credits: 30,000 lookups per $1 (docs/providers.md). Only used for the estimate. */
export const IPAPI_PAID_USD = 1 / 30_000;
export const IP_CACHE_TTL_MS = 30 * 86_400_000;
const BACKOFF_MS = 3600_000;

/** Organisation types used by `company.type` and `asn.type`. */
export type IpOrgType = 'hosting' | 'isp' | 'education' | 'government' | 'banking' | 'business';

/** The fields we keep from a lookup. No abuse contacts, no coordinates. */
export interface IpInfo {
  country: string | null;
  isVpn: boolean;
  isProxy: boolean;
  isTor: boolean;
  isMobile: boolean;
  isDatacenter: boolean;
  isCrawler: boolean;
  isSatellite: boolean;
  /** iCloud Private Relay and similar egress services. */
  isEgress: boolean;
  companyName: string | null;
  companyDomain: string | null;
  companyType: IpOrgType | null;
  companyNetwork: string | null;
  asn: number | null;
  asnOrg: string | null;
  asnType: IpOrgType | null;
}

const ORG_TYPES = new Set(['hosting', 'isp', 'education', 'government', 'banking', 'business']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function trimIpapi(raw: Record<string, unknown>): IpInfo {
  const company = (raw.company && typeof raw.company === 'object' ? raw.company : {}) as Record<
    string,
    unknown
  >;
  const asn = (raw.asn && typeof raw.asn === 'object' ? raw.asn : {}) as Record<string, unknown>;
  const location = (raw.location && typeof raw.location === 'object' ? raw.location : {}) as Record<
    string,
    unknown
  >;
  const orgType = (v: unknown) => {
    const s = str(v)?.toLowerCase();
    return s && ORG_TYPES.has(s) ? (s as IpOrgType) : null;
  };
  return {
    country: str(location.country_code)?.toUpperCase() ?? null,
    isVpn: raw.is_vpn === true,
    isProxy: raw.is_proxy === true,
    isTor: raw.is_tor === true,
    isMobile: raw.is_mobile === true,
    isDatacenter: raw.is_datacenter === true,
    isCrawler: raw.is_crawler === true || (typeof raw.is_crawler === 'string' && !!raw.is_crawler),
    isSatellite: raw.is_satellite === true,
    isEgress: !!raw.egress_service,
    companyName: str(company.name),
    companyDomain: str(company.domain)?.toLowerCase() ?? null,
    companyType: orgType(company.type),
    companyNetwork: str(company.network),
    asn: typeof asn.asn === 'number' ? asn.asn : null,
    asnOrg: str(asn.org),
    asnType: orgType(asn.type),
  };
}

export function ipapiAdapter(http: HttpFetch): ProviderAdapter<{ ip: string }, IpInfo> {
  return {
    provider: 'ipapi',
    operation: 'ipLookup',
    keyProvider: 'ipapi',
    // Cached in ip_lookup_cache instead (30 days, raw IPs only there).
    cacheTtlMs: 0,
    freeQuota: { limit: IPAPI_FREE_PER_DAY, period: 'day' },
    maxPaidUsdPerMonth: 0,
    estimateUsd: () => IPAPI_PAID_USD,
    async call({ ip }, { apiKey }) {
      const res = await http(IPAPI_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ q: ip, key: apiKey }),
        timeoutMs: 5_000,
      });
      const json = (await readJson(res, 200_000)) as Record<string, unknown> | null;
      const code = json && typeof json.error_code === 'string' ? json.error_code : null;
      if (res.status === 403) {
        throw new ProviderAuthError(
          code === 'ERR_FORBIDDEN_INVALID_API_KEY'
            ? 'ipapi.is rejected the key'
            : 'ipapi.is refused the request (403)',
        );
      }
      if (res.status === 429) throw new ProviderCallError('ipapi.is quota used up', null, false);
      if (res.status !== 200 || !json || code) {
        throw new ProviderCallError(`ipapi.is HTTP ${res.status}${code ? ` ${code}` : ''}`);
      }
      return { value: trimIpapi(json), usd: IPAPI_PAID_USD, units: 1, confident: true };
    },
  };
}

/** Workspaces whose key was refused or exhausted recently: no calls until the time stored. */
const backoff = new Map<string, number>();

export type IpLookup =
  { status: 'ok'; info: IpInfo; cached: boolean } | { status: 'unavailable'; reason: string };

/**
 * Cache → provider pipeline (free quota, $0 paid cap, ledger) → cache. Never throws for
 * provider trouble: the caller counts the visit as unclassified.
 */
export async function lookupIp(
  ctx: AppContext,
  workspaceId: string,
  ip: string,
): Promise<IpLookup> {
  const now = ctx.now();
  const hit = ctx.db
    .select()
    .from(ipLookupCache)
    .where(
      and(
        eq(ipLookupCache.workspaceId, workspaceId),
        eq(ipLookupCache.ip, ip),
        gt(ipLookupCache.expiresAt, now),
      ),
    )
    .get();
  if (hit) return { status: 'ok', info: hit.result as unknown as IpInfo, cached: true };

  const until = backoff.get(workspaceId);
  if (until && until > now) return { status: 'unavailable', reason: 'ipapi.is backing off' };

  try {
    const res = await callProvider(
      ctx,
      ipapiAdapter(ctx.http ?? defaultHttp),
      { ip },
      {
        workspaceId,
        stream: 'visits',
      },
    );
    if (res.status !== 'ok') return { status: 'unavailable', reason: res.reason };
    ctx.db
      .insert(ipLookupCache)
      .values({
        workspaceId,
        ip,
        result: res.value as unknown as Record<string, unknown>,
        fetchedAt: now,
        expiresAt: now + IP_CACHE_TTL_MS,
      })
      .onConflictDoUpdate({
        target: [ipLookupCache.workspaceId, ipLookupCache.ip],
        set: {
          result: res.value as unknown as Record<string, unknown>,
          fetchedAt: now,
          expiresAt: now + IP_CACHE_TTL_MS,
        },
      })
      .run();
    return { status: 'ok', info: res.value, cached: false };
  } catch (err) {
    if (err instanceof ProviderCallError && !err.retryable)
      backoff.set(workspaceId, now + BACKOFF_MS);
    return { status: 'unavailable', reason: (err as Error).message };
  }
}

export function clearIpapiBackoff(workspaceId?: string): void {
  if (workspaceId) backoff.delete(workspaceId);
  else backoff.clear();
}

/** Deletes expired lookups (30-day TTL). */
export function purgeIpLookupCache(ctx: AppContext): number {
  return ctx.db.delete(ipLookupCache).where(lte(ipLookupCache.expiresAt, ctx.now())).run().changes;
}
