/**
 * Real source calls, only with LE_E2E=1 (CLAUDE.md "Testing"). All of them are free: HN needs no
 * key; Stack Exchange, GitHub and Serper run only when their key is in the environment
 * (LE_E2E_SE_KEY, LE_E2E_GITHUB_TOKEN, LE_E2E_SERPER_KEY; Serper uses one free query).
 */
import { describe, expect, it } from 'vitest';
import { defaultHttp } from '../src/people/http.ts';
import { githubAdapter } from '../src/conversations/sources/github.ts';
import { hnSearchUrl, parseHnHits } from '../src/conversations/sources/hn.ts';
import { redditQuery, serperAdapter } from '../src/conversations/sources/reddit.ts';
import { stackexchangeAdapter } from '../src/conversations/sources/stackexchange.ts';

const e2e = !!process.env.LE_E2E;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe.skipIf(!e2e)('stream 2 sources live (LE_E2E=1)', () => {
  it('Hacker News search_by_date', async () => {
    const res = await defaultHttp(hnSearchUrl('crm', Date.now() / 1000 - 7 * 86400), {});
    expect(res.status).toBe(200);
    expect(Array.isArray(parseHnHits(JSON.parse(await res.text())))).toBe(true);
  });

  it.skipIf(!process.env.LE_E2E_SE_KEY)('Stack Exchange with the key as `key=`', async () => {
    const out = await stackexchangeAdapter(defaultHttp).call(
      { q: 'crm', site: 'softwarerecs', fromdate: Date.now() / 1000 - 30 * 86400 },
      { apiKey: process.env.LE_E2E_SE_KEY! },
    );
    expect(out.value.quotaRemaining).toBeGreaterThan(300);
  });

  it.skipIf(!process.env.LE_E2E_GITHUB_TOKEN)('GitHub issues and discussions', async () => {
    const gh = githubAdapter(defaultHttp);
    const env = { apiKey: process.env.LE_E2E_GITHUB_TOKEN! };
    const since = day(Date.now() - 7 * 86400_000);
    await gh.call({ kind: 'issues', phrase: 'crm alternative', since }, env);
    await gh.call({ kind: 'discussions', phrase: 'crm alternative', since }, env);
  });

  it.skipIf(!process.env.LE_E2E_SERPER_KEY)('Serper site:reddit.com (one free query)', async () => {
    const out = await serperAdapter(defaultHttp).call(
      { q: redditQuery(['crm alternative']) },
      { apiKey: process.env.LE_E2E_SERPER_KEY! },
    );
    expect(out.value.every((t) => t.url.includes('reddit.com'))).toBe(true);
  });
});
