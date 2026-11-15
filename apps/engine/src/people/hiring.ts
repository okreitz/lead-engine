/**
 * Hiring signal (SPEC §5.1 step 7): public ATS job boards linked from the company's own site
 * (Greenhouse, Lever, Ashby). Roles whose titles match a buyer persona become `hiring`
 * signals with the posting as evidence. No LinkedIn.
 */
import type { OfferProfile } from '@le/shared';
import { readJson, type HttpFetch } from './http.ts';
import { matchPersona } from './extract.ts';

export type Ats = 'greenhouse' | 'lever' | 'ashby';
export interface Board {
  ats: Ats;
  token: string;
}
export interface Job {
  title: string;
  url: string;
  location: string | null;
  postedAt: number | null;
}

const BOARD_RES: [Ats, RegExp][] = [
  [
    'greenhouse',
    /^https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i,
  ],
  ['lever', /^https?:\/\/jobs\.lever\.co\/([a-z0-9_.-]+)/i],
  ['ashby', /^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i],
];

export function detectBoards(links: { href: string }[]): Board[] {
  const out = new Map<string, Board>();
  for (const { href } of links) {
    for (const [ats, re] of BOARD_RES) {
      const token = re.exec(href)?.[1];
      if (token && !['embed', 'api', 'v1'].includes(token.toLowerCase()))
        out.set(`${ats}:${token.toLowerCase()}`, { ats, token });
    }
  }
  return [...out.values()].slice(0, 2);
}

const time = (v: unknown) => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

export async function fetchJobs(http: HttpFetch, board: Board): Promise<Job[]> {
  const t = encodeURIComponent(board.token);
  const url = {
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
    lever: `https://api.lever.co/v0/postings/${t}?mode=json`,
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=false`,
  }[board.ats];
  const res = await http(url, { headers: { accept: 'application/json' } });
  if (res.status !== 200) return [];
  const json = (await readJson(res)) as Record<string, unknown> | unknown[] | null;
  if (board.ats === 'greenhouse') {
    const jobs = ((json as { jobs?: unknown[] } | null)?.jobs ?? []) as {
      title?: string;
      absolute_url?: string;
      location?: { name?: string };
      updated_at?: string;
      first_published?: string;
    }[];
    return jobs.flatMap((j) =>
      j.title && j.absolute_url
        ? [
            {
              title: j.title,
              url: j.absolute_url,
              location: j.location?.name ?? null,
              postedAt: time(j.first_published ?? j.updated_at),
            },
          ]
        : [],
    );
  }
  if (board.ats === 'lever') {
    const jobs = (Array.isArray(json) ? json : []) as {
      text?: string;
      hostedUrl?: string;
      categories?: { location?: string };
      createdAt?: number;
    }[];
    return jobs.flatMap((j) =>
      j.text && j.hostedUrl
        ? [
            {
              title: j.text,
              url: j.hostedUrl,
              location: j.categories?.location ?? null,
              postedAt: time(j.createdAt),
            },
          ]
        : [],
    );
  }
  const jobs = ((json as { jobs?: unknown[] } | null)?.jobs ?? []) as {
    title?: string;
    jobUrl?: string;
    location?: string;
    publishedAt?: string;
    isListed?: boolean;
  }[];
  return jobs.flatMap((j) =>
    j.title && j.jobUrl && j.isListed !== false
      ? [
          {
            title: j.title,
            url: j.jobUrl,
            location: j.location ?? null,
            postedAt: time(j.publishedAt),
          },
        ]
      : [],
  );
}

/** Postings for roles a buyer persona would hold or work with (title keyword match). */
export function matchingJobs(
  jobs: Job[],
  offer: OfferProfile,
  max = 5,
): (Job & { persona: string })[] {
  const out: (Job & { persona: string })[] = [];
  for (const j of jobs) {
    const persona = matchPersona(j.title, offer.personas);
    if (persona) out.push({ ...j, persona });
    if (out.length >= max) break;
  }
  return out;
}
