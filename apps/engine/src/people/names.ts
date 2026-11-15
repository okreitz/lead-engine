/**
 * Person names and email patterns (SPEC §5.1 step 6): learn a domain's pattern from addresses
 * published on its own site, then generate candidate addresses for a person.
 */

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'madam']);
const SUFFIXES = new Set([
  'jr',
  'sr',
  'ii',
  'iii',
  'iv',
  'phd',
  'md',
  'mba',
  'cpa',
  'esq',
  'pe',
  'cfa',
  'jd',
]);

export interface NameParts {
  first: string;
  last: string;
  /** Middle names/initials, ASCII lower case. */
  middle: string[];
}

/** ASCII letters only, lower case: "José-Luis" → "joseluis". */
export function asciiName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/** "Dr. Jane Q. van Doe, PhD" → { first: jane, middle: [q], last: vandoe }. */
export function splitName(full: string): NameParts | null {
  const words = full
    .replace(/\([^)]*\)/g, ' ')
    .split(/[\s,]+/)
    .map((w) => w.replace(/\.$/, ''))
    .filter(Boolean)
    .filter((w) => !HONORIFICS.has(w.toLowerCase().replace(/\./g, '')))
    .filter((w) => !SUFFIXES.has(w.toLowerCase().replace(/\./g, '')));
  if (words.length < 2) return null;
  // Lower-case particles join the last name ("van Doe", "de la Cruz").
  let lastStart = words.length - 1;
  while (lastStart > 1 && /^(van|von|de|der|del|la|le|da|di|du|st)$/i.test(words[lastStart - 1]!))
    lastStart--;
  const first = asciiName(words[0]!);
  const last = asciiName(words.slice(lastStart).join(''));
  const middle = words.slice(1, lastStart).map(asciiName).filter(Boolean);
  if (!first || !last) return null;
  return { first, last, middle };
}

/** Common corporate patterns, most frequent first. */
export const PATTERNS = {
  'first.last': (n: NameParts) => `${n.first}.${n.last}`,
  first: (n: NameParts) => n.first,
  flast: (n: NameParts) => `${n.first[0]}${n.last}`,
  firstlast: (n: NameParts) => `${n.first}${n.last}`,
  'f.last': (n: NameParts) => `${n.first[0]}.${n.last}`,
  first_last: (n: NameParts) => `${n.first}_${n.last}`,
  firstl: (n: NameParts) => `${n.first}${n.last[0]}`,
  last: (n: NameParts) => n.last,
  'last.first': (n: NameParts) => `${n.last}.${n.first}`,
  lastf: (n: NameParts) => `${n.last}${n.first[0]}`,
} as const;
export type PatternId = keyof typeof PATTERNS;
export const PATTERN_IDS = Object.keys(PATTERNS) as PatternId[];

export function emailFor(pattern: PatternId, n: NameParts, domain: string): string {
  return `${PATTERNS[pattern](n)}@${domain}`;
}

/** Candidate addresses in likelihood order (pattern first when known). */
export function permutations(n: NameParts, domain: string, max = 3): string[] {
  return [...new Set(PATTERN_IDS.map((p) => emailFor(p, n, domain)))].slice(0, max);
}

const ROLE =
  /^(info|hello|hi|contact|sales|support|help|team|admin|office|press|media|careers|jobs|hr|billing|marketing|privacy|legal|security|webmaster|noreply|no-reply|enquiries|inquiries|service|customerservice|accounts|investors|ir)$/;

export function isRoleAddress(email: string): boolean {
  return ROLE.test(email.split('@')[0] ?? '');
}

/** Email addresses on a page at the given domain (or its subdomains), lower-cased. */
export function emailsOnPage(text: string, links: { href: string }[], domain: string): string[] {
  const found = new Set<string>();
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const add = (e: string) => {
    const email = e
      .toLowerCase()
      .replace(/^mailto:/, '')
      .split('?')[0]!;
    const d = email.split('@')[1] ?? '';
    if (d === domain || d.endsWith(`.${domain}`)) found.add(email);
  };
  for (const m of text.matchAll(re)) add(m[0]);
  for (const l of links) if (/^mailto:/i.test(l.href)) add(decodeURIComponent(l.href.slice(7)));
  return [...found].slice(0, 100);
}

/**
 * The pattern most published personal addresses follow for the named people, e.g. two
 * addresses matching "first.last" → 'first.last'. Null when nothing matches.
 */
export function learnPattern(
  published: string[],
  people: string[],
): { pattern: PatternId; examples: number } | null {
  const votes = new Map<PatternId, number>();
  const parts = people.map(splitName).filter((n): n is NameParts => n !== null);
  for (const email of published) {
    if (isRoleAddress(email)) continue;
    const local = email.split('@')[0]!;
    for (const n of parts) {
      for (const p of PATTERN_IDS) {
        if (PATTERNS[p](n) === local) votes.set(p, (votes.get(p) ?? 0) + 1);
      }
    }
  }
  const best = [...votes.entries()].sort(
    (a, b) => b[1] - a[1] || PATTERN_IDS.indexOf(a[0]) - PATTERN_IDS.indexOf(b[0]),
  )[0];
  return best ? { pattern: best[0], examples: best[1] } : null;
}

/** A published address that belongs to this person (pattern-independent). */
export function publishedFor(published: string[], n: NameParts): string | null {
  for (const email of published) {
    if (isRoleAddress(email)) continue;
    const local = email.split('@')[0]!.replace(/[^a-z]/g, '');
    if (PATTERN_IDS.some((p) => PATTERNS[p](n).replace(/[^a-z]/g, '') === local)) return email;
  }
  return null;
}
