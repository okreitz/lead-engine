/**
 * Fixed-window rate limits for the collector (SPEC §10): per client IP and per site. The
 * counters live in memory only and are dropped every window, so no IP outlives a minute here.
 */
export interface RateLimits {
  perIpPerMinute: number;
  perSitePerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { perIpPerMinute: 60, perSitePerMinute: 3000 };

export class RateLimiter {
  private window = 0;
  private ips = new Map<string, number>();
  private sites = new Map<string, number>();

  constructor(
    private readonly limits: RateLimits = DEFAULT_RATE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  private roll(): void {
    const w = Math.floor(this.now() / 60_000);
    if (w !== this.window) {
      this.window = w;
      this.ips = new Map();
      this.sites = new Map();
    }
  }

  /** Counts the request; false when the IP or the site is over its limit. */
  allow(ip: string, siteId: string): boolean {
    this.roll();
    const i = (this.ips.get(ip) ?? 0) + 1;
    this.ips.set(ip, i);
    if (i > this.limits.perIpPerMinute) return false;
    const s = (this.sites.get(siteId) ?? 0) + 1;
    this.sites.set(siteId, s);
    return s <= this.limits.perSitePerMinute;
  }

  /** IP-only check, before the site is known. */
  allowIp(ip: string): boolean {
    this.roll();
    return (this.ips.get(ip) ?? 0) < this.limits.perIpPerMinute * 2;
  }
}
