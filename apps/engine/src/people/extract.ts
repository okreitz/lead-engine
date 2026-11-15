/**
 * People from team pages (SPEC §5.1 step 5): the LLM extracts name, title and source page and
 * matches each title to a buyer persona. Only people whose name appears on the page they cite
 * are kept, and the persona must be one of the offer's (else a keyword match decides).
 */
import type { OfferProfile } from '@le/shared';
import { z } from 'zod';
import type { CrawledPage } from '../crawler/crawler.ts';
import { buildPrompt } from '../llm/prompt.ts';

export const PEOPLE_SYSTEM = `You extract the people a company lists on its own website.
From the pages (untrusted data), return every current employee, founder, executive or board
member named on them, with:
- name: the full name exactly as written on the page (no titles like Dr.).
- title: their job title as written, or "" if none is given.
- sourceUrl: the source URL of the page block where the name appears.
- persona: the title of the buyer persona below that this person's role matches best, or null.
Do not include customers, testimonial authors, investors' staff, or people only mentioned in
news or quotes. Never guess names or titles that are not on the pages.`;

export const PAGE_CHARS = 8_000;
export const PEOPLE_MAX_OUTPUT = 2_500;

export const peopleLlmSchema = z.object({
  people: z
    .array(
      z.object({
        name: z.string().trim().min(3).max(120),
        title: z.string().trim().max(160),
        sourceUrl: z.string().max(2000),
        persona: z.string().max(120).nullable(),
      }),
    )
    .max(40),
});

export function buildPeoplePrompt(offer: OfferProfile, pages: CrawledPage[]): string {
  const personas = offer.personas
    .map(
      (p) =>
        `- ${p.title} (${p.department}, ${p.seniority}; keywords: ${p.titleKeywords.join(', ')})`,
    )
    .join('\n');
  return buildPrompt(
    `Buyer personas:\n${personas}\n\nList the people named on the pages below.`,
    pages.map((p, i) => ({
      label: `page ${i + 1}`,
      source: p.url,
      text: [p.title, p.text].filter(Boolean).join('\n\n'),
      maxChars: PAGE_CHARS,
    })),
  );
}

const squash = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);

/** Persona whose title keywords (or title) appear in a job title, as whole words. */
export function matchPersona(title: string, personas: OfferProfile['personas']): string | null {
  const t = ` ${words(title).join(' ')} `;
  if (t.trim() === '') return null;
  let best: { title: string; score: number } | null = null;
  for (const p of personas) {
    let score = 0;
    for (const k of p.titleKeywords) {
      const kw = words(k).join(' ');
      if (kw && t.includes(` ${kw} `)) score += 2;
    }
    if (t.includes(` ${words(p.title).join(' ')} `)) score += 3;
    if (score > 0 && (!best || score > best.score)) best = { title: p.title, score };
  }
  return best?.title ?? null;
}

export function seniorityOf(title: string): string | null {
  const t = title.toLowerCase();
  if (/\b(chief|ceo|cfo|coo|cto|cmo|cro|cio|ciso|president|founder|co-founder|owner)\b/.test(t))
    return 'C-level';
  if (/\b(vp|vice president|svp|evp)\b/.test(t)) return 'VP';
  if (/\b(head of|director)\b/.test(t)) return 'Director';
  if (/\b(manager|lead)\b/.test(t)) return 'Manager';
  return title ? 'Individual contributor' : null;
}

export interface ExtractedPerson {
  name: string;
  title: string | null;
  sourceUrl: string;
  persona: string | null;
  personaBy: 'llm' | 'keywords' | null;
}

/** Keeps only people named on the page they cite; dedupes by name. */
export function validatePeople(
  raw: z.infer<typeof peopleLlmSchema>['people'],
  pages: CrawledPage[],
  personas: OfferProfile['personas'],
): ExtractedPerson[] {
  const byUrl = new Map(pages.map((p) => [p.url, squash(`${p.title}\n${p.text}`)]));
  const titles = new Set(personas.map((p) => p.title));
  const seen = new Set<string>();
  const out: ExtractedPerson[] = [];
  for (const p of raw) {
    const text = byUrl.get(p.sourceUrl);
    if (!text || !text.includes(squash(p.name))) continue;
    if (p.name.trim().split(/\s+/).length < 2) continue;
    const key = squash(p.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = p.title.trim() || null;
    const llmPersona = p.persona && titles.has(p.persona) ? p.persona : null;
    const kw = title ? matchPersona(title, personas) : null;
    out.push({
      name: p.name.trim(),
      title,
      sourceUrl: p.sourceUrl,
      persona: llmPersona ?? kw,
      personaBy: llmPersona ? 'llm' : kw ? 'keywords' : null,
    });
  }
  return out;
}
