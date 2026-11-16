/**
 * The stream 1 pipeline (SPEC §5.2). A request is held in memory while it runs through:
 *
 *   1. bot check (isbot, and ipapi.is `is_crawler` later)
 *   2. country from the local .mmdb → not US: drop
 *   3. own IpCompany map (most specific prefix) → hit: matched
 *   4. local ASN type → ISP, mobile, hosting: drop; then ipapi.is (free tier, 30-day cache)
 *      → ISP, mobile, hosting, VPN/proxy/Tor/relay: drop
 *   5. company domain: ipapi.is `company.domain`, else PTR (no RDAP)
 *   6. account (firstSource = visits), Visit and Signals; intent pages weigh more
 *   7. a new high-fit account queues the people + email job
 *
 * Nothing is written until every step passed. A dropped request only increments the
 * aggregate daily counter for its outcome. Sessions are counted once per daily session hash,
 * with the hash kept in memory for the day only.
 */
import { isbot } from 'isbot';
import type { AppContext } from '../api/context.ts';
import { sites } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { lookupIp, type IpInfo } from '../providers/ipapi.ts';
import { findSuppression, normalizeDomain } from '../suppression.ts';
import { isValidDomain } from '../crm/accounts.ts';
import { isFreeMail } from '../visits/freemail.ts';
import { domainFromPtr, type PtrLookup } from '../visits/ptr.ts';
import {
  accountForMatch,
  afterMatch,
  countOutcome,
  currentIpMapVersion,
  findIpCompany,
  isRejected,
  recordIdentify,
  recordVisit,
  upsertIpCompany,
  type Match,
  type SiteRow,
} from '../visits/record.ts';
import { SessionHasher, utcDay } from '../visits/session.ts';
import type { VisitOutcome } from '../db/schema.ts';
import { localAsnType } from './asn-types.ts';
import type { GeoDb } from './geo.ts';
import { companyPrefix, hostPrefix, isPrivateOrReserved } from './ip.ts';
import { IDENTIFY_TTL_DAYS } from '@le/shared';

const DAY = 86_400_000;
export const PROVIDER_MATCH_TTL_MS = 30 * DAY;
export const CONFIDENCE = { form: 0.95, provider: 0.8, ptr: 0.5 } as const;

export interface VisitEvent {
  site: SiteRow;
  ip: string;
  userAgent: string;
  path: string;
  referrer: string | null;
  utm: Record<string, string> | null;
}

export interface IdentifyEvent {
  site: SiteRow;
  ip: string;
  userAgent: string;
  emailDomain: string;
}

export interface PipelineDeps {
  ctx: AppContext;
  geo: () => GeoDb | null;
  ptr: PtrLookup;
}

type Classified =
  | { outcome: 'matched'; match: Match }
  | { outcome: Exclude<VisitOutcome, 'matched' | 'rate_limited'> };

interface Memo {
  result: Classified;
  accountId?: string;
}

const MEMO_MAX = 50_000;

export type IdentifyOutcome =
  | 'mapped'
  | 'bot'
  | 'non_us'
  | 'free_mail'
  | 'invalid'
  | 'suppressed'
  | 'not_business'
  | 'unclassified';

export class VisitPipeline {
  private readonly hasher: SessionHasher;
  /** Session hash → result, for today only (in memory; never stored). */
  private memo = new Map<string, Memo>();
  private memoDay = '';
  private memoVersion = currentIpMapVersion();

  constructor(private readonly deps: PipelineDeps) {
    this.hasher = new SessionHasher(deps.ctx.db);
  }

  private get ctx(): AppContext {
    return this.deps.ctx;
  }

