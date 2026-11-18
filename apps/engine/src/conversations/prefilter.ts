/**
 * Phrase and negative-keyword prefilter (SPEC §5.3 step 1). Runs locally on every post before
 * anything is stored or scored, so most of the Bluesky firehose and loose search hits never
 * reach the LLM.
 *
 * A phrase matches when all its significant words appear within a short window of the text
 * (word order free, simple plural folding), or the whole phrase appears verbatim. A phrase is
 * vetoed when one of its negative keywords appears anywhere in the text.
 */
import type { OfferProfile } from '@le/shared';

type IntentPhrase = OfferProfile['intentPhrases'][number];

const STOP = new Set([
  'a',
  'an',
  'the',
  'for',
  'to',
  'of',
  'in',
  'on',
  'with',
  'and',
  'or',
  'any',
  'is',
  'are',
  'i',
  'we',
  'my',
  'our',
  'me',
  'you',
  'your',
  'it',
  'that',
  'this',
  'be',
  'can',
  'do',
  'does',
]);

function fold(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** Lower-case word tokens with plural folding. `c#`, `c++` and `.net` survive. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/'s\b/g, '')
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean)
    .map(fold);
}

export interface CompiledPhrase {
  phrase: string;
  kind: IntentPhrase['kind'];
  /** All tokens, for the verbatim check. */
  all: string[];
  /** Significant tokens (no stop words), each must appear in the window. */
  words: string[];
  negatives: string[][];
  /** Prefix of the longest word, for a cheap substring pre-check on the firehose. */
  probe: string;
  /** The offer this phrase belongs to (workspaces can have several offers). */
  offerId?: string;
}

export function compilePhrases(phrases: IntentPhrase[], offerId?: string): CompiledPhrase[] {
  const out: CompiledPhrase[] = [];
  for (const p of phrases) {
    const all = tokenize(p.phrase);
    const words = [...new Set(all.filter((t) => !STOP.has(t)))];
    if (!words.length) continue;
    const raw = p.phrase
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((t) => t && !STOP.has(t));
    const probe = raw.sort((a, b) => b.length - a.length)[0] ?? words[0]!;
    out.push({
      phrase: p.phrase,
      kind: p.kind,
      all,
      words,
      negatives: p.negative.map(tokenize).filter((n) => n.length),
      // A prefix survives plurals ("companies" / "company"), so the pre-check never misses.
      probe: probe.slice(0, Math.max(3, probe.length - 3)),
      ...(offerId ? { offerId } : {}),
    });
  }
  return out;
}

function containsSeq(tokens: string[], seq: string[]): boolean {
  if (!seq.length || seq.length > tokens.length) return false;
  outer: for (let i = 0; i <= tokens.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (tokens[i + j] !== seq[j]) continue outer;
    return true;
  }
  return false;
}

/** Smallest window holding every word, or Infinity. */
function minWindow(tokens: string[], words: string[]): number {
  const need = new Set(words);
  if (need.size === 1) return tokens.includes(words[0]!) ? 1 : Infinity;
  const count = new Map<string, number>();
  let have = 0;
  let best = Infinity;
  let left = 0;
  for (let right = 0; right < tokens.length; right++) {
    const t = tokens[right]!;
    if (!need.has(t)) continue;
    count.set(t, (count.get(t) ?? 0) + 1);
    if (count.get(t) === 1) have++;
    while (have === need.size) {
      best = Math.min(best, right - left + 1);
      const l = tokens[left]!;
      if (need.has(l)) {
        count.set(l, count.get(l)! - 1);
        if (count.get(l) === 0) have--;
      }
      left++;
    }
  }
  return best;
}

export interface PhraseMatch {
  phrase: string;
  kind: IntentPhrase['kind'];
  exact: boolean;
  offerId?: string;
}

/** Every approved offer's phrases, each tagged with its offer (prefilter for all offers). */
export function compileOffers(
  offers: { offerId: string; profile: Pick<OfferProfile, 'intentPhrases'> }[],
): CompiledPhrase[] {
  return offers.flatMap((o) => compilePhrases(o.profile.intentPhrases, o.offerId));
}

/**
 * The search queries for all offers: each phrase once (case-insensitive), in offer order, so
 * an offer's phrases keep their place and sources don't search the same text twice.
 */
export function unionPhrases(
  offers: { profile: Pick<OfferProfile, 'intentPhrases'> }[],
): IntentPhrase[] {
  const seen = new Set<string>();
  const out: IntentPhrase[] = [];
  for (const o of offers)
    for (const p of o.profile.intentPhrases) {
      const key = p.phrase.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  return out;
}

/**
 * The best phrase the text matches (verbatim first, then the tightest window), or null.
 * `lowered` may be passed when the caller already has the lower-cased text.
 */
export function matchText(
  compiled: CompiledPhrase[],
  text: string,
  lowered = text.toLowerCase(),
): PhraseMatch | null {
  const candidates = compiled.filter((c) => lowered.includes(c.probe));
  if (!candidates.length) return null;
  const tokens = tokenize(text);
  let best: (PhraseMatch & { span: number }) | null = null;
  const tag = (c: CompiledPhrase) => (c.offerId ? { offerId: c.offerId } : {});
  for (const c of candidates) {
    if (c.negatives.some((n) => containsSeq(tokens, n))) continue;
    if (containsSeq(tokens, c.all)) {
      const m = { phrase: c.phrase, kind: c.kind, exact: true, span: 0, ...tag(c) };
      if (!best || !best.exact) best = m;
      continue;
    }
    const span = minWindow(tokens, c.words);
    if (span <= Math.max(6, c.words.length * 3) && (!best || (!best.exact && span < best.span))) {
      best = { phrase: c.phrase, kind: c.kind, exact: false, span, ...tag(c) };
    }
  }
  if (!best) return null;
  return {
    phrase: best.phrase,
    kind: best.kind,
    exact: best.exact,
    ...(best.offerId ? { offerId: best.offerId } : {}),
  };
}
