/**
 * Readable text from HTML without a DOM (keeps idle memory low; no jsdom or Chromium).
 * Good enough for LLM input: title, meta description, visible text and links.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export interface ExtractedPage {
  title: string;
  description: string;
  text: string;
  links: { href: string; text: string }[];
}

export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const description = decodeEntities(
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ??
      /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html)?.[1] ??
      '',
  ).trim();

  const links: { href: string; text: string }[] = [];
  for (const m of html.matchAll(
    /<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    try {
      const href = new URL(decodeEntities(m[1]!), baseUrl);
      if (href.protocol !== 'http:' && href.protocol !== 'https:') continue;
      href.hash = '';
      links.push({ href: href.toString(), text: stripTags(m[2]!).slice(0, 100) });
    } catch {
      // ignore malformed URLs
    }
    if (links.length >= 500) break;
  }

  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(
      /<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi,
      '\n',
    );
  const text = stripTags(body)
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { title, description, text, links };
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const KEY_PATHS: [RegExp, number][] = [
  [/pric|plans/, 10],
  [/product|platform|features?|how-it-works/, 8],
  [/solutions?|use-cases?|industr/, 7],
  [/customers?|case-stud|testimonials|success/, 6],
  [/about|company|who-we-are/, 5],
  [/integrations?/, 3],
];
const SKIP =
  /\/(blog|news|press|careers|jobs|login|signin|sign-in|signup|sign-up|register|legal|privacy|terms|cookie|status|docs?|support|help|cdn-cgi)\b|\.(pdf|png|jpe?g|gif|svg|zip|xml)$/i;

/** Up to `max` same-site pages most likely to describe the offer (SPEC §4.1 step 2). */
export function selectKeyPages(homeUrl: string, links: { href: string }[], max = 5): string[] {
  const home = new URL(homeUrl);
  const site = home.hostname.replace(/^www\./, '');
  const scored = new Map<string, number>();
  for (const { href } of links) {
    const u = new URL(href);
    if (u.hostname.replace(/^www\./, '') !== site) continue;
    u.search = '';
    const path = u.pathname.toLowerCase();
    if (path === '/' || path === home.pathname || SKIP.test(path)) continue;
    if (path.split('/').filter(Boolean).length > 2) continue; // deep pages are rarely key pages
    let score = 0;
    for (const [re, w] of KEY_PATHS) if (re.test(path)) score = Math.max(score, w);
    if (score > 0) scored.set(u.toString(), Math.max(scored.get(u.toString()) ?? 0, score));
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, max)
    .map(([u]) => u);
}
