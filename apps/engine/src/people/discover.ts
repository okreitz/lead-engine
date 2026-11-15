/**
 * Finds a company's team, about and leadership pages (SPEC §5.1 step 5) from its homepage
 * navigation and sitemap, plus its careers page for ATS job boards. Everything goes through
 * the crawler (robots.txt, throttle, SSRF guard, no ToS-protected sites).
 */
import { Crawler, CrawlError, type CrawledPage } from '../crawler/crawler.ts';

const PEOPLE_PATHS: [RegExp, number][] = [
  [/\b(leadership|management|executives?|executive-team|founders?)\b/, 10],
  [/\b(team|our-team|meet-the-team|people|staff|our-people)\b/, 9],
  [/\b(board|board-of-directors|partners)\b/, 6],
  [/\b(about|about-us|who-we-are|company|our-story)\b/, 5],
  [/\b(contact|contact-us)\b/, 2],
];
const SKIP =
  /\/(blog|news|press|posts?|tag|category|careers|jobs|login|signin|signup|legal|privacy|terms|cookie|cdn-cgi|wp-content|wp-json)\b|\.(pdf|png|jpe?g|gif|svg|zip|xml)$/i;

export function sameSite(url: URL, domain: string): boolean {
  const h = url.hostname.replace(/^www\./, '');
  return h === domain || h.endsWith(`.${domain}`);
}

/** Up to `max` same-site pages most likely to list people, best first. */
export function selectPeoplePages(domain: string, urls: string[], max = 3): string[] {
  const scored = new Map<string, number>();
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (!sameSite(u, domain)) continue;
    u.search = '';
    u.hash = '';
    const path = u.pathname.toLowerCase().replace(/\/$/, '');
    if (!path || SKIP.test(path)) continue;
    const depth = path.split('/').filter(Boolean).length;
    if (depth > 3) continue;
    let score = 0;
    for (const [re, w] of PEOPLE_PATHS) if (re.test(path)) score = Math.max(score, w);
    if (score > 0) {
      const key = u.toString().replace(/\/$/, '');
      scored.set(key, Math.max(scored.get(key) ?? 0, score - depth * 0.1));
    }
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, max)
    .map(([u]) => u);
}

export function careersPage(domain: string, links: { href: string }[]): string | null {
  for (const { href } of links) {
    try {
      const u = new URL(href);
      if (sameSite(u, domain) && /\/(careers|jobs|join-us|work-with-us)\/?$/i.test(u.pathname))
        return u.toString();
    } catch {
      // ignore
    }
  }
  return null;
}

/** `<loc>` URLs from a sitemap or sitemap index (one level of children, capped). */
export async function sitemapUrls(
  crawler: Crawler,
  domain: string,
  cap = 2_000,
): Promise<string[]> {
  const locs = (xml: string) =>
    [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, '&'));
  try {
    const root = await crawler.fetchXml(`https://${domain}/sitemap.xml`);
    if (!/<sitemapindex/i.test(root.body)) return locs(root.body).slice(0, cap);
    const children = locs(root.body)
      .filter((u) => {
        try {
          return sameSite(new URL(u), domain);
        } catch {
          return false;
        }
      })
      .sort((a, b) => Number(/page/i.test(b)) - Number(/page/i.test(a)))
      .slice(0, 2);
    const out: string[] = [];
    for (const child of children) {
      try {
        out.push(...locs((await crawler.fetchXml(child)).body));
      } catch (err) {
        if (!(err instanceof CrawlError)) throw err;
      }
      if (out.length >= cap) break;
    }
    return out.slice(0, cap);
  } catch (err) {
    if (err instanceof CrawlError) return [];
    throw err;
  }
}

export interface Discovered {
  home: CrawledPage;
  pages: CrawledPage[];
  careers: CrawledPage | null;
}

/** Homepage, up to 3 people pages and the careers page. Throws if the homepage fails. */
export async function discoverPages(crawler: Crawler, domain: string): Promise<Discovered> {
  const home = await crawler.fetchPage(`https://${domain}/`);
  const fromSitemap = await sitemapUrls(crawler, domain);
  const chosen = selectPeoplePages(domain, [...home.links.map((l) => l.href), ...fromSitemap]);
  const pages: CrawledPage[] = [];
  for (const url of chosen) {
    try {
      pages.push(await crawler.fetchPage(url));
    } catch (err) {
      if (!(err instanceof CrawlError)) throw err;
    }
  }
  let careers: CrawledPage | null = null;
  const careersUrl = careersPage(domain, home.links);
  if (careersUrl) {
    try {
      careers = await crawler.fetchPage(careersUrl);
    } catch (err) {
      if (!(err instanceof CrawlError)) throw err;
    }
  }
  return { home, pages, careers };
}
