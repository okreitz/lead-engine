/**
 * GitHub issues and discussions (docs/providers.md "GitHub search", checked 2026-11-16).
 * - Issues: REST `GET https://api.github.com/search/issues?q="<phrase>" is:issue created:>=<date>`,
 *   30 searches/minute with a token. Quoted phrases still match loosely, so the local prefilter
 *   re-checks every hit.
 * - Discussions: REST rejects `is:discussion`, so GraphQL `search(type: DISCUSSION)` (token
 *   required, 5,000 points/hour, a search costs about 1 point).
 * Both use the workspace's fine-grained token (public repositories, no permissions) through the
 * provider layer: free, counted, paid calls capped at $0. Bot authors are skipped. Issues are
 * never mined for contact details (GitHub Acceptable Use Policies); we link out.
 */
import { USER_AGENT } from '../../crawler/crawler.ts';
import { defaultHttp, readJson, type HttpFetch } from '../../people/http.ts';
import { callProvider, ProviderAuthError, ProviderCallError } from '../../providers/index.ts';
import type { ProviderAdapter } from '../../providers/types.ts';
import { oneLine } from '../text.ts';
import type { PollInput, PollOutput, PollingSource, RawThread } from '../types.ts';

export const GH_ISSUES_URL = 'https://api.github.com/search/issues';
export const GH_GRAPHQL_URL = 'https://api.github.com/graphql';
/** One run of the daily job: issues + discussions per phrase, paced under 30 searches/min. */
export const GH_GAP_MS = 2_500;
export const GH_PER_PAGE = 50;

export interface GhSearchInput {
  kind: 'issues' | 'discussions';
  phrase: string;
  /** YYYY-MM-DD, inclusive. */
  since: string;
}

const isBot = (login: string, type?: unknown) =>
  type === 'Bot' || /\[bot\]$/i.test(login) || /-bot$/i.test(login);

interface GhIssue {
  html_url?: unknown;
  title?: unknown;
  body?: unknown;
  created_at?: unknown;
  repository_url?: unknown;
  pull_request?: unknown;
  state?: unknown;
  comments?: unknown;
  user?: { login?: unknown; type?: unknown };
}

