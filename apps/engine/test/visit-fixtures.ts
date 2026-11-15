/**
 * Fixtures for stream 1: a fake country/ASN database, a fake ipapi.is and fake PTR records,
 * keyed by fixture IPs. Nothing here touches the network.
 */
import type { AppContext } from '../src/api/context.ts';
import { FakeGeo } from '../src/collector/geo.ts';
import { VisitPipeline } from '../src/collector/pipeline.ts';
import { encryptSecret } from '../src/crypto/secrets.ts';
import { providerKeys, sites, users } from '../src/db/schema.ts';
import { createWorkspace } from '../src/workspaces.ts';
import { clearIpapiBackoff } from '../src/providers/ipapi.ts';
import { fakeHttp } from './fake-http.ts';

export const UA = {
  chrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  curl: 'curl/8.5.0',
};

/** Fixture IPs. Each one exercises one branch of the pipeline. */
export const IP = {
  /** US office, ipapi.is business with company.domain. */
  business: '12.1.1.10',
  /** Same company /24, a colleague. */
  businessColleague: '12.1.1.77',
  /** US business, no company.domain, PTR names the company's own host. */
  businessPtr: '12.2.2.20',
  /** US business, ISP-generated PTR: unmatched. */
  businessGeneratedPtr: '12.2.2.21',
  /** US business with a domain whose company is suppressed. */
  businessSuppressed: '12.3.3.30',
  /** Non-US (GB). */
  nonUs: '81.2.69.142',
  /** Non-US IPv6 (DE). */
  nonUsV6: '2a02:2e0::1',
  /** US, Comcast ASN: dropped locally as ISP, no ipapi.is call. */
  ispLocal: '73.162.1.1',
  /** US, unknown ASN, ipapi.is says company type isp. */
  ispProvider: '24.4.4.4',
  /** US, T-Mobile ASN: dropped locally as mobile. */
  mobileLocal: '172.58.1.1',
  /** US, ipapi.is is_mobile. */
  mobileProvider: '24.5.5.5',
  /** US, AWS ASN: dropped locally as hosting. */
  hostingLocal: '3.5.140.2',
  /** US, ipapi.is is_datacenter. */
  hostingProvider: '24.6.6.6',
  /** US, ipapi.is is_vpn. */
  vpn: '24.7.7.7',
  /** US, ipapi.is is_crawler. */
  crawler: '24.8.8.8',
  /** US, ipapi.is iCloud Private Relay egress. */
  relay: '24.9.9.9',
  /** US business on a residential-looking ISP block, used for identify. */
  homeIsp: '73.162.9.9',
  /** No country in the database. */
  unknownGeo: '45.1.1.1',
  /** US IPv6 office. */
  businessV6: '2600:1f00:1:2::10',
} as const;

const geoRow = (
  prefix: string,
  country: string | null,
  asn: number | null,
  asOrg: string | null = null,
) => ({ match: (ip: string) => ip.startsWith(prefix), country, asn, asOrg, asDomain: null });

export const fixtureGeo = new FakeGeo([
  geoRow('12.', 'US', 7018, 'AT&T Services'),
  geoRow('81.2.69.', 'GB', 20712, 'Andrews & Arnold'),
  geoRow('2a02:2e0:', 'DE', 12306, 'Plus.line'),
  geoRow('73.162.', 'US', 7922, 'Comcast Cable'),
  geoRow('24.', 'US', 64500, 'Example Networks'),
  geoRow('172.58.', 'US', 21928, 'T-Mobile USA'),
  geoRow('3.5.', 'US', 16509, 'Amazon.com'),
  geoRow('2600:1f00:', 'US', 64501, 'Example v6'),
  geoRow('45.1.', null, null),
]);

function ipapiBody(ip: string, over: Record<string, unknown> = {}) {
  return {
    ip,
    is_bogon: false,
    is_mobile: false,
    is_satellite: false,
    is_crawler: false,
    is_datacenter: false,
    is_tor: false,
    is_proxy: false,
    is_vpn: false,
    is_abuser: false,
    company: null,
    asn: { asn: 64500, org: 'Example Networks', type: 'isp', route: `${ip}/24` },
    location: { country_code: 'US', state: 'California', city: 'San Jose' },
    abuse: { email: 'abuse@example.net' },
    ...over,
  };
}

const business = (domain: string | null, name: string, network: string) => ({
  company: { name, domain, type: 'business', network },
  asn: { asn: 7018, org: 'AT&T Services', type: 'isp' },
});

