import { describe, expect, it } from 'vitest';
import { checkUrl, CrawlError, isBlockedSite, USER_AGENT } from '../src/crawler/crawler.ts';
import { decodeEntities, extractPage, selectKeyPages } from '../src/crawler/extract.ts';
import { isPublicAddress } from '../src/crawler/net-guard.ts';
import { fakeWeb } from './fake-web.ts';

const ROBOTS_OK = { body: 'User-agent: *\nDisallow: /private\n', type: 'text/plain' };

describe('URL checks', () => {
  it('never crawls ToS-protected sites', () => {
    for (const h of [
      'linkedin.com',
      'www.linkedin.com',
      'de.linkedin.com',
      'reddit.com',
      'old.reddit.com',
      'g2.com',
      'www.capterra.com',
      'glassdoor.com',
      'm.facebook.com',
    ]) {
      expect(isBlockedSite(h)).toBe(true);
    }
    expect(isBlockedSite('notlinkedin.com')).toBe(false);
    expect(() => checkUrl('https://www.linkedin.com/company/acme')).toThrow(CrawlError);
  });

  it('refuses non-public targets', () => {
    for (const u of [
      'http://127.0.0.1/',
      'http://localhost:4501/',
      'http://169.254.169.254/latest',
      'http://10.0.0.5',
      'http://[::1]/',
      'http://printer.local',
      'file:///etc/passwd',
      'http://user:pw@acme.com',
    ]) {
      expect(() => checkUrl(u), u).toThrow(CrawlError);
    }
    expect(checkUrl('acme.com').toString()).toBe('https://acme.com/');
  });

  it('classifies addresses', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    for (const ip of [
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.100.1.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '0.0.0.0',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

describe('crawler', () => {
  it('obeys robots.txt and identifies itself', async () => {
    const { crawler, requests } = fakeWeb({
      'https://acme.com/robots.txt': ROBOTS_OK,
      'https://acme.com/': { body: '<title>Acme</title><p>Hello</p>' },
    });
    const page = await crawler.fetchPage('https://acme.com/');
    expect(page.title).toBe('Acme');
    await expect(crawler.fetchPage('https://acme.com/private/x')).rejects.toMatchObject({
      kind: 'robots',
    });
    expect(requests.every((r) => r.ua === USER_AGENT)).toBe(true);
    expect(requests.filter((r) => r.url.endsWith('robots.txt'))).toHaveLength(1); // cached
  });

  it('honours a LeadEngineBot-specific disallow', async () => {
    const { crawler } = fakeWeb({
      'https://acme.com/robots.txt': {
        body: 'User-agent: LeadEngineBot\nDisallow: /\n',
        type: 'text/plain',
      },
      'https://acme.com/': { body: 'x' },
    });
    await expect(crawler.fetchPage('https://acme.com/')).rejects.toMatchObject({ kind: 'robots' });
  });

  it('treats a missing robots.txt as allow and a 5xx as disallow', async () => {
    const missing = fakeWeb({ 'https://a.com/': { body: 'ok' } });
    expect((await missing.crawler.fetchPage('https://a.com/')).text).toBe('ok');
    const broken = fakeWeb({
      'https://b.com/robots.txt': { status: 503 },
      'https://b.com/': { body: 'ok' },
    });
    await expect(broken.crawler.fetchPage('https://b.com/')).rejects.toMatchObject({
      kind: 'robots',
    });
  });

  it('waits 2 s between requests to the same host', async () => {
    const t = 0;
    const { crawler, slept } = fakeWeb(
      {
        'https://acme.com/robots.txt': ROBOTS_OK,
        'https://acme.com/': { body: 'a' },
        'https://acme.com/b': { body: 'b' },
      },
      { now: () => t },
    );
    await crawler.fetchPage('https://acme.com/');
    await crawler.fetchPage('https://acme.com/b');
    expect(slept).toEqual([2000, 4000]); // robots at 0, / at 2 s, /b at 4 s
  });

  it('caps pages at 2 MB and accepts only HTML/text', async () => {
    const { crawler } = fakeWeb({
      'https://acme.com/robots.txt': ROBOTS_OK,
      'https://acme.com/big': { body: 'x'.repeat(2 * 1024 * 1024 + 1) },
      'https://acme.com/file.pdf': { body: '%PDF', type: 'application/pdf' },
    });
    await expect(crawler.fetchPage('https://acme.com/big')).rejects.toMatchObject({ kind: 'size' });
    await expect(crawler.fetchPage('https://acme.com/file.pdf')).rejects.toMatchObject({
      kind: 'type',
    });
  });

  it('re-checks every redirect hop', async () => {
    const { crawler } = fakeWeb({
      'https://acme.com/robots.txt': ROBOTS_OK,
      'https://acme.com/go': { status: 302, location: 'https://www.linkedin.com/company/acme' },
      'https://acme.com/meta': { status: 301, location: 'http://169.254.169.254/latest/meta-data' },
      'https://acme.com/home': { status: 301, location: '/' },
      'https://acme.com/': { body: '<title>Home</title>' },
    });
    await expect(crawler.fetchPage('https://acme.com/go')).rejects.toMatchObject({
      kind: 'blocked',
    });
    await expect(crawler.fetchPage('https://acme.com/meta')).rejects.toMatchObject({
      kind: 'blocked',
    });
    expect((await crawler.fetchPage('https://acme.com/home')).url).toBe('https://acme.com/');
  });
});

describe('extraction', () => {
  it('extracts title, description, text and links, and drops scripts', () => {
    const html = `<html><head><title>Acme &amp; Co</title><meta name="description" content="Rockets for teams"><script>evil()</script></head>
      <body><nav><a href="/pricing">Pricing</a> <a href="https://other.com/x">x</a> <a href="mailto:a@b.c">m</a></nav>
      <h1>Launch faster</h1><p>We build&nbsp;rockets.</p><style>.x{}</style><!-- hidden --></body></html>`;
    const p = extractPage(html, 'https://acme.com/');
    expect(p.title).toBe('Acme & Co');
    expect(p.description).toBe('Rockets for teams');
    expect(p.text).toContain('Launch faster');
    expect(p.text).toContain('We build rockets.');
    expect(p.text).not.toMatch(/evil|\.x\{|hidden/);
    expect(p.links.map((l) => l.href)).toEqual(['https://acme.com/pricing', 'https://other.com/x']);
  });

  it('decodes numeric entities', () => {
    expect(decodeEntities('&#8217;&#x2014;&bogus;')).toBe('’—&bogus;');
  });

  it('picks up to 5 same-site key pages, pricing first', () => {
    const links = [
      '/blog/post-1',
      '/about',
      '/pricing',
      '/product',
      '/customers',
      '/solutions/retail',
      '/login',
      'https://www.acme.com/features',
      'https://other.com/pricing',
      '/careers',
      '/a/b/c/pricing',
      '/integrations',
    ].map((h) => ({ href: new URL(h, 'https://acme.com/').toString() }));
    const picked = selectKeyPages('https://acme.com/', links);
    expect(picked).toHaveLength(5);
    expect(picked[0]).toBe('https://acme.com/pricing');
    expect(picked.join(' ')).not.toMatch(/blog|login|careers|other\.com|a\/b\/c/);
  });
});