  /** Steps 1–5 for one IP. Shared by visits and form identification. */
  private async classify(
    workspaceId: string,
    ip: string,
    userAgent: string,
    opts: { useMap: boolean },
  ): Promise<{ result: Classified; info: IpInfo | null }> {
    const now = this.ctx.now();
    // 1. Bots
    if (!userAgent || isbot(userAgent)) return { result: { outcome: 'bot' }, info: null };
    // 2. Country (fail closed: unknown location is never stored)
    if (isPrivateOrReserved(ip)) return { result: { outcome: 'unclassified' }, info: null };
    const geo = this.deps.geo()?.lookup(ip) ?? null;
    if (!geo?.country) return { result: { outcome: 'unclassified' }, info: null };
    if (geo.country !== 'US') return { result: { outcome: 'non_us' }, info: null };
    // 3. Own IP map
    if (opts.useMap) {
      const row = findIpCompany(this.ctx.db, workspaceId, ip, now);
      if (row?.wrong) return { result: { outcome: 'unmatched' }, info: null };
      if (row) {
        return {
          result: {
            outcome: 'matched',
            match: {
              domain: row.companyDomain,
              companyName: null,
              source: row.source,
              confidence: row.confidence,
              ipCompanyId: row.id,
            },
          },
          info: null,
        };
      }
    }
    // 4. ASN type, then ipapi.is
    const local = localAsnType(geo.asn);
    if (local) return { result: { outcome: local }, info: null };
    const looked = await lookupIp(this.ctx, workspaceId, ip);
    if (looked.status !== 'ok') return { result: { outcome: 'unclassified' }, info: null };
    const info = looked.info;
    if (info.isCrawler) return { result: { outcome: 'bot' }, info };
    if (info.country && info.country !== 'US') return { result: { outcome: 'non_us' }, info };
    if (info.isVpn || info.isProxy || info.isTor || info.isEgress)
      return { result: { outcome: 'vpn' }, info };
    if (info.isMobile) return { result: { outcome: 'mobile' }, info };
    if (info.isDatacenter || info.companyType === 'hosting')
      return { result: { outcome: 'hosting' }, info };
    if (info.isSatellite || info.companyType === 'isp') return { result: { outcome: 'isp' }, info };
    if (!info.companyType && (info.asnType === 'isp' || info.asnType === 'hosting'))
      return { result: { outcome: info.asnType }, info };
    return { result: { outcome: 'unmatched' }, info };
  }

  /** Step 5: company domain for a business IP, written to the IP map. */
  private async resolveDomain(workspaceId: string, ip: string, info: IpInfo): Promise<Classified> {
    const now = this.ctx.now();
    let domain: string | null = null;
    let source: 'provider' | 'ptr' = 'provider';
    const fromProvider = info.companyDomain ? normalizeDomain(info.companyDomain) : null;
    if (fromProvider && isValidDomain(fromProvider)) domain = fromProvider;
    else {
      for (const host of await this.deps.ptr(ip)) {
        const d = domainFromPtr(host, ip);
        if (d && isValidDomain(d)) {
          domain = d;
          source = 'ptr';
          break;
        }
      }
    }
    if (!domain) return { outcome: 'unmatched' };
    if (isRejected(this.ctx.db, workspaceId, ip, domain)) return { outcome: 'unmatched' };
    const row = upsertIpCompany(this.ctx.db, {
      workspaceId,
      prefix: source === 'provider' ? companyPrefix(ip, info.companyNetwork) : hostPrefix(ip),
      domain,
      source,
      confidence: CONFIDENCE[source],
      ttlMs: PROVIDER_MATCH_TTL_MS,
      now,
    });
    if (row.wrong) return { outcome: 'unmatched' };
    return {
      outcome: 'matched',
      match: {
        domain,
        companyName: source === 'provider' ? info.companyName : null,
        source,
        confidence: row.confidence,
        ipCompanyId: row.id,
      },
    };
  }

  private memoFor(day: string): Map<string, Memo> {
    const version = currentIpMapVersion();
    if (day !== this.memoDay || this.memo.size > MEMO_MAX || version !== this.memoVersion) {
      this.memo = new Map();
      this.memoDay = day;
      this.memoVersion = version;
    }
    return this.memo;
  }