/** ipapi.is answers per fixture IP. The test key is `ipapi-test-key`. */
export const IPAPI_ANSWERS: Record<string, Record<string, unknown>> = {
  [IP.business]: ipapiBody(
    IP.business,
    business('acme-robotics.com', 'Acme Robotics Inc', '12.1.1.0 - 12.1.1.255'),
  ),
  [IP.businessColleague]: ipapiBody(
    IP.businessColleague,
    business('acme-robotics.com', 'Acme Robotics Inc', '12.1.1.0 - 12.1.1.255'),
  ),
  [IP.businessPtr]: ipapiBody(IP.businessPtr, business(null, 'Northwind', '12.2.2.0 - 12.2.2.255')),
  [IP.businessGeneratedPtr]: ipapiBody(
    IP.businessGeneratedPtr,
    business(null, 'Somebody', '12.2.2.0 - 12.2.2.255'),
  ),
  [IP.businessSuppressed]: ipapiBody(
    IP.businessSuppressed,
    business('donotcall.com', 'Do Not Call LLC', '12.3.3.0 - 12.3.3.127'),
  ),
  [IP.ispProvider]: ipapiBody(IP.ispProvider, {
    company: { name: 'Example Cable', domain: 'examplecable.net', type: 'isp' },
  }),
  [IP.mobileProvider]: ipapiBody(IP.mobileProvider, { is_mobile: true }),
  [IP.hostingProvider]: ipapiBody(IP.hostingProvider, {
    is_datacenter: true,
    company: { name: 'Host Co', domain: 'hostco.com', type: 'hosting' },
  }),
  [IP.vpn]: ipapiBody(IP.vpn, {
    is_vpn: true,
    company: { name: 'VPN Inc', domain: 'vpn.example', type: 'business' },
  }),
  [IP.crawler]: ipapiBody(IP.crawler, { is_crawler: 'SomeBot' }),
  [IP.relay]: ipapiBody(IP.relay, {
    egress_service: { name: 'iCloud Private Relay' },
    company: { name: 'Akamai', domain: 'akamai.com', type: 'business' },
  }),
  [IP.homeIsp]: ipapiBody(IP.homeIsp, {
    company: { name: 'Comcast', domain: 'comcast.net', type: 'isp' },
  }),
  [IP.businessV6]: ipapiBody(
    IP.businessV6,
    business('globex.com', 'Globex Corporation', '2600:1f00:1::/48'),
  ),
};

export const PTR: Record<string, string[]> = {
  [IP.businessPtr]: ['mail.northwind-traders.com'],
  [IP.businessGeneratedPtr]: ['static-12-2-2-21.someisp.net'],
};

export function fakeIpapi() {
  return fakeHttp((url, init) => {
    if (!url.startsWith('https://api.ipapi.is')) return undefined;
    const body = JSON.parse(init.body ?? '{}') as { q?: string; key?: string };
    if (body.key !== 'ipapi-test-key')
      return {
        status: 403,
        body: { error: 'invalid key', error_code: 'ERR_FORBIDDEN_INVALID_API_KEY' },
      };
    const answer = IPAPI_ANSWERS[body.q ?? ''];
    return { body: answer ?? ipapiBody(body.q ?? '') };
  });
}

export const SITE_KEY = 'site_testkey_0001';

/** A user, a workspace with an ipapi.is key, and a site for `example-saas.com`. */
export function seedVisits(ctx: AppContext, opts: { ipapiKey?: boolean } = {}) {
  const now = ctx.now();
  ctx.db
    .insert(users)
    .values({ id: 'usr_1', email: 'o@example.com', passwordHash: 'x', createdAt: now })
    .run();
  const workspaceId = ctx.db.transaction((tx) =>
    createWorkspace(tx, { name: 'Acme', ownerUserId: 'usr_1', now }),
  );
  if (opts.ipapiKey !== false) {
    ctx.db
      .insert(providerKeys)
      .values({
        workspaceId,
        provider: 'ipapi',
        encryptedKey: encryptSecret(ctx.config.masterKey, workspaceId, 'ipapi', 'ipapi-test-key'),
        createdAt: now,
      })
      .run();
  }
  ctx.db
    .insert(sites)
    .values({
      id: 'site_1',
      workspaceId,
      domain: 'example-saas.com',
      siteKey: SITE_KEY,
      intentPages: [
        { path: '/pricing', label: 'pricing' },
        { path: '/demo', label: 'demo' },
      ],
      createdAt: now,
    })
    .run();
  const site = ctx.db.select().from(sites).get()!;
  return { workspaceId, site };
}

export function makePipeline(ctx: AppContext) {
  clearIpapiBackoff();
  const ipapi = fakeIpapi();
  ctx.http = ipapi.http;
  const ptrCalls: string[] = [];
  const pipeline = new VisitPipeline({
    ctx,
    geo: () => fixtureGeo,
    ptr: async (ip) => {
      ptrCalls.push(ip);
      return PTR[ip] ?? [];
    },
  });
  return { pipeline, ipapiCalls: ipapi.calls, ptrCalls };
}

/** Every row of every table, as one JSON string (for "the IP is stored nowhere" checks). */
export function dumpDb(ctx: AppContext): Record<string, unknown[]> {
  const tables = ctx.db.$client
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name != '__drizzle_migrations'`,
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map((t) => [t.name, ctx.db.$client.prepare(`SELECT * FROM "${t.name}"`).all()]),
  );
}

/** Row counts of the tables a stored visit would touch. */
export function storedCounts(ctx: AppContext) {
  const dump = dumpDb(ctx);
  return {
    visits: dump.visits!.length,
    accounts: dump.accounts!.length,
    companies: dump.companies!.length,
    signals: dump.signals!.length,
    ipCompanies: dump.ip_companies!.length,
    fieldSources: dump.field_sources!.length,
    jobs: dump.jobs!.length,
  };
}
