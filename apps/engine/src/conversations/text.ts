/**
 * Text helpers for stream 2. Posts are untrusted data: they are turned into plain text,
 * contact details are redacted before storage or any LLM call (we never harvest contact data
 * from posts, GitHub AUP), and lengths are capped.
 */
import { decodeEntities } from '../crawler/extract.ts';

/** Stored excerpt length; the LLM sees at most `SCORE_TEXT_CHARS` (score.ts). */
export const EXCERPT_CHARS = 1_200;

/** HTML (HN comments, Stack Exchange bodies) → plain text with paragraph breaks. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\s*(br|\/p|p|\/li|\/pre|\/blockquote|\/h\d)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// US-style and international phone numbers with at least 9 digits.
const PHONE = /(?<![\w/])\+?\d[\d ().-]{7,}\d(?![\w/])/g;

/** Removes email addresses and phone numbers. Posts are never a source of contact data. */
export function redactContacts(text: string): string {
  return text.replace(EMAIL, '[email removed]').replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, '');
    // Years, version numbers and IDs are shorter; dates have separators we keep.
    return digits.length >= 9 && digits.length <= 15 ? '[phone removed]' : m;
  });
}

export function excerptOf(text: string, max = EXCERPT_CHARS): string {
  const clean = redactContacts(text.replace(/\s+\n/g, '\n').trim());
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

export function oneLine(text: string, max = 300): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * Canonical thread URL for dedupe (SPEC §5.3 step 2): https, lower-case host without `www.`
 * (and `old.`/`np.` for Reddit), no fragment, no tracking parameters, no trailing slash.
 * HN keeps its `?id=`; everything else drops the query.
 */
export function normalizeThreadUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (/(^|\.)reddit\.com$/.test(host)) host = 'reddit.com';
  const keepQuery = host === 'news.ycombinator.com';
  const id = keepQuery ? u.searchParams.get('id') : null;
  let path = u.pathname.replace(/\/+$/, '') || '/';
  // Reddit: /r/<sub>/comments/<id>[/<slug>] → one URL per post, whatever the slug or case.
  const post = host === 'reddit.com' ? /^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i.exec(path) : null;
  if (post) path = `/r/${post[1]!.toLowerCase()}/comments/${post[2]!.toLowerCase()}`;
  return `https://${host}${path === '/' ? '' : path}${id ? `?id=${id}` : ''}`;
}