  /** Runs one page view through the pipeline. Returns the outcome it was counted under. */
  async processVisit(ev: VisitEvent): Promise<VisitOutcome> {
    const { ctx } = this;
    const workspaceId = ev.site.workspaceId;
    const now = ctx.now();
    const day = utcDay(now);
    const sessionHash = this.hasher.hash(ev.site.id, ev.ip, ev.userAgent, now);
    const memo = this.memoFor(day);
    const seen = memo.get(sessionHash);
    const newSession = !seen;

    let result: Classified;
    if (seen) result = seen.result;
    else {
      const c = await this.classify(workspaceId, ev.ip, ev.userAgent, { useMap: true });
      result =
        c.result.outcome === 'unmatched' && c.info
          ? await this.resolveDomain(workspaceId, ev.ip, c.info)
          : c.result;
      if (result.outcome === 'matched') {
        const hit = findSuppression(ctx.db, workspaceId, { domains: [result.match.domain] });
        if (hit) result = { outcome: 'suppressed' };
      }
    }

    if (result.outcome !== 'matched') {
      memo.set(sessionHash, { result });
      countOutcome(ctx.db, ev.site.id, day, result.outcome, newSession);
      return result.outcome;
    }

    const match = result.match;
    let created = false;
    let accountId = seen?.accountId;
    const outcome = ctx.db.transaction((tx): VisitOutcome => {
      if (!accountId) {
        const acc = accountForMatch(tx, workspaceId, match, now);
        if (acc.status !== 'ok') return acc.status === 'not_us' ? 'non_us' : 'unmatched';
        accountId = acc.accountId;
        created = acc.created;
      }
      recordVisit(tx, {
        site: ev.site,
        accountId,
        match,
        sessionHash,
        path: ev.path,
        referrer: ev.referrer,
        utm: ev.utm,
        now,
      });
      return 'matched';
    });
    if (outcome !== 'matched') {
      memo.set(sessionHash, { result: { outcome: outcome as 'non_us' | 'unmatched' } });
      countOutcome(ctx.db, ev.site.id, day, outcome, newSession);
      return outcome;
    }
    memo.set(sessionHash, { result, accountId: accountId! });
    countOutcome(ctx.db, ev.site.id, day, 'matched', newSession);
    afterMatch(ctx, workspaceId, accountId!, created);
    return 'matched';
  }

  /**
   * `/collect/identify`: the site's form handler reports the email domain a visitor typed.
   * Only a US business IP (never ISP, mobile, hosting or VPN, where a prefix is shared by
   * unrelated people) is mapped, to the company's prefix, with high confidence for 90 days.
   */
  async processIdentify(ev: IdentifyEvent): Promise<IdentifyOutcome> {
    const { ctx } = this;
    const workspaceId = ev.site.workspaceId;
    const now = ctx.now();
    const domain = normalizeDomain(ev.emailDomain);
    if (!isValidDomain(domain)) return 'invalid';
    if (isFreeMail(domain)) return 'free_mail';
    const c = await this.classify(workspaceId, ev.ip, ev.userAgent, { useMap: false });
    if (c.result.outcome === 'bot') return 'bot';
    if (c.result.outcome === 'non_us') return 'non_us';
    if (c.result.outcome === 'unclassified') return 'unclassified';
    if (c.result.outcome !== 'unmatched' || !c.info) return 'not_business';
    if (findSuppression(ctx.db, workspaceId, { domains: [domain] })) return 'suppressed';
    const info = c.info;
    let accountId = '';
    let created = false;
    const ok = ctx.db.transaction((tx) => {
      const row = upsertIpCompany(tx, {
        workspaceId,
        prefix: companyPrefix(ev.ip, info.companyNetwork),
        domain,
        source: 'form',
        confidence: CONFIDENCE.form,
        ttlMs: IDENTIFY_TTL_DAYS * DAY,
        now,
      });
      if (row.wrong) return false;
      const companyName =
        info.companyDomain && normalizeDomain(info.companyDomain) === domain
          ? info.companyName
          : null;
      const acc = accountForMatch(
        tx,
        workspaceId,
        { domain, companyName, source: 'form', confidence: row.confidence, ipCompanyId: row.id },
        now,
      );
      if (acc.status !== 'ok') return false;
      accountId = acc.accountId;
      created = acc.created;
      recordIdentify(tx, { site: ev.site, accountId, domain, ipCompanyId: row.id, now });
      return true;
    });
    if (!ok) return 'invalid';
    // Today's sessions from this IP were classified before the mapping existed.
    this.memo.clear();
    afterMatch(ctx, workspaceId, accountId, created);
    return 'mapped';
  }

  /** Marks the site as receiving events (install check), at most once a minute. */
  touchSite(site: SiteRow): void {
    const now = this.ctx.now();
    if (site.lastEventAt && now - site.lastEventAt < 60_000) return;
    this.ctx.db.update(sites).set({ lastEventAt: now }).where(eq(sites.id, site.id)).run();
  }

  /** Counts a request refused by the rate limiter (no classification, nothing else stored). */
  countRateLimited(site: SiteRow): void {
    countOutcome(this.ctx.db, site.id, utcDay(this.ctx.now()), 'rate_limited', false);
  }
}
