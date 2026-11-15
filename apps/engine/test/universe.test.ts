import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { companies, jobs, universeImports } from '../src/db/schema.ts';
import { jobHandlers } from '../src/jobs/handlers.ts';
import { JobRunner } from '../src/jobs/queue.ts';
import type { DownloadFetch } from '../src/universe/files.ts';
import { closeCursor, LIMITS } from '../src/universe/import.ts';
import { domainFromWebsite, icpDropReason, nameKey, stateCode } from '../src/universe/normalize.ts';
import { csvRows, jsonArrayRows, readRecords } from '../src/universe/records.ts';
import { makeCtx, setupClient } from './helpers.ts';
import { approveOffer } from './offer-fixtures.ts';

async function* chunked(text: string, size = 7): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('streaming record readers', () => {
  it('parses CSV with quotes, doubled quotes, embedded newlines and CRLF across chunks', async () => {
    const rows = await collect(
      csvRows(chunked('a,b,c\r\n"x, y","he said ""hi""","multi\nline"\r\n1,,3\n'), ','),
    );
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'he said "hi"', 'multi\nline'],
      ['1', '', '3'],
    ]);
  });

  it('detects pipe-delimited CSV and JSON lines by their first line', async () => {
    const pipe = await collect(readRecords(chunked('Name|Website\nAcme|acme.com\n')));
    expect(pipe).toEqual([{ name: 'Acme', website: 'acme.com' }]);
    const jsonl = await collect(readRecords(chunked('{"name":"A"}\n\nnot json\n{"name":"B"}')));
    expect(jsonl).toEqual([{ name: 'A' }, { __invalid: true }, { name: 'B' }]);
  });

  it('reads EDGAR fields/data rows one at a time', async () => {
    const doc = JSON.stringify({
      fields: ['cik', 'name', 'ticker', 'exchange'],
      data: [
        [320193, 'Apple Inc.', 'AAPL', 'Nasdaq'],
        [1, 'Odd "Name" [x]', 'ODD', null],
      ],
    });
    const rows = await collect(jsonArrayRows(chunked(doc, 3)));
    expect(rows).toEqual([
      { cik: 320193, name: 'Apple Inc.', ticker: 'AAPL', exchange: 'Nasdaq' },
      { cik: 1, name: 'Odd "Name" [x]', ticker: 'ODD', exchange: null },
    ]);
  });
});

describe('normalisers', () => {
  it('turns websites into domains and refuses blocked or invalid ones', () => {
    expect(domainFromWebsite('https://www.Acme.com/about?x=1')).toBe('acme.com');
    expect(domainFromWebsite('acme.io')).toBe('acme.io');
    expect(domainFromWebsite('linkedin.com/company/acme')).toBeNull();
    expect(domainFromWebsite('not a site')).toBeNull();
    expect(domainFromWebsite('')).toBeNull();
  });
  it('maps state names and builds name keys', () => {
    expect(stateCode('texas')).toBe('TX');
    expect(stateCode('New York')).toBe('NY');
    expect(stateCode('TX')).toBe('TX');
    expect(stateCode('bavaria')).toBeNull();
    expect(nameKey('Apple Inc.')).toBe('apple');
    expect(nameKey('The Acme Co., LLC')).toBe('acme');
    expect(nameKey('AT&T INC.')).toBe('at and t');
    expect(nameKey('Tesla, Inc. /DE/')).toBe('tesla');
  });
  it('prefilters rows on the ICP leniently (unknown values pass)', () => {
    const f = {
      industries: ['logistics'],
      employeeRange: '51-500',
      states: ['TX'],
      exclude: ['government'],
    };
    const row = {
      domain: 'a.com',
      name: 'A',
      state: 'TX',
      city: null,
      industry: 'logistics and supply chain',
      naics: null,
      sizeRange: '51-200',
      foundedYear: null,
    };
    expect(icpDropReason(row, f)).toBeNull();
    expect(icpDropReason({ ...row, state: null, sizeRange: null }, f)).toBeNull();
    expect(icpDropReason({ ...row, state: 'CA' }, f)).toBe('icp');
    expect(icpDropReason({ ...row, sizeRange: '1-10' }, f)).toBe('icp');
    expect(icpDropReason({ ...row, industry: 'banking' }, f)).toBe('icp');
    expect(icpDropReason({ ...row, industry: 'government administration' }, f)).toBe('icp');
  });
});

// ---------------------------------------------------------------- the import job