export function parseGithubIssues(json: unknown): RawThread[] {
  const items = (json as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: RawThread[] = [];
  for (const it of items as GhIssue[]) {
    const url = typeof it.html_url === 'string' ? it.html_url : '';
    const created = typeof it.created_at === 'string' ? Date.parse(it.created_at) : NaN;
    const login = typeof it.user?.login === 'string' ? it.user.login : '';
    if (!url.startsWith('https://github.com/') || !Number.isFinite(created) || it.pull_request)
      continue;
    if (isBot(login, it.user?.type)) continue;
    const repo =
      typeof it.repository_url === 'string'
        ? it.repository_url.replace('https://api.github.com/repos/', '')
        : null;
    out.push({
      source: 'github',
      externalId: url,
      url,
      title: oneLine(typeof it.title === 'string' ? it.title : '', 300) || '(untitled)',
      text: typeof it.body === 'string' ? it.body : '',
      author: login || null,
      postedAt: created,
      meta: {
        kind: 'issue',
        ...(repo ? { repo } : {}),
        ...(typeof it.state === 'string' ? { state: it.state } : {}),
        ...(typeof it.comments === 'number' ? { comments: it.comments } : {}),
      },
    });
  }
  return out;
}

interface GhDiscussion {
  url?: unknown;
  title?: unknown;
  bodyText?: unknown;
  createdAt?: unknown;
  author?: { login?: unknown; __typename?: unknown } | null;
  repository?: { nameWithOwner?: unknown };
  isAnswered?: unknown;
}

export function parseGithubDiscussions(json: unknown): RawThread[] {
  const nodes = (json as { data?: { search?: { nodes?: unknown } } })?.data?.search?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: RawThread[] = [];
  for (const d of nodes as GhDiscussion[]) {
    const url = typeof d?.url === 'string' ? d.url : '';
    const created = typeof d?.createdAt === 'string' ? Date.parse(d.createdAt) : NaN;
    if (!url.startsWith('https://github.com/') || !Number.isFinite(created)) continue;
    const login = typeof d.author?.login === 'string' ? d.author.login : '';
    if (isBot(login, d.author?.__typename)) continue;
    out.push({
      source: 'github',
      externalId: url,
      url,
      title: oneLine(typeof d.title === 'string' ? d.title : '', 300) || '(untitled)',
      text: typeof d.bodyText === 'string' ? d.bodyText : '',
      author: login || null,
      postedAt: created,
      meta: {
        kind: 'discussion',
        ...(typeof d.repository?.nameWithOwner === 'string'
          ? { repo: d.repository.nameWithOwner }
          : {}),
        ...(typeof d.isAnswered === 'boolean' ? { answered: d.isAnswered } : {}),
      },
    });
  }
  return out;
}

export const GH_DISCUSSION_QUERY = `query($q: String!, $n: Int!) {
  search(query: $q, type: DISCUSSION, first: $n) {
    nodes { ... on Discussion { url title bodyText createdAt isAnswered
      author { login __typename } repository { nameWithOwner } } }
  }
}`;

/** `"<phrase>"` with quotes stripped from inside; GitHub limits queries to 256 characters. */
export function ghQuery(phrase: string, since: string, kind: 'issues' | 'discussions'): string {
  const p = phrase.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  return `"${p}"${kind === 'issues' ? ' is:issue' : ''} created:>=${since}`;
}

export function githubAdapter(http: HttpFetch): ProviderAdapter<GhSearchInput, RawThread[]> {
  return {
    provider: 'github',
    operation: 'threadSearch',
    keyProvider: 'github',
    cacheTtlMs: 0,
    // Free API, rate limited per minute; counted so the ledger shows the calls.
    freeQuota: { limit: 5_000, period: 'day' },
    maxPaidUsdPerMonth: 0,
    estimateUsd: () => 0.0001,
    async call(input, { apiKey }) {
      const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${apiKey}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT,
      };
      const q = ghQuery(input.phrase, input.since, input.kind);
      const res =
        input.kind === 'issues'
          ? await http(
              `${GH_ISSUES_URL}?${new URLSearchParams({ q, sort: 'created', order: 'desc', per_page: String(GH_PER_PAGE) })}`,
              { headers, timeoutMs: 20_000 },
            )
          : await http(GH_GRAPHQL_URL, {
              method: 'POST',
              headers: { ...headers, 'content-type': 'application/json' },
              body: JSON.stringify({
                query: GH_DISCUSSION_QUERY,
                variables: { q, n: GH_PER_PAGE },
              }),
              timeoutMs: 20_000,
            });
      if (res.status === 401) throw new ProviderAuthError('GitHub rejected the token');
      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get('x-ratelimit-remaining');
        throw new ProviderCallError(
          remaining === '0'
            ? 'GitHub rate limit reached'
            : `GitHub refused the request (${res.status})`,
          null,
          false,
        );
      }
      if (res.status !== 200) throw new ProviderCallError(`GitHub HTTP ${res.status}`);
      const json = await readJson(res, 10_000_000);
      const errors = (json as { errors?: { message?: string }[] } | null)?.errors;
      if (input.kind === 'discussions' && errors?.length) {
        throw new ProviderCallError(
          `GitHub GraphQL: ${String(errors[0]?.message ?? 'error').slice(0, 120)}`,
        );
      }
      return {
        value: input.kind === 'issues' ? parseGithubIssues(json) : parseGithubDiscussions(json),
        usd: 0,
        units: 1,
        confident: true,
        meta: { kind: input.kind },
      };
    },
  };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const githubSource: PollingSource = {
  id: 'github',
  async poll(input: PollInput): Promise<PollOutput> {
    const { ctx } = input;
    const adapter = githubAdapter(ctx.http ?? defaultHttp);
    // The daily run covers yesterday and today (UTC dates); duplicates drop by URL.
    const since = day(ctx.now() - 86_400_000);
    const kinds = ['issues', 'discussions'] as const;
    let index = typeof input.cursor.index === 'number' ? input.cursor.index : 0;
    const total = input.phrases.length * kinds.length;
    const items: RawThread[] = [];
    let calls = 0;
    while (index < total) {
      if (calls > 0 && ctx.now() >= input.deadline) break;
      const phrase = input.phrases[Math.floor(index / kinds.length)]!.phrase;
      const kind = kinds[index % kinds.length]!;
      if (calls > 0) await input.sleep(GH_GAP_MS);
      const res = await callProvider(
        ctx,
        adapter,
        { kind, phrase, since },
        {
          workspaceId: input.workspaceId,
          stream: 'conversations',
          ...(input.jobId ? { jobId: input.jobId } : {}),
        },
      );
      calls++;
      if (res.status === 'ok') items.push(...res.value);
      index++;
    }
    const done = index >= total;
    return { items, cursor: { index: done ? 0 : index }, done, calls };
  },
};