const PDL_HEADER = 'name,website,country,region,locality,industry,size,founded,linkedin_url,id';
function pdlCsv(n: number): string {
  const lines = [PDL_HEADER];
  for (let i = 0; i < n; i++) {
    const state = ['texas', 'california', 'new york'][i % 3];
    const industry = i % 4 === 0 ? 'banking' : 'logistics and supply chain';
    lines.push(
      `"Co ${i}, Inc.",https://www.co${i}.com,united states,${state},city${i},${industry},51-200,${1990 + (i % 30)},linkedin.com/company/co${i},li${i}`,
    );
  }
  // Rows that must be dropped
  lines.push('Euro GmbH,euro.de,germany,bavaria,munich,logistics,51-200,2001,,x');
  lines.push('No Site LLC,,united states,texas,austin,logistics,51-200,2001,,x');
  lines.push(
    'Bad Site,linkedin.com/company/bad,united states,texas,austin,logistics,51-200,2001,,x',
  );
  return lines.join('\n') + '\n';
}

function zipOf(name: string, content: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from(content), name);
    zip.addBuffer(Buffer.from('readme'), 'README.txt');
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

/** Serves one file with Range support in 4 KB chunks; each chunk advances the clock 1 s. */
function fileServer(file: Buffer, clock: { t: number }) {
  const requests: { url: string; range: string | undefined; ua: string | undefined }[] = [];
  const fetch: DownloadFetch = async (url, init) => {
    requests.push({ url, range: init.headers.range, ua: init.headers['user-agent'] });
    const m = /bytes=(\d+)-/.exec(init.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    if (start >= file.length) return { status: 416, headers: { get: () => null }, body: null };
    const body = file.subarray(start);
    const headers = new Map<string, string>([
      ['content-length', String(body.length)],
      ['accept-ranges', 'bytes'],
      ...(m
        ? ([['content-range', `bytes ${start}-${file.length - 1}/${file.length}`]] as [
            string,
            string,
          ][])
        : []),
    ]);
    return {
      status: m ? 206 : 200,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      body: (async function* () {
        for (let i = 0; i < body.length; i += 4096) {
          if (init.signal.aborted) return;
          clock.t += 1000;
          yield body.subarray(i, i + 4096);
        }
      })(),
    };
  };
  return { fetch, requests };
}

const dirs: string[] = [];
afterEach(() => {
  LIMITS.sliceMs = 15_000;
  LIMITS.batch = 1_000;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(env: { sec?: boolean } = {}) {
  const importsDir = mkdtempSync(path.join(tmpdir(), 'le-imports-'));
  dirs.push(importsDir);
  const clock = { t: Date.UTC(2026, 10, 15, 12) };
  const ctx = makeCtx(
    { importsDir, secUserAgent: env.sec ? 'LeadEngine test admin@example.com' : null },
    () => clock.t,
  );
  const c = await setupClient(ctx);
  const runner = new JobRunner(ctx, jobHandlers(ctx));
  const drain = async (max = 500) => {
    for (let i = 0; i < max; i++) {
      clock.t += 1;
      if ((await runner.tick()) === 0) return i;
    }
    throw new Error('jobs did not finish');
  };
  return { ctx, c, clock, runner, drain, importsDir };
}

async function approveIcp(c: Awaited<ReturnType<typeof setupClient>>, icp: object) {
  approveOffer(c.ctx, icp);
}

describe('universe import job', () => {
  it('downloads in resumable slices, filters to US + website + ICP, and never stores LinkedIn fields', async () => {
    const { ctx, c, clock, drain } = await setup();
    await approveIcp(c, {
      industries: ['Logistics'],
      states: [],
      employeeRange: '51-500',
      exclude: [],
    });
    const zip = await zipOf('companies.csv', pdlCsv(3000));
    const server = fileServer(zip, clock);
    ctx.download = server.fetch;
    LIMITS.sliceMs = 3_000; // each 4 KB chunk takes 1 s on the fake clock

    const res = await c.send('POST', '/api/v1/universe/imports', {
      source: 'pdl',
      url: 'https://files.example.com/pdl.zip?sig=secret',
    });
    expect(res.status).toBe(201);
    await drain();

    const row = ctx.db.select().from(universeImports).get()!;
    expect(row.error ?? '').toBe('');
    expect(row.state).toBe('done');
    // More than one download slice, each later one a Range request.
    expect(server.requests.length).toBeGreaterThan(1);
    expect(server.requests.slice(1).every((r) => r.range?.startsWith('bytes='))).toBe(true);
    expect(row.bytesDone).toBe(zip.length);
    expect(row.rowsRead).toBe(3003);
    // 3000 rows, a quarter in banking (ICP drop), 3 bad rows.
    expect(row.rowsInserted).toBe(2250);
    expect(row.dropped).toEqual({ icp: 750, not_us: 1, no_website: 2 });

    const co = ctx.db.select().from(companies).where(eq(companies.domain, 'co1.com')).get()!;
    expect(co).toMatchObject({
      name: 'Co 1, Inc.',
      country: 'US',
      state: 'CA',
      city: 'city1',
      sizeRange: '51-200',
      sizeMin: 51,
      sizeMax: 200,
      foundedYear: 1991,
      universe: true,
      nameKey: 'co 1',
      sources: ['pdl'],
    });
    expect(co.origins).toMatchObject({ industry: 'pdl', state: 'pdl', sizeRange: 'pdl' });
    expect(JSON.stringify(co)).not.toMatch(/linkedin|li1\b/);
    // The downloaded file is deleted after a successful import; the signed URL is redacted.
    expect(readdirSync(ctx.config.importsDir)).toEqual([]);
    const list = await c.get('/api/v1/universe');
    expect(list.body.imports[0].url).toBe('https://files.example.com/pdl.zip?…');
    expect(list.body.companies).toBe(2250);
  });

  it('resumes after a restart without rewriting rows, and keeps manual values', async () => {
    const { ctx, c, clock, runner, importsDir } = await setup();
    // A company a person entered by hand keeps its industry.
    await c.send('POST', '/api/v1/accounts', {
      domain: 'co5.com',
      name: 'Five',
      industry: 'Hand-entered',
    });
    writeFileSync(path.join(importsDir, 'pdl.csv.gz'), gzipSync(pdlCsv(5000)));
    const res = await c.send('POST', '/api/v1/universe/imports', {
      source: 'pdl',
      file: 'pdl.csv.gz',
      filter: 'all',
    });
    expect(res.status).toBe(201);
    // One slice writes one batch, then "crash": drop the in-memory cursor.
    LIMITS.sliceMs = 0;
    LIMITS.batch = 700;
    await runner.tick();
    LIMITS.sliceMs = 15_000;
    const mid = ctx.db.select().from(universeImports).get()!;
    expect(mid.state).toBe('processing');
    expect(mid.rowsRead).toBe(700);
    const before = ctx.db.select().from(companies).all().length;
    expect(before).toBe(mid.rowsInserted + 1);
    const job = ctx.db.select().from(jobs).where(eq(jobs.type, 'universe.import')).get()!;
    expect(job.state).toBe('queued');
    expect(job.attempts).toBe(0);
    closeCursor(mid.id);
    new JobRunner(ctx, jobHandlers(ctx)).recover();
    for (let i = 0; i < 50 && (await runner.tick()); i++) clock.t += 1;

    const done = ctx.db.select().from(universeImports).get()!;
    expect(done.state).toBe('done');
    expect(done.rowsRead).toBe(5003);
    expect(done.rowsInserted + done.rowsUpdated).toBe(5000);
    expect(done.rowsUpdated).toBe(1);
    const five = ctx.db.select().from(companies).where(eq(companies.domain, 'co5.com')).get()!;
    expect(five.industry).toBe('Hand-entered');
    expect(five.state).toBe('NY');
    expect(five.origins.industry).toBeUndefined();
    expect(five.origins.state).toBe('pdl');
    expect(five.sources).toEqual(['manual', 'pdl']);
    // Source dots on the account page carry the dataset and its licence.
    const acc = (await c.get('/api/v1/accounts')).body.find((a: any) => a.domain === 'co5.com');
    const detail = await c.get(`/api/v1/accounts/${acc.id}`);
    const state = detail.body.fieldSources.find((f: any) => f.field === 'state');
    expect(state.source).toBe('People Data Labs free company dataset (CC BY 4.0)');
    expect(
      detail.body.fieldSources.find(
        (f: any) => f.field === 'industry' && f.source.includes('People'),
      ),
    ).toBeUndefined();
    // Operator-placed files are kept.
    expect(existsSync(path.join(importsDir, 'pdl.csv.gz'))).toBe(true);
  });

  it('pauses, resumes and cancels from the API (owner only)', async () => {
    const { ctx, c, clock, runner, drain } = await setup();
    const zip = await zipOf('companies.csv', pdlCsv(2000));
    ctx.download = fileServer(zip, clock).fetch;
    LIMITS.sliceMs = 0;
    const { body } = await c.send('POST', '/api/v1/universe/imports', {
      source: 'pdl',
      url: 'https://files.example.com/pdl.zip',
      filter: 'all',
    });
    await runner.tick();
    expect((await c.send('POST', `/api/v1/universe/imports/${body.id}/pause`)).status).toBe(200);
    await drain();
    expect(ctx.db.select().from(universeImports).get()!.state).toBe('paused');
    // Another import can't start while one is active, but a paused one doesn't block.
    LIMITS.sliceMs = 15_000;
    expect((await c.send('POST', `/api/v1/universe/imports/${body.id}/resume`)).status).toBe(200);
    expect(
      (
        await c.send('POST', '/api/v1/universe/imports', {
          source: 'pdl',
          url: 'https://x.com/a.zip',
        })
      ).status,
    ).toBe(409);
    await drain();
    const row = ctx.db.select().from(universeImports).get()!;
    expect(row.state).toBe('done');
    expect(row.rowsInserted).toBe(2000);
    const del = await c.send('DELETE', `/api/v1/universe/imports/${body.id}`);
    expect(del.status).toBe(200);
  });

  it('refuses bad input: ICP filter without an ICP, private URLs, path tricks', async () => {
    const { c } = await setup();
    expect(
      (
        await c.send('POST', '/api/v1/universe/imports', {
          source: 'pdl',
          url: 'https://files.example.com/a.zip',
        })
      ).body.error,
    ).toBe('no_icp');
    expect(
      (
        await c.send('POST', '/api/v1/universe/imports', {
          source: 'pdl',
          url: 'https://127.0.0.1/a.zip',
          filter: 'all',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.send('POST', '/api/v1/universe/imports', {
          source: 'pdl',
          url: 'http://files.example.com/a.zip',
          filter: 'all',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.send('POST', '/api/v1/universe/imports', {
          source: 'pdl',
          file: '../le.db',
          filter: 'all',
        })
      ).body.error,
    ).toBe('invalid_file');
    expect(
      (await c.send('POST', '/api/v1/universe/imports', { source: 'sec-edgar' })).body.error,
    ).toBe('source_unavailable');
  });

  it('tags dataset companies with EDGAR CIKs by unique name, sending the SEC User-Agent', async () => {
    const { ctx, c, clock, drain, importsDir } = await setup({ sec: true });
    writeFileSync(
      path.join(importsDir, 'pdl.csv'),
      [
        PDL_HEADER,
        'apple,apple.com,united states,california,cupertino,consumer electronics,10001+,1976,,',
        'acme,acme.com,united states,texas,austin,logistics,51-200,2001,,',
        'acme,acme.org,united states,ohio,dayton,logistics,51-200,2001,,',
      ].join('\n'),
    );
    await c.send('POST', '/api/v1/universe/imports', {
      source: 'pdl',
      file: 'pdl.csv',
      filter: 'all',
    });
    await drain();
    const doc = JSON.stringify({
      fields: ['cik', 'name', 'ticker', 'exchange'],
      data: [
        [320193, 'Apple Inc.', 'AAPL', 'Nasdaq'],
        [99, 'Acme Corp', 'ACME', 'NYSE'],
        [7, 'Unknown Ltd', 'UNK', 'NYSE'],
      ],
    });
    const server = fileServer(Buffer.from(doc), clock);
    ctx.download = server.fetch;
    const res = await c.send('POST', '/api/v1/universe/imports', { source: 'sec-edgar' });
    expect(res.status).toBe(201);
    await drain();
    expect(server.requests[0]!.url).toBe('https://www.sec.gov/files/company_tickers_exchange.json');
    expect(server.requests[0]!.ua).toBe('LeadEngine test admin@example.com');
    const apple = ctx.db.select().from(companies).where(eq(companies.domain, 'apple.com')).get()!;
    expect(apple).toMatchObject({
      cik: '0000320193',
      ticker: 'AAPL',
      sources: ['pdl', 'sec-edgar'],
    });
    const edgar = ctx.db
      .select()
      .from(universeImports)
      .where(eq(universeImports.source, 'sec-edgar'))
      .get()!;
    expect(edgar.dropped).toEqual({ ambiguous: 1, no_match: 1 });
    expect(edgar.rowsUpdated).toBe(1);
  });
});
