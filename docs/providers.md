# Providers: verified endpoints, limits, prices and terms

Checked **2026-11-08** for Phase 0 (SPEC §11). Labels:
- **live**: the endpoint was called from the build container and the response seen.
- **docs**: the vendor's or operator's own page, fetched that day.
- **[unverified]**: not confirmed; says what was tried.

No accounts were created, no keys were used and nothing was spent. Live calls used only free, keyless endpoints. Prices change; recheck them before relying on any figure for a budget decision. None of this is legal advice.

## What this changes (read first)

| # | Finding | Impact | Status |
|---|---|---|---|
| 1 | **ARIN's RDAP/Whois Terms of Use cover RDAP** and forbid use "as part of a commercial service or product" and "for … marketing research". | SPEC §5.2 step 6 ("else RDAP") is not usable for US IPs in a hosted product. | **Decided 2026-11-09:** RDAP dropped; ipapi.is → PTR → own IP map |
| 2 | **Icypeas data is LinkedIn-derived.** Find People returns `linkedin.com/in/…` URLs and Sales Navigator URNs, and the API sells LinkedIn profile/company scrapers. | Find People can't be used. | **Decided 2026-11-09:** email finder and verifier only; LinkedIn-derived fields are never stored (rule narrowed in CLAUDE.md) |
| 3 | **ipapi.is:** keyless calls are now 30/day with a cut-down response. The 1,000/day free tier needs a free key. Data is for internal use only, unless **each user calls with their own key**. | The collector needs a key. **Hosted mode must use a per-workspace (BYO) ipapi.is key**, never a shared instance key. | Decided (fits the BYO-key model) |
| 4 | **netcup blocks outbound SMTP by default** on servers with its firewall enabled (the "netcup Mail block" policy, removable by the customer). | Reacher depends on it. | **Pending: test on the VPS.** Reacher is off by default; the Icypeas verifier is the fallback |
| 5 | **Reacher is now MIT** (since v0.11.9, 2026-10-09). `/v0/check_email` is deprecated; use `/v1/check_email`. `is_reachable` ∈ `safe\|risky\|invalid\|unknown`; catch-all is `smtp.is_catch_all`. | The sidecar raises no licence issue. SPEC §5.1 step 6.3 labels need a mapping (below). | Decided |
| 6 | **Serper's smallest paid pack is $50 for 50k credits** (valid 6 months). There is no pay-as-you-go option. | The first paid search would cost $50, the whole monthly budget. | **Decided:** the Reddit sub-cap defaults to $0; free queries only, never an automatic pack purchase |
| 7 | **SEC EDGAR has no domains:** `website` was `""` for all 6 large caps sampled. | EDGAR gives names, SIC, state and officers, but domains must come from elsewhere (the PDL match). | Note for Phase 2 |
| 8 | **SAM.gov needs a key** even for the public monthly extract. Non-federal users without a role get 10 requests/day. | Optional source: monthly extract only, key in instance config. No contact emails at the Public level. | **Decided:** optional |
| 9 | **Bluesky Jetstream v2** exists, with an official MIT/Apache client `@bsky/jetstream`. | Use v2 + `@bsky/jetstream` instead of `@skyware/jetstream` (MPL-2.0, v1). | Decided |
| 10 | **Syften claims no Reddit licence**; it reads Reddit "from the perspective of a logged-out user". | Not usable as a Reddit source without breaking terms. | **Decided:** removed from the upgrade ladder |
| 11 | **LeadMagic's cheapest plan is $99/mo.** | It's above the whole $50 budget; the §8.4 "per result" wording understates the entry cost. | Note |

### Reacher → `emailStatus` mapping (proposed for SPEC §5.1)
| Reacher result | `Contact.emailStatus` |
|---|---|
| `is_reachable = safe` | `verified` (or `pattern_verified` when the address came from pattern permutation) |
| `is_reachable = risky` and `smtp.is_catch_all = true` | `catch_all` |
| `is_reachable = risky` otherwise | `risky` |
| `is_reachable = invalid` | `invalid` |
| `is_reachable = unknown` | `unknown` |

---

## Stream 1: website visits

### ipapi.is (IP classification and company)
- **Endpoint & auth**
  - Single lookup: `GET https://api.ipapi.is/?q=<ip>&key=<key>`. The key can also go in `api_key` or `apiKey`; no header auth is documented. (docs: https://ipapi.is/developers.html)
  - Bulk: `POST https://api.ipapi.is` with `{"ips":[…],"key":"…"}`, up to 100 IPs. Without a key it returns `ERR_FORBIDDEN_API_KEY_REQUIRED`. (live)
  - **Keyless (since 2026-09-01):** 30 lookups/day per client IP. After that: 429, then a 24 h firewall block. The response is cut down: `company` and `asn` are plain strings, there's no `country_code` and no `is_*` flags. (live + docs: https://ipapi.is/free-tier.html)
- **Fields we need** (keyed response; structure from the docs example, since we hold no key)
  - `location.country_code`
  - `company.name`, `company.domain`, `company.type`, `company.network` (`"a - b"`)
  - `asn.asn`, `asn.org`, `asn.domain`, `asn.type`, `asn.route`
  - Booleans `is_vpn`, `is_proxy`, `is_tor`, `is_datacenter`, `is_mobile` (also `is_bogon`, `is_crawler`, `is_abuser`)
  - `company.type` / `asn.type` ∈ `hosting | isp | education | government | banking | business` (`banking` is new)
  - Keyless live sample:
    ```json
    {"ip":"8.8.8.8","is_bogon":false,"company":"Google LLC","asn":"AS15169 Google LLC","city":"Mountain View",
     "region":"California","country":"United States","lat":37.38605,"lon":-122.08385,
     "timezone":"America/Los_Angeles","docs":"https://ipapi.is/free-tier.html?ref=api"}
    ```
- **Limits & free quota**
  - With a free account and key: **1,000/day**, full response, bulk. No card needed; one account per person or company. (docs: https://ipapi.is/pricing.html)
  - One-time credits: 30,000 requests per $1, never expire, used after the daily free quota.
- **Price** (https://ipapi.is/pricing.html, checked 2026-11-08)
  - API: Basic **$20/mo** (20k/day), Medium $50 (100k/day), Large $100 (500k/day), Business $200 (2M/day).
  - Databases: **IP-to-Company $89/mo**, ASN $49, Hosting $89, VPN $79, Geolocation $59, all databases $200.
  - Matches research.md.
- **Terms** (https://ipapi.is/terms.html, updated 2026-10-03)
  - Caching is allowed "for up to 30 days" (§2.2), so our 30-day `IpLookupCache` fits.
  - Commercial use of the free tier is allowed (§2.9).
  - **But the licence is "for your own internal use only"** (§1.2), with no feeds or APIs "for the benefit of third parties" (§2.3).
  - The exception (§2.9): products where "your own users access the ipapi.is API with their own ipapi.is accounts and API keys". ⇒ Hosted = BYO key per workspace.
  - Rotating keys, accounts or IPs to get around quotas is prohibited (§6).

### RDAP (ARIN and the rdap.org bootstrap)
- **Endpoint & auth**
  - `GET https://rdap.arin.net/registry/ip/<ip>`, no auth. (live)
  - `https://rdap.org/ip/<ip>` returns a 302 to the right registry (ARIN, RIPE, …). (live)
  - For volume, resolve the registry ourselves from IANA's `https://data.iana.org/rdap/ipv4.json` (RFC 9224). (docs: https://about.rdap.org/)
- **Fields** (live)
  - `/ip/<ip>` returned the most specific network (8.8.8.8 → `NET-8-8-8-0-2`, 8.8.8.0/24).
  - Network: `handle`, `name`, `type`, `startAddress`, `endAddress`, `cidr0_cidrs[]`, `parentHandle`.
  - Org name: `entities[]` with `roles:["registrant"]`, `vcardArray[1]` → `["fn",{},"text","Apple Inc."]`, `kind: org`. Entities can be nested.
- **Limits**
  - ARIN publishes no numeric RDAP limit **[unverified]**. Throttle at ≤ 1 request/s and honour 429 / `Retry-After`.
  - rdap.org caps clients at 10 requests per 10 s. (docs)
- **Price:** free.
- **Terms:** every ARIN response carries "By using the ARIN RDAP/Whois service, you are agreeing to the RDAP/Whois Terms of Use" (live). The ToU (https://www.arin.net/resources/registry/whois/tou/, effective 9 April 2014, fetched and quoted) says:
  > "You are specifically prohibited from using the Whois Service (i) as part of a commercial service or product … or (ii) for advertising, direct marketing, marketing research or similar purposes."

  Permitted use is "Internet operational or technical research". The ToU allows "prior written authorization" from ARIN. **⇒ Finding #1.** Decided 2026-11-09: RDAP is not used (`decisions.md`).

### IPinfo Lite (country and ASN database)
- **Endpoint & auth**
  - **A free account token is required.**
  - Download: `https://ipinfo.io/data/ipinfo_lite.mmdb?token=<token>` (follow the redirect; CSV, JSON and Parquet also exist). Without a token it returns **401**. (live)
  - API: `GET https://api.ipinfo.io/lite/<ip>?token=…`, batch `POST https://api.ipinfo.io/batch/lite` (≤ 1,000). Without a token it returns **403**. (live; docs: https://ipinfo.io/developers/lite-api)
- **Fields:** `network, country, country_code, continent, continent_code, asn ("AS15169"), as_name, as_domain`. No company or connection type. (docs + live sample CSV)
- **Limits:** the API has "no daily or monthly limit"; data is updated daily. (docs: https://ipinfo.io/products/free-ip-database)
- **Price:** free (checked 2026-11-08).
- **Terms**
  - **CC BY-SA 4.0.** The FAQ explicitly allows use "within a product", commercial included, with attribution: "IP address data is powered by IPinfo".
  - **ShareAlike:** don't ship the `.mmdb` in the repo or the Docker image; download it at runtime with the user's token.
  - The ToS of the free token account was not reviewed **[unverified]**.

### DB-IP Lite (country and ASN database)
- **Endpoint & auth:** no account.
  - `https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.mmdb.gz`
  - `https://download.db-ip.com/free/dbip-asn-lite-YYYY-MM.mmdb.gz`
  - For 2026-11 both returned 200: country 4.2 MB gz, ASN 5.2 MB gz, last-modified 2026-11-01. (live)
  - The download page publishes MD5/SHA1 checksums; verify them after download.
- **Fields:** country (IP range → ISO alpha-2 country, continent); ASN (IP range → AS number, AS organisation). No AS domain or type. (docs)
- **Limits:** none stated; released **monthly**.
- **Price:** free (checked 2026-11-08; https://db-ip.com/db/download/ip-to-country-lite).
- **Terms:** **CC BY 4.0**, commercial use and redistribution allowed. Attribution is required on pages that "display or use results": `<a href='https://db-ip.com'>IP Geolocation by DB-IP</a>`. The cleanest terms of the free databases, so it is the default country database (`decisions.md`).

### MaxMind GeoLite2 ASN (for comparison, not chosen)
- Needs a free account and licence key; 30 downloads/day. The permalink format was not verified **[unverified]**.
- EULA (updated 2026-02-12, https://www.maxmind.com/en/geolite2/eula):
  - Use is limited to "your own internal business purposes".
  - Disclosure to third parties needs MaxMind's prior written consent.
  - Old copies must be destroyed within 30 days.
- The least suitable for hosting. Not used.

---

## Stream 2: conversation intent

### Hacker News (Algolia)
- **Endpoint & auth:** `GET https://hn.algolia.com/api/v1/search_by_date`, no auth. URL-encode `tags=(story,comment)` and `numericFilters` (raw `(`/`>` gives 400). (live)
- **Request:**
  - `query`
  - `tags=(story,comment)`
  - `numericFilters=created_at_i>UNIX`
  - `hitsPerPage` (≤ 1000)
  - `page`
  - **`typoTolerance=false`**. Live check: `crm` over the last 24 h gave **3,076 hits with typo tolerance vs 2 without**; it matches "com".
  - Re-check the phrase locally anyway.
  - At most 1,000 results per query.
- **Response** (live):
  - Envelope: `hits[]`, `nbHits` (approximate), `nbPages`, `page`.
  - Stories: `objectID`, `title`, `url`, `story_text`, `author`, `created_at_i`.
  - Comments: `objectID`, `comment_text`, `story_id`, `story_title`, `story_url`, `parent_id`, `author`, `created_at_i`.
  - Thread URL: `https://news.ycombinator.com/item?id=<objectID>`.
- **Limits:** 10,000 requests/hour per IP (docs: text in hn.algolia.com/api's own bundle). No rate-limit headers. (live)
- **Price:** $0.
- **Terms:**
  - Credit "Hacker News Search powered by Algolia".
  - YC's site terms forbid scraping news.ycombinator.com and harvesting contact info (https://www.ycombinator.com/legal), so we use the API only.
  - No explicit commercial-use clause was found **[unverified]**.

### Bluesky Jetstream
- **Endpoint & auth:** no auth for the live tail. (docs: https://bsky.network/docs/jetstream/; live)
  - **v2 (use this):** `wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents?collections=app.bsky.feed.post&kinds=commit`, subprotocol `xrpc.v1.json`. us-west is also available. Cursor = `seq`; delivery is at-least-once, so dedupe on the `at://` URI.
  - v1 (legacy, still up): `wss://jetstream{1,2}.us-{east,west}.bsky.network/subscribe?wantedCollections=app.bsky.feed.post`, cursor = `time_us`, `compress=true` (zstd + dictionary, about 56% smaller).
- **Message (v2, live, trimmed):**
  ```json
  {"$type":"message","payload":{"$type":"network.bsky.jetstream.subscribeEvents#commit",
   "did":"did:plc:mse22jsp6kk6peoy65oget3c","seq":26960281119,"operation":"create",
   "collection":"app.bsky.feed.post","rkey":"3mzss4vwlgs26",
   "record":{"$type":"app.bsky.feed.post","createdAt":"2026-11-08T16:06:04.784Z","langs":["en"],"text":"…"}}}
  ```
  Post URL: `https://bsky.app/profile/<did>/post/<rkey>`.
- **Volume:** posts only, about 50 messages/s and about 45 KB/s uncompressed, so about 4 GB/day. (live, 8 s samples) Parse as a stream to stay inside the RSS budget. About 5% of commits are deletes. No published per-client limit **[unverified]**.
- **Client:** `@bsky/jetstream` 1.0.0, licence "MIT OR Apache-2.0", official, v2. (npm) Node 22's global `WebSocket` also works. (live)
- **Price:** $0.
- **Terms** (https://bsky.network/docs/developer-guidelines):
  - No "automated or bulk interactions", which matches our no-auto-reply rule.
  - Honour deletion requests and events.
  - No explicit commercial-use ban, but no explicit permission either **[unverified]**.

### Stack Exchange API
- **Endpoint & auth:** `GET https://api.stackexchange.com/2.3/search/advanced`, gzip responses. The key is optional; register an app at https://stackapps.com/apps/oauth/register. (live/docs)
- **Request:** `q`, `site`, `fromdate`, `sort=creation`, `order=desc`, `pagesize`, `filter=withbody`, `key`.
- **Response** (live):
  - `items[]`: `question_id`, `title`, `link`, `creation_date`, `tags[]`, `owner.display_name`, `owner.link`, `content_license`.
  - Envelope: `has_more`, `quota_max`, `quota_remaining`, `backoff` (only when set).
- **Limits:**
  - **300/day per IP without a key** (live `quota_max: 300`); **10,000/day with a key** by default.
  - More than 30 requests/s per IP gets temporarily banned.
  - **Honour `backoff`.**
  - (docs: https://api.stackexchange.com/docs/throttle)
- **Price:** $0.
- **Terms** (https://stackoverflow.com/legal/api-terms-of-use):
  - Apps must "visually indicate that the Stack Exchange Network is the source".
  - Content is **CC BY-SA 4.0**: link to the question and name the author.
  - The public network ToS restriction on commercial storage explicitly excludes API content.

### GitHub search
- **Endpoint & auth:** `GET https://api.github.com/search/issues?q=…&per_page=100`, `Authorization: Bearer <token>`, `X-GitHub-Api-Version: 2022-11-28`.
- **Query** (live):
  - `is:issue` or `is:pull-request` is required (422 otherwise).
  - **`is:discussion` is rejected by REST (422).** Discussions need GraphQL `search(type: DISCUSSION)` with a token.
  - Spaces mean **AND** now (advanced search is the default). Use `OR` with parentheses.
  - Queries ≤ 256 chars and ≤ 5 operators; ≤ 1,000 results per search.
- **Response:** `total_count`, `incomplete_results`, `items[]`: `html_url`, `title`, `body`, `user.login`, `created_at`, `repository_url`, `state`, `comments`. Filter out `[bot]` authors. (live)
- **Limits:** search allows 30/min authenticated and 10/min unauthenticated. (docs: https://docs.github.com/en/rest/search/search; live header `X-RateLimit-Limit: 30`) GraphQL point costs **[unverified]**.
  - Caveat: the sandbox proxy adds a GitHub credential, so the keyless tests ran authenticated.
- **Price:** $0.
- **Terms** (GitHub Acceptable Use Policies):
  - API collection isn't scraping.
  - Don't use the information for spam, unsolicited email or selling personal info. ⇒ Never extract emails from issues; link out only.

### Serper (Reddit via Google SERP)
- **Endpoint & auth:** `POST https://google.serper.dev/search`, headers `X-API-KEY: <key>` and `Content-Type: application/json`. (docs: the serper.dev playground; no live call, since a key is needed)
- **Request:** `{"q":"site:reddit.com \"<phrase>\"","gl":"us","hl":"en","tbs":"qdr:d","page":1}`.
  - `tbs=qdr:d` is the past 24 h.
  - `num` is effectively 10 for `search`; page with `page`.
- **Response:** `organic[]`: `title`, `link`, `snippet`, `position`, and sometimes `date` (relative text such as "4 months ago": optional, don't parse).
- **Limits & free quota:**
  - **2,500 free queries**, no card. Their expiry is **[unverified]**: it's not on public pages.
  - A Google search costs 1 credit; credits are charged only on successful responses.
  - Starter allows 50 queries/s.
- **Price** (https://serper.dev/, checked 2026-11-08, excl. tax; credits valid 6 months):

  | Pack | Price | Credits | $ / 1k |
  |---|---|---|---|
  | Starter | **$50** | 50,000 | $1.00 |
  | Standard | $375 | 500,000 | $0.75 |
  | Scale | $1,250 | 2.5M | $0.50 |
  | Ultimate | $3,750 | 12.5M | $0.30 |

  research.md's "about $1 per 1,000" is right, but the **minimum purchase is $50** (finding #6).
- **Terms** (https://serper.dev/terms, updated 2024-05-29):
  - B2B; no restriction on commercial use.
  - **No more than one account at a time**, so the hosted service can't open one Serper account per workspace for itself. BYO key per workspace is fine.
  - Don't misrepresent the source. Storing URL + title + snippet and linking out fits.

### Reddit Data API (not used)
- The Data API Terms (https://redditinc.com/policies/data-api-terms, last revised 2026-07-20) require a separate agreement for commercial use. (docs)
- The shutdown dates (RSS ends 2026-11-13, unregistered apps cut from 2027-01-12, public API closes March 2027) are confirmed by several secondary sources (TechRepublic, Decrypt, PPC Land, DigitalApplied).
- Reddit's own announcement is **[unverified]**: reddit.com and reddithelp returned 403 to our fetches.

---

## Stream 3: persona fit

### People Data Labs free company dataset
- **Access:** a form at https://www.peopledatalabs.com/company-dataset (country selector and use case); no key. Downloading also accepts PDL's **Acceptable Data Use Policy**, which was not read **[unverified]**. No official AWS or Kaggle mirror was found.
- **Format & fields:**
  - ZIP of CSV, pipe-delimited or JSON.
  - Exactly 10 fields: `name`, `website`, `country` (`"united states"`), `region`, `locality`, `industry` (LinkedIn's industry enum), `size` (e.g. `11-50`), `founded`, `linkedin_url`, `id` (non-persistent, LinkedIn-derived).
  - No NAICS and no exact headcount. (docs: https://docs.peopledatalabs.com/docs/free-company-dataset)
- **Size & cadence:**
  - "22M+" companies in the docs, "23.8M+" on the download page.
  - "Updated quarterly", but **no release date or file size is published [unverified]**.
- **Licence:** **CC BY 4.0**, "you may use this data for any purpose". No specific attribution wording, so our NOTICE line is in `NOTICE`.
  - `linkedin_url` and `id` are LinkedIn-derived. We don't scrape, but we drop both on import to keep clear of the LinkedIn rule (`decisions.md`).

### SEC EDGAR
- **Endpoint & auth:**
  - No key, but **a declared User-Agent is required.** Live: 403 without one, 200 with `LeadEngine research admin@example.com`.
  - Docs format: `Sample Company Name AdminContact@<domain>.com`. Production reads it from env (`LE_SEC_USER_AGENT`); never hard-code a personal address.
  - Live-tested endpoints:

    | Endpoint | Result |
    |---|---|
    | `https://www.sec.gov/files/company_tickers.json` | 10,419 entries, `{cik_str, ticker, title}` |
    | `https://www.sec.gov/files/company_tickers_exchange.json` | `fields: [cik, name, ticker, exchange]` |
    | `https://data.sec.gov/submissions/CIK##########.json` | 10-digit zero-padded CIK |
    | Bulk `https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip` | about **1.57 GB**, rebuilt nightly about 3 a.m. ET |

- **Fields** (live, Apple):
  - `name`, `sic`, `sicDescription`, `tickers[]`, `exchanges[]`, `ein`, `stateOfIncorporation`, `addresses.business.{city,stateOrCountry,zipCode}`, `filings.recent.{form,accessionNumber,primaryDocument}`.
  - **`website: ""`** for AAPL, MSFT, TSLA, NVDA, WMT and AVGO (finding #7).
- **Officers:**
  - Form 3/4/5 XML `reportingOwner` → `rptOwnerName`, `isOfficer`, `officerTitle` (live, Apple Form 4).
  - Bulk: the quarterly Insider Transactions data sets (`2026q3_form345.zip`, 8.7 MB).
  - Form 4 only covers Section 16 officers and directors; the full exec list is in DEF 14A or 10-K Item 10.
- **Limits:** "max request rate: **10 requests/second**" (docs: https://www.sec.gov/os/accessing-edgar-data). This resolves research.md's [unverified]. Use `submissions.zip` for imports.
- **Price:** $0.
- **Terms:** free to access and download. No explicit licence statement was found; US government works are generally public domain **[unverified]**.

### SAM.gov entity data
- **Endpoint & auth:**
  - Entity API `https://api.sam.gov/entity-information/v4/entities`.
  - Public extract: `GET https://api.sam.gov/data-services/v1/extracts?fileName=SAM_PUBLIC_MONTHLY_V2_YYYYMMDD.ZIP`.
  - **Both need the "Public API Key"** from a SAM.gov account. Send it as the `x-api-key` header; the docs also show `?api_key=`, but a header keeps it out of logs.
  - Live, no key: **HTTP 404 with an empty body** (not 401). (docs: https://open.gsa.gov/api/entity-api/, https://open.gsa.gov/api/sam-entity-extracts-api/)
- **Fields:**
  - `entityRegistration.legalBusinessName`
  - `coreData.entityInformation.entityURL` (often null)
  - `coreData.physicalAddress.{stateOrProvinceCode,countryCode}`
  - `assertions.goodsAndServices.{primaryNaics,naicsList[].naicsCode}`
  - Filters include `physicalAddressCountryCode=USA` and `registrationStatus=A`.
- **Limits:**
  - **10 requests/day** for a non-federal user with no SAM.gov role; 1,000/day with a role or a system account.
  - API pages max out at **10 records**.
  - ⇒ Download the **monthly public extract** (published the first Sunday of each month) only. Its `.dat` delimiter is **[unverified]**.
- **Price:** $0.
- **Terms** (https://sam.gov/about/terms-of-use):
  - Most material is free of copyright. Website scraping is banned; the API and extracts are the sanctioned route.
  - **D&B-sourced fields may not be used for marketing.** Which extract fields are still D&B-sourced is **[unverified]**: exclude them once identified.
  - The Public level has **no contact email or phone**.

### Icypeas (email finder and verifier)
- **Decided 2026-11-09 (finding #2):** only `email-search` and `email-verification` are used. Find People, the profile and company scrapers and the URL finders are never called. The adapter keeps only email, certainty and status and drops any LinkedIn-derived field before storage.
- **Endpoint & auth:**
  - Base `https://app.icypeas.com/api`.
  - `Authorization: <api key>` (raw key, **no `Bearer`**), or signed: `Authorization: <key>:<hex HMAC-SHA1(secret, lower(METHOD+path+timestamp))>` + `X-ROCK-TIMESTAMP`. Signed requests are preferred for stored BYO keys.
  - (docs: https://api-doc.icypeas.com/authentication.md)
- **Operations:**
  - `POST /email-search` with `{firstname, lastname, domainOrCompany}`, and `POST /email-verification` with `{email}`. Both are **async**: they return an `_id`.
  - Then poll `POST /bulk-single-searchs/read` with `{"id":…}` (**30/min**), or, better, use webhooks (`custom.webhookUrl`).
  - Final statuses: `FOUND`/`DEBITED`, `NOT_FOUND`/`DEBITED_NOT_FOUND`, `BAD_INPUT`, `INSUFFICIENT_FUNDS`, `ABORTED`.
  - Certainty `ultra_sure`/`very_sure` (99%) and `probable` (95%); `not_found` on verification means "can't tell" → `unknown`.
  - Input errors come back as **HTTP 200** with `success:false`.
  - `POST /a/actions/subscription-information` returns remaining credits, for reconciling the ledger.
- **Limits:** email search and verify 10/s; read 30/min; Find People 30/s. (docs: rate-limits.md)
- **Price** (https://www.icypeas.com/pricing, checked 2026-11-08, USD + VAT):
  - **Subscriptions only:** Basic **$19/mo for 1,000 credits**, Premium $39 for 4,000, Advanced $89 for 10,000, Hypergrowth from $499 for 20,000. Higher tiers are **[unverified]**.
  - **Credits never expire**, even after cancelling.
  - Email search is **1 credit, only when found**. Verification is **0.1 credit, always charged**. Find People is 0.02 per result.
  - ⇒ about $0.019 per found email and $0.0019 per verification.
  - The ToS banner mentions 50 free credits.
- **Terms** (https://www.icypeas.com/legal/terms-of-service, updated 2026-10-01):
  - Customers may "use, reproduce, distribute, sublicense, and resell" results, which suits BYO keys.
  - French law; data stored in the EU.

### Anthropic API (the `anthropic-api` LLM adapter)
- **Model:** cheapest current model **`claude-haiku-5-5`** (1M context, 128K max output). (docs: https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-11-08)
- **Price** (prompts ≤ 100k tokens):
  - **$0.10 / MTok input, $0.50 / MTok output**.
  - Cache read $0.01; 5-minute cache write $0.125.
  - **Batch API 50% off**.
  - Above 100k tokens: $0.50 / $2.50.
  - US-only inference is a 1.1× multiplier.
- **Thinking:** thinking tokens bill as output, so scoring runs at low effort.
- **Cost check:** 1,000 posts × (500 in + 80 out) ≈ **$0.09**, consistent with research.md.
- The CLI resolved the `haiku` alias to the same model (see `claude-cli.md`).

### HTTP Archive (optional technographics)
- **Coverage:** about **12.7M URLs** per monthly crawl, taken from Chrome UX Report (CrUX), with Wappalyzer detection. (docs: https://httparchive.org/docs/guides/getting-started/)
  - This replaces research.md's "about 12.5M domains": the figure counts URLs, and the domain count is **[unverified]**.
  - `crawl.pages` is about 30 TB per month.
- **Price:** BigQuery on-demand is $6.25 per TiB scanned, with 1 TiB/month free (https://cloud.google.com/bigquery/pricing). Dry-run every query; the bytes per technology query are **[unverified]**.
- **Licence:** **[unverified]**: the fetched pages state none.

### Benchmarks and upgrade-path vendors
- **LeadMagic** (https://leadmagic.io/pricing): $99 / $249 / $499 / $849 a month for 5k / 20k / 50k / 100k credits, so $0.0198–0.0085 per found email ($0.0071 on annual plans). Failed lookups are free. Its data sources are **[unverified]**.
- **Hunter** (https://hunter.io/pricing): Starter **$49/mo for 2,000 credits** (confirmed), with a free plan of 50/mo. Verification is 0.5 credit. Which plans include the API is **[unverified]**.
- **ZoomInfo:** no list price. Vendr puts the **median contract at $33.5k/yr** (range $7.3k–$156k, Feb 2026, https://www.vendr.com/marketplace/zoominfo). The about-$15k entry and about-$3/contact figures are third-party **[unverified]**.
- **Syften** (https://syften.com/pricing): $29.95 / $49.95 / $119.95 a month (unchanged). No Reddit licence claim (finding #10).

---

## Licences checked for reuse

| Project | Licence (checked 2026-11-08) | Verdict |
|---|---|---|
| Reacher / check-if-email-exists | **MIT** since v0.11.9 (2026-10-09): `LICENSE.md` on master (live), CHANGELOG, `Cargo.toml`. Docker image `reacherhq/backend:v0.11.11`. | Run as a sidecar behind a config flag (off by default); add a NOTICE entry if we ship it in compose. |
| OpenMagpie (obris-dev/openmagpie, HEAD 9967975) | **Apache-2.0**; `ee/` is reserved but **doesn't exist**. Python/Django. | We may **port** non-`ee` code with attribution. Only the HN connector, and RSS without its FlareSolverr fallback, fit our rules. Its Reddit (direct `.rss` scraping), X (session cookies) and YouTube (yt-dlp) connectors break CLAUDE.md. |
| IPinfo Lite data | **CC BY-SA 4.0**, product use allowed with attribution | Download at runtime; never bundle. |
| DB-IP Lite data | **CC BY 4.0** | Default country/ASN database; link-back attribution in the UI. |
| PDL free company dataset | **CC BY 4.0** (+ Acceptable Data Use Policy, not read) | Import on the Mac; attribution in NOTICE. |
| `@bsky/jetstream` | MIT OR Apache-2.0 | Use in Phase 4. |
| shadcn/ui (button, theme tokens) | MIT | Copied into `apps/web`; in NOTICE. |

---

## Port 25 on the netcup VPS (pending)

**Status: not tested.** This container isn't the VPS, and outbound port 25 from here says nothing about netcup.

What netcup documents (docs):
- The server firewall's default policy **"netcup Mail block" blocks incoming and outgoing SMTP**.
- The firewall is enabled by default for root servers and VPS **ordered from 2025-12-09**. Older servers have it only if it was activated in the SCP.
- The customer can delete the policy: SCP → server → **Firewall** → "netcup Mail block" → Delete. (https://www.netcup.com/en/helpcenter/documentation/server/firewall, updated 2026-07-23; https://www.netcup.com/en/blog/webhosting/new-netcup-firewall)
- Whether netcup also filters port 25 at the network level is **[unverified]**.

**Olaf: run this on the VPS** (from the host, not inside a container):

```sh
nc -vz -w5 gmail-smtp-in.l.google.com 25
```

| Outcome | Meaning | Action for Reacher |
|---|---|---|
| `Connection to gmail-smtp-in.l.google.com … 25 port [tcp/smtp] succeeded!` | Outbound SMTP is open. | Enable the Reacher sidecar. Also check the VPS IP against blocklists (e.g. Spamhaus) and set reverse DNS and `RCH__HELLO_NAME` / `RCH__FROM_EMAIL` to a real domain. |
| `Connection timed out` (after 5 s) | Port 25 is filtered, most likely by the "netcup Mail block" policy. | Either delete that policy in the SCP and re-run the test, or keep Reacher **disabled** and use Icypeas verification (0.1 credit each) instead, per SPEC §11. |
| `Connection refused` | Something actively rejected the connection: a local firewall (`ufw`/`nftables`) or an upstream reject. | Check the local firewall, then the netcup policy, and re-run. Until it succeeds, treat it as blocked. |
| `nc: getaddrinfo … failed` / name resolution error | A DNS problem, not a port result. | Fix DNS and re-run. |

Record the date, the output and the decision in `docs/decisions.md`.

**Running Reacher responsibly (when enabled):**
- It stays **off by default** (config flag) until this test passes; the Icypeas verifier is the fallback.
- Keep volume low: one SMTP check at a time per recipient domain, with a per-domain delay (start at one check per domain per minute), and a small daily total.
- Never retry quickly against the same domain. Treat greylisting as `unknown` and requeue it hours later.
- The SMTP conversation stops after `RCPT TO`; no mail is sent. Use a real `RCH__HELLO_NAME` and `RCH__FROM_EMAIL` on a domain with matching reverse DNS.
- High volume from one IP gets it blocklisted and, with it, the VPS's other mail. Low volume protects both us and the receiving servers.

---

## Phase 2 verification (2026-11-15)

Checked **2026-11-15** from the build container. Labels: **(live)** = called from this container, response seen; **(docs: URL)** = vendor's own page fetched today; **[unverified: …]** = not confirmed, says what was tried. No accounts, no keys, nothing spent.

### Headline findings (things that change code or config)

1. **Reacher `reacherhq/backend:latest` on Docker Hub is the v0.11.8 image (pre-MIT, dual-licence).** Digest of `latest` = `sha256:6f05f029…` = `v0.11.8`. MIT starts at v0.11.9. **Pin `reacherhq/backend:v0.11.11`** (digest `sha256:658de20f…`, amd64, ~426 MB) (live: hub.docker.com tags API; licence text at tags via raw.githubusercontent.com).
2. **The Reacher image is built on `zenika/alpine-chrome:123` and its `docker.sh` starts `chromedriver &` before the backend.** This conflicts with "No Chromium on the VPS by default"; Chromium only drives *headless* checks (Hotmail B2C, Yahoo), but the binary and chromedriver process are in the container. Options: accept it as an opt-in sidecar (Reacher is already off by default), or build our own image from the MIT source without Chrome. (docs: backend/Dockerfile, backend/docker.sh on master)
3. **Icypeas with no `Authorization` header returns HTTP 200** `{"success":false,"validationErrors":[{"field":"type","message":"insufficient_credits","type":"InsufficientCredits",…}]}`, **not 401**. An invalid key returns **401** with `code: "user_not_found_error"` (not the documented `unauthorized_access_error`). The adapter must treat both as auth/credit failures. (live)
4. **SAM.gov "D&B Open Data"** (Legal Business Name, street, city, state, ZIP, country, county) may be used with written attribution to D&B but **not "in bulk … as an original source or as a substitute"**; all other D&B data is banned for "commercial, resale or marketing purposes (e.g., identifying, quantifying, segmenting and/or analyzing customers and prospective customers)". D&B-supplied records = registrations last updated **before 2022-04-04**, flagged by `ENTITY EVS SOURCE = "D&B"` (col 122) and `D&B OPEN DATA FLAG = Y` (col 24). ⇒ drop rows with EVS source `D&B` or D&B flag `Y`. (docs: https://open.gsa.gov/api/entity-api/ disclaimer; layout xlsx)
5. **Form 4 raw XML filename is not always `form4.xml`** and booleans come as both `true/false` and `1/0`. (live)
6. **PDL free dataset has no direct download URL**; it is gated by a lead form (form id 478840). The Acceptable Data Use Policy page is JS-only and could not be read. (live)

---

### 1. Icypeas

Base `https://app.icypeas.com/api`, JSON bodies, HTTPS. (docs: https://api-doc.icypeas.com/llms.txt)

#### Auth (docs: https://api-doc.icypeas.com/authentication.md)
- `Authorization: <api key>` — raw key, **no `Bearer`** — plus `Content-Type: application/json`.
- Live behaviour (live, 2026-11-15, `POST /email-verification`):
  - no header → **HTTP 200** `{"validationErrors":[{"field":"type","message":"insufficient_credits","humanReadableMessage":"Insufficient credits to run the search","type":"InsufficientCredits","expected":null,"actual":null}],"success":false}`
  - `Authorization: invalid` → **HTTP 401** `{"message":"The user does not exist","error":"UserNotFoundError","status":401,"code":"user_not_found_error"}`
- Documented 401 body: `{"message":"Unauthorized access.","error":"UnauthorizedAccessError","status":401,"code":"unauthorized_access_error"}`. 429 body: `{"message":"You have exceeded the max number of requests per minute.","error":"RateLimitExceededError","status":429,"code":"rate_limit_exceeded_error"}`. (docs: reference/email-search.md)

#### `POST /email-search` (docs: https://api-doc.icypeas.com/reference/email-search.md)
- Body: `firstname` (string, may be `""` if lastname set), `lastname` (string, may be `""` if firstname set), `domainOrCompany` (string; domain preferred), optional `custom.webhookUrl` (url), `custom.externalId` (string).
- 200 OK: `{"success":true,"item":{"_id":"…","status":"NONE"}}`.
- 200 validation error: `{"success":false,"validationErrors":[{"expected","type","field","message"}]}`; types `required`/`string`/`url`/`stringEmpty`/`FirstLastMandatoryDiscoveryError`/`UnpaidSubscriptionError` (message `unpaid_subscription_error`, field `user`).
- Cost: 1 credit only if found.

#### `POST /email-verification` (docs: https://api-doc.icypeas.com/reference/email-verification.md)
- Body: `email` (required), optional `custom.webhookUrl`, `custom.externalId`.
- Same 200 `{success:true,item:{_id,status:"NONE"}}` shape; validation types `required`/`stringEmpty`/`email`/`string`/`url`/`UnpaidSubscriptionError`.
- Cost 0.1 credit.

#### `POST /bulk-single-searchs/read` (docs: https://api-doc.icypeas.com/reference/get-results.md)
- Body for one result: `{"id":"<_id>"}`. Other params: `mode` (`single`|`bulk`), `file`, `limit` (default 10, max 100), `next` (bool), `sorts`.
- Response: `{"success":true,"items":[{ "name","user","file","results":{"firstname","lastname","fullname","gender","emails":[{"email","certainty","mxProvider","mxRecords":[]}],"phones":[],"saasServices":[]},"order","status","system":{"createdAt","modifiedAt"},"userData":{"externalId","webhookUrl"},"_id"}],"total":n,"sorts":[…]}`.
- Email path: `items[0].results.emails[0].email`; certainty `items[0].results.emails[0].certainty`; status `items[0].status`.
- Read errors (HTTP 200, `success:false`): `SearchNotFoundError` (`search_not_found_error`, field `id`), `ModeOrIdShouldBeUsedError`, etc.

#### Statuses (docs: https://api-doc.icypeas.com/statuses.md)
- Running: `NONE`, `SCHEDULED`, `IN_PROGRESS` ("A search is finished when its status is **not** NONE, SCHEDULED or IN_PROGRESS").
- Finished: `FOUND`/`DEBITED`, `NOT_FOUND`/`DEBITED_NOT_FOUND`, `BAD_INPUT`, `INSUFFICIENT_FUNDS`, `ABORTED`.

#### Certainty (docs: https://api-doc.icypeas.com/certainties.md, quickstart/verify-email.md)
| `certainty` | Applies to | Meaning |
|---|---|---|
| `ultra_sure` / `very_sure` | all | 99%, bounce <1% → **valid** |
| `probable` | all | 95%, bounce <5% |
| `undeliverable` | verification | address does not exist → **invalid** |
| `not_found` | search / domain search | nothing found |
| `not_found` | verification | "We can't tell whether the address exists (for example the server accepts everything)" → **catch-all and unknown are not distinguished** |
- There is **no separate catch-all value**; catch-all and unknown both surface as `not_found` on verification. [unverified: which `status` accompanies `undeliverable` (FOUND vs NOT_FOUND) — docs do not say; no key to test]

#### Sync mode
- **None.** Docs: "Email search, email verification and domain search are asynchronous." OpenAPI paths (`/openapi.json`, live) contain no sync variant: `/email-search`, `/email-verification`, `/domain-search`, `/bulk-search`, `/bulk-single-searchs/read`, `/search-files/read`, `/a/actions/subscription-information`, plus find-people/scrape/url-search/reverse-lookup endpoints we don't use.
- Results via polling (≥3 s between reads; **30 reads/min**) or webhooks (`custom.webhookUrl`; payload `{signature,timestamp,data:<same item as read>}`, answer HTTP 200; webhooks "don't count against any limit"). (docs: how-it-works.md, reference/webhook-search-item.md, rate-limits.md)
- Limits: email-search 10/s, email-verification 10/s, read 30/min, bulk-search 1/s (≤5,000 rows). On 429 back off 2/4/8 s. (docs: rate-limits.md)

### 2. Reacher (check-if-email-exists)

#### Licence
- `LICENSE.md` on master, v0.11.9 and v0.11.11: **MIT** ("Copyright (c) 2026 Reacher"). At v0.11.8: "dual license model … Commercial license". CHANGELOG 0.11.9 (2026-10-09): "Switch to the MIT license and remove the Commercial License Trial". (live, raw.githubusercontent.com)
- docs.reacher.email/self-hosting/licensing: "distributed under the MIT License … including as part of proprietary software or commercial services". (docs: https://docs.reacher.email/self-hosting/licensing.md)

#### Docker image (live: https://hub.docker.com/v2/repositories/reacherhq/backend/tags)
| tag | digest | updated |
|---|---|---|
| `latest` | `sha256:6f05f02980c9…` (**= v0.11.8**) | 2026-10-30 |
| `v0.11.11` (= `beta`) | `sha256:658de20fac2b…` | 2026-10-30 |
| `v0.11.10` | `sha256:e23e3909a00a…` | 2026-10-16 |
| `v0.11.9` | `sha256:c4629b8daa1f…` | 2026-10-10 |
- ⇒ pin `reacherhq/backend:v0.11.11` (or digest). Size ~426 MB amd64.
- Base image `zenika/alpine-chrome:123`, adds `chromium-chromedriver`; CMD `./docker.sh` = `chromedriver & ./reacher_backend`. Env defaults in image: `RCH__HTTP_HOST=0.0.0.0`, `RCH__WORKER__ENABLE=false`, `RUST_LOG=reacher=info`; `EXPOSE 8080`. (docs: backend/Dockerfile, backend/docker.sh on master)

#### Config / env vars (docs: backend/backend_config.toml on master)
| Setting | Env var | Default |
|---|---|---|
| port | `RCH__HTTP_PORT` | `8080` |
| bind host | `RCH__HTTP_HOST` | `127.0.0.1` (image sets `0.0.0.0`) |
| shared secret | `RCH__HEADER_SECRET` | unset; when set, "required in the `x-reacher-secret` header of all incoming requests" |
| EHLO name | `RCH__HELLO_NAME` | `localhost` ("should match the reverse DNS of the server's IP") |
| MAIL FROM | `RCH__FROM_EMAIL` | `hello@localhost` |
| SMTP timeout (s) | `RCH__SMTP_TIMEOUT` | unset = wait indefinitely (**set it**, e.g. 45) |
| SOCKS5 proxy | `RCH__PROXY__HOST`, `RCH__PROXY__PORT`, `RCH__PROXY__USERNAME`, `RCH__PROXY__PASSWORD`, `RCH__PROXY__TIMEOUT_MS` | none |
| throttle (v1 only) | `RCH__THROTTLE__MAX_REQUESTS_PER_SECOND/_MINUTE/_HOUR/_DAY` | all commented out |
| webdriver | `RCH__WEBDRIVER_ADDR` | `http://localhost:9515` |
| worker (RabbitMQ) | `RCH__WORKER__ENABLE` | `false` |
| backend name | `RCH__BACKEND_NAME` | `backend-dev` |
- "throttle configurations only apply to /v1/* endpoints … /v0/check_email … always executes the verification immediately."

#### `POST /v1/check_email` (docs: backend/openapi.json on master, info.version 0.11.0, licence MIT)
- Request `CheckEmailRequest` (required: `to_email`): `to_email`, `from_email`, `hello_name`, `proxy` {host, port, username, password}, `smtp_port` (default 25), `gmail_verif_method`, `hotmailb2b_verif_method`, `hotmailb2c_verif_method` (`Smtp`|`Headless`), `yahoo_verif_method` (`Api`|`Headless`|`Smtp`), `check_gravatar`.
- "Unlike /v0/check_email, the new /v1/check_email endpoint queues the email for verification … based on … throttle and concurrency." Response is still the synchronous `CheckEmailOutput` (200).
- Auth: OpenAPI declares an `Authorization` apiKey header — that's the **SaaS**; self-hosted uses `x-reacher-secret` when `header_secret` is set (config file comment). [unverified: exact HTTP status returned on a wrong/missing secret — not run locally]
- Response `CheckEmailOutput` (required `input, is_reachable, misc, mx, smtp, syntax`; optional `debug`):
  - `is_reachable` enum `safe | risky | invalid | unknown`.
  - `mx`: `{accepts_mail: bool, records: string[]}` **or** `CoreError {type, message}`.
  - `smtp`: `{can_connect_smtp, has_full_inbox, is_catch_all, is_deliverable, is_disabled}` (all bool, required) **or** `CoreError`.
  - `misc`: `{is_disposable, is_role_account, is_b2c?, gravatar_url, haveibeenpwned}` or `CoreError`.
  - `syntax`: `{domain, is_valid_syntax, username, suggestion}`.
  - ⇒ parse `smtp`/`mx`/`misc` as a union; a `CoreError` there means treat as `unknown`.
- `risky` covers disposable, role account, catch-all, full inbox (docs: https://docs.reacher.email/getting-started/is-reachable.md) — consistent with the existing mapping in providers.md.
- Outbound port 25 must be open (README; docs install page).

### 3. ATS public job boards

#### Greenhouse Job Board API
- `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs` (live, `stripe`: HTTP 200, 490 KB, `meta.total` 785).
- Fields per job (live): `id`, `internal_job_id`, `title`, `location.name` (free text, e.g. `"Seattle, San Francisco, New York City"`), `absolute_url`, `updated_at` (`2026-10-29T10:42:09-04:00`), `first_published`, `company_name`, `requisition_id`, `language`, `metadata`, `data_compliance`, `education`, `application_deadline`.
- **Department/offices only with `?content=true`** (adds `content`, `departments[{id,name,parent_id,child_ids}]`, `offices[…]`) — but that response was **6.1 MB** for Stripe. Cheaper: `GET /v1/boards/{token}/departments` returns departments with nested `jobs` (live). Board info: `GET /v1/boards/{token}` → `{"name":"Stripe","content":""}` (live).
- Non-existent board: **HTTP 404** `{"status":404,"error":"Job not found"}` (live).
- Auth: "Job Board data is publicly available, so authentication is not required for any GET endpoints." (docs: https://developers.greenhouse.io/job-board.html)
- Rate limit: **none documented** for GETs; no rate-limit headers seen (live). robots.txt: `Disallow: /embed/` only (live).
- Terms: [unverified: greenhouse.com/legal is JS-rendered; /terms-of-service, /legal/terms-of-service, /api-terms, /legal/website-terms-of-use all 404. No public-consumer API terms found.]

#### Lever Postings API
- `GET https://api.lever.co/v0/postings/{site}?mode=json` (EU: `api.eu.lever.co`). Params `skip`, `limit`, `location`, `commitment`, `team`, `department`, `level`, `group`. (docs: https://raw.githubusercontent.com/lever/postings-api/master/README.md)
- Live (`palantir`, `limit=2`): JSON **array**; fields `id`, `text` (title), `categories {commitment, location, team, department?, allLocations[]}`, `country` (ISO alpha-2, e.g. `SG`), `workplaceType` (`unspecified|on-site|remote|hybrid`), `hostedUrl`, `applyUrl`, `createdAt` (**epoch ms**, e.g. 1786469891368), descriptions (`description`, `descriptionPlain`, `opening*`, `descriptionBody*`, `lists`, `additional*`), optional `salaryRange {currency, interval, min, max}`.
- **No updated/published date other than `createdAt`.**
- Non-existent site: **HTTP 404** `{"ok":false,"error":"Document not found"}` (live; also `netflix`).
- Limits: only the application POST is documented (2/s). robots.txt: `Allow: /`, **`Crawl-delay: 1`** (live) ⇒ 1 req/s.
- README: API is for "your company"; CORS only from your own domains; no statement on third-party reading. Terms: [unverified: lever.co/terms-of-service is the customer agreement (last updated 2023-08-25); no clause about public postings consumption found.]

#### Ashby Posting API
- `GET https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true|false` (docs: https://developers.ashbyhq.com/docs/public-job-posting-api.md, updated 2026-10-23).
- Live (`ashby`, 4.4 MB; `ramp`, `notion` also 200): `{"apiVersion":"1","jobs":[…]}`; job fields `id`, `title`, `location`, `secondaryLocations[{location,address}]`, `department`, `team`, `isListed`, `isRemote`, `workplaceType` (`Remote` etc.), `employmentType` (`FullTime` …), `address.postalAddress {addressLocality, addressRegion, addressCountry}` (country free text, e.g. `"USA"`, `"European Union"`), `jobUrl`, `applyUrl`, `publishedAt` (`2024-03-04T14:29:08.532+00:00`), `descriptionHtml`, `descriptionPlain`; `compensation` only with `includeCompensation=true`.
- `isListed:false` = "should only be available via direct link" ⇒ skip those.
- **No updatedAt**; `publishedAt` = "ISO DateTime when the job was last published".
- Responses are large (descriptions inline; no field selection or pagination documented).
- Non-existent board: **HTTP 404**, body plain text `Not Found` (live).
- Rate limits: none documented, no headers seen. `api.ashbyhq.com/robots.txt` → 401 `Unauthorized` (live); `jobs.ashbyhq.com/robots.txt` disallows `/api/` (that's the jobs site, not api host).
- Terms: [unverified: docs page has no terms; not searched further.]

### 4. People Data Labs free company dataset
- **Download:** only via the form on https://www.peopledatalabs.com/company-dataset (live): fields first/last name, email, title, company, country, use case, checkbox "By downloading, you are accepting our Privacy Policy and Acceptable Data Use Policy". Page JS shows `freeCompanyDataset: {form_id: 478840}`. **No direct/stable file URL** in the page HTML or its 24 JS bundles (live grep for .zip/.csv/.json/s3/download). Docs: "To download … go to http://www.peopledatalabs.com/company-dataset". ⇒ manual download + local import path.
- **Format** (docs: https://docs.peopledatalabs.com/docs/free-company-dataset.md): "CSV, pipe-delimited and JSON formats"; zipped (docs mention unzipping with 7-Zip). [unverified: exact CSV header row order, quoting, whether JSON is JSON-lines — no file downloaded]
- **Fields and examples (docs):**
  | field | type | example |
  |---|---|---|
  | `country` | enum | `united states` (lowercase) |
  | `founded` | integer | `2015` |
  | `id` | string | non-persistent, "generated from the company's primary LinkedIn username" |
  | `industry` | enum (LinkedIn industries) | `computer software` |
  | `linkedin_url` | string | `linkedin.com/company/peopledatalabs` (no scheme) |
  | `locality` | string | `san francisco` |
  | `name` | string | `people data labs` (lowercase) |
  | `region` | string | `california` (full state name, lowercase) |
  | `size` | enum | `11-50` |
  | `website` | string | `peopledatalabs.com` (**no scheme**) |
- `size` enum (docs: https://docs.peopledatalabs.com/docs/company-sizes.md): `1-10`, `11-50`, `51-200`, `201-500`, `501-1000`, `1001-5000`, `5001-10000`, `10001+`.
- Licence (docs): "You may use this data for any purpose. We have released it under the terms of the Creative Commons Attribution license (CC BY 4.0)".
- **Acceptable Data Use Policy:** [unverified: https://privacy.peopledatalabs.com/policies?name=acceptable-data-use-policy is a Transcend JS app ("please enable JS"); its backend `api.us.transcend.io/privacy-center/policies` returned 401; www.peopledatalabs.com/acceptable-data-use-policy returns an empty JS shell. Needs a browser, or ask PDL.]

### 5. SEC EDGAR
- UA: "Please declare your user agent in request headers: … User-Agent: Sample Company Name AdminContact@<sample company domain>.com"; "Current max request rate: 10 requests/second." (docs: https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data — the old /os/accessing-edgar-data redirects here). Live: curl default UA → 403; declared UA → 200.
- `company_tickers_exchange.json` (live): `{"fields":["cik","name","ticker","exchange"],"data":[[320193,"Apple Inc.","AAPL","Nasdaq"],[1045810,"NVIDIA CORP","NVDA","Nasdaq"],…]}` — 10,404 rows; `cik` is an integer.
- `https://data.sec.gov/submissions/CIK0000320193.json` (live) top-level keys: `addresses, category, cik, description, ein, entityType, exchanges, filings, fiscalYearEnd, flags, formerNames, insiderTransactionForIssuerExists, insiderTransactionForOwnerExists, investorWebsite, lei, name, ownerOrg, phone, sic, sicDescription, stateOfIncorporation, stateOfIncorporationDescription, tickers, website`.
  - `cik` is a zero-padded **string** (`"0000320193"`), `sic` string (`"3571"`), `website: ""`, `investorWebsite: ""`, `phone "(408) 996-1010"`, `entityType "operating"`.
  - `addresses.business` / `addresses.mailing`: `{street1, street2, city, stateOrCountry, zipCode, stateOrCountryDescription, isForeignLocation, foreignStateTerritory, country, countryCode}` — Apple: `CUPERTINO`, `CA`, `95014`, `isForeignLocation` null/0.
  - `filings.recent` = parallel arrays: `accessionNumber, filingDate, reportDate, acceptanceDateTime, act, form, fileNumber, filmNumber, items, core_type, size, isXBRL, isInlineXBRL, isXBRLNumeric, primaryDocument, primaryDocDescription`. `filings.files[]` = older pages `{name, filingCount, filingFrom, filingTo}`.
- **Form 4 raw XML URL (live):**
  - recent row: `form "4"`, `accessionNumber "0001140361-26-043484"`, `primaryDocument "xslF345X06/form4.xml"`.
  - `https://www.sec.gov/Archives/edgar/data/320193/000114036126043484/xslF345X06/form4.xml` → `text/html` (rendered).
  - `https://www.sec.gov/Archives/edgar/data/320193/000114036126043484/form4.xml` → `text/xml` raw `<ownershipDocument>`.
  - Rule: `https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession without dashes}/{basename(primaryDocument)}` (strip the `xslF345X0n/` prefix). Filename varies: TSLA's is `xslF345X06/tm2625055d1_4seq1.xml` (live). The folder listing is at `…/{accession}/index.json` (live) if needed.
- Form 4 XML (live): root `ownershipDocument` → `schemaVersion, documentType, periodOfReport, issuer{issuerCik,issuerName,issuerTradingSymbol}, reportingOwner, …`. `reportingOwner/reportingOwnerId/rptOwnerCik`, `rptOwnerName` (`"Newstead Jennifer"` — Last First), `reportingOwnerAddress/rptOwnerStreet1…`, `reportingOwnerRelationship/{isDirector,isOfficer,isTenPercentOwner,isOther,officerTitle}`.
  - **Booleans vary:** Apple filer agent uses `true`/`false`; MSFT and TSLA use `1`/`0` (live). Parse both.
  - `officerTitle` examples: `SVP, GC and Government Affairs`, `EVP, Chief Marketing Officer`, `Chief Financial Officer`.

### 6. SAM.gov public monthly extract
- File names (docs: https://open.gsa.gov/api/sam-entity-extracts-api/): monthly ASCII `SAM_PUBLIC_MONTHLY_V2_YYYYMMDD.ZIP`; monthly UTF-8 `SAM_PUBLIC_UTF-8_MONTHLY_V2_YYYYMMDD.ZIP`. "produced on the first Sunday of each month. Kindly check after 7 AM Eastern"; "The date on the .ZIP file matches the date on the .dat file inside"; contents "all active entities and entities expired in the last 6 months". Request: `fileName=SAM_PUBLIC_MONTHLY_V2_…ZIP` (or `fileType` + `version=V2`). Key required, 10 req/day for a non-federal user without a role.
- Layout (docs: https://open.gsa.gov/api/sam-entity-extracts-api/v1/SAM%20Master%20Extract%20Mapping%20v6.0%20Public%20File%20V2%20Layout.xlsx, sheet "Data Element Mapping", 142 columns):
  | col | element | notes |
  |---|---|---|
  | 1 | UNIQUE ENTITY ID | 12 chars |
  | 6 | SAM EXTRACT CODE | monthly: `A` Active, `E` Expired (= registration status) |
  | 7 | PURPOSE OF REGISTRATION | `Z1`…`Z5` |
  | 9 | REGISTRATION EXPIRATION DATE | YYYYMMDD |
  | 10 | LAST UPDATE DATE | YYYYMMDD |
  | 12 | LEGAL BUSINESS NAME | max 120 |
  | 13 | DBA NAME | |
  | 16–18 | PHYSICAL ADDRESS LINE 1 / LINE 2 / CITY | |
  | 19 | PHYSICAL ADDRESS PROVINCE OR STATE | e.g. `MN` |
  | 20 | PHYSICAL ADDRESS ZIP/POSTAL CODE | |
  | 22 | PHYSICAL ADDRESS COUNTRY CODE | `USA` |
  | 24 | D&B OPEN DATA FLAG | `Y`/`N`: "whether the Business Name and Physical Address sourced from D&B" |
  | 27 | ENTITY URL | e.g. `http://www.usbank.com` (with scheme) |
  | 33 | PRIMARY NAICS | 6 chars |
  | 34 / 35 | NAICS CODE COUNTER / NAICS CODE STRING | `~`-separated, each code + `Y`/`N` small-business flag |
  | 116 | EXCLUSION STATUS FLAG | `D` or null |
  | 122 | ENTITY EVS SOURCE | e.g. `D&B` |
  | 142 | END OF RECORD INDICATOR | `!end` |
- **Column delimiter of the .dat: [unverified]** — the layout xlsx (public and FOUO), the extracts page and the entity-api page never state it (grep for pipe/delimit). Sub-fields inside a column use `~` and `^`. Confirm from the first real file (expect a header/footer record too — also unverified).
- D&B (docs: https://open.gsa.gov/api/entity-api/ "Disclaimer: Limitation on Permissible Use of Dun & Bradstreet, Inc. (D&B) Data"): see headline 4. D&B Open Data = Legal Business Name, street, city, state/province name/code/abbreviation, ZIP, country name/code, county code. D&B-sourced records: "all entity registration records with a last updated date earlier than 4/4/2022 … show the Entity Validation Service (EVS) Source as D&B". ⇒ **exclude rows where col 122 = `D&B` (or col 24 = `Y`)**; for the rest, name/address/URL/NAICS are SAM data.

### 7. httpx (ProjectDiscovery)
- Flags (docs: https://raw.githubusercontent.com/projectdiscovery/httpx/main/README.md):
  - input: `-l, -list string` (file), `-u, -target string[]`, **stdin is read by default** (`-no-stdin` disables it; docs show `cat hosts.txt | httpx`, docs: https://docs.projectdiscovery.io/opensource/httpx/running.md)
  - tech: `-td, -tech-detect` ("display technology in use based on wappalyzer dataset"), `-cff, -custom-fingerprint-file`
  - output: `-j, -json` ("store output in JSONL(ines) format"), `-o, -output`, `-silent`, `-nc, -no-color`
  - rate: `-rl, -rate-limit int` (default **150**/s), `-rlm, -rate-limit-minute`, `-t, -threads` (default **50**)
  - `-timeout int` (seconds, default **10**), `-retries int`, `-fr, -follow-redirects`, `-maxr` (default 10), `-fhr`
  - `-duc, -disable-update-check` (otherwise it checks for updates), `-random-agent` (default **true**), `-H`, `-p, -ports`, `-sc`, `-title`, `-server`
  - pdcp cloud: `-pd, -dashboard` uploads results — don't pass it.
  - `-ss, -screenshot` needs headless Chrome — never pass it.
- JSON field names (docs: runner/types.go on main): `tech` (`[]string`, **omitempty** — absent when nothing detected), `url`, `input`, `host`, `host_ip`, `port`, `scheme`, `final_url`, `status_code`, `title`, `webserver`, `failed` (bool), `error`, `cdn`, `cdn_name`, `a`, `timestamp`.
- Version: `v1.12.0` (2026-09-08) (live: proxy.golang.org `@latest`; Docker Hub `projectdiscovery/httpx:v1.12.0`).
- Licence: **MIT** (live: LICENSE.md, "Copyright (c) 2021 ProjectDiscovery, Inc."). Tech fingerprints come via `wappalyzergo` (MIT) using data from `enthec/webappanalyzer` (**GPL-3.0**) — fine for running the binary; GPL-3 is AGPL-compatible if data were copied.
- Name clash: the Python `httpx` package also installs an `httpx` CLI. Resolve the binary by absolute path/configured path in `commands.ts`.

---

## Amazon SES Email Validation (checked 2026-11-15)

Labels as above. Added to Phase 2 on Olaf's approval: an optional verifier between Reacher and Icypeas.

#### A1. Operation, HTTP, SDK client
- **Operation:** `GetEmailAddressInsights`, SES **API v2** (service id `sesv2-2019-09-27`). (docs: https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetEmailAddressInsights.html, checked 2026-11-15)
- **HTTP:** `POST /v2/email/email-address-insights/` (docs show a trailing slash), `Content-type: application/json`, no URI params. (docs: same)
  - The JS SDK's own serializer uses `POST /v2/email/email-address-insights` (no trailing slash) and SigV4 signing name `ses`. (live: `@aws-sdk/client-sesv2@3.1169.0` `dist-cjs/index.js`)
- **Endpoint host:** `email.<region>.amazonaws.com` (e.g. `email.us-east-1.amazonaws.com`; also `email.<region>.api.aws` and FIPS variants). (docs: https://docs.aws.amazon.com/general/latest/gr/ses.html, checked 2026-11-15)
- **SDK:** `@aws-sdk/client-sesv2` → `GetEmailAddressInsightsCommand` (file `dist-types/commands/GetEmailAddressInsightsCommand.d.ts` present). (live) Reference page https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sesv2/command/GetEmailAddressInsightsCommand/ returns 200. (live)
- **CLI:** `aws sesv2 get-email-address-insights --email-address user@example.com --region us-east-1`. (docs: https://docs.aws.amazon.com/ses/latest/dg/email-validation-api.html, checked 2026-11-15)
- **Request body:** `{ "EmailAddress": string }` (required). No other fields. (docs: API_GetEmailAddressInsights)
- **Response body (200):**
  ```json
  { "MailboxValidation": {
      "IsValid": { "ConfidenceVerdict": "LOW|MEDIUM|HIGH" },
      "Evaluations": {
        "HasValidSyntax":     { "ConfidenceVerdict": "..." },
        "HasValidDnsRecords": { "ConfidenceVerdict": "..." },
        "MailboxExists":      { "ConfidenceVerdict": "..." },
        "IsRoleAddress":      { "ConfidenceVerdict": "..." },
        "IsDisposable":       { "ConfidenceVerdict": "..." },
        "IsRandomInput":      { "ConfidenceVerdict": "..." } } } }
  ```
  Every field is **Required: No** in the type pages (`MailboxValidation`, `EmailAddressInsightsMailboxEvaluations`, `EmailAddressInsightsVerdict`), so parse all of them as optional. (docs: https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_MailboxValidation.html, …/API_EmailAddressInsightsMailboxEvaluations.html, …/API_EmailAddressInsightsVerdict.html, checked 2026-11-15)
- **Errors:** `BadRequestException` 400, `TooManyRequestsException` 429, plus common errors. (docs: API_GetEmailAddressInsights)

#### A2. Result values
- `ConfidenceVerdict` valid values: `LOW | MEDIUM | HIGH`. (docs: API_EmailAddressInsightsVerdict)
- **`IsValid` (overall verdict):** HIGH = high delivery likelihood, MEDIUM = moderate, LOW = low. (docs: email-validation-api.html) The AWS blog adds: HIGH "passed all critical validation checks"; MEDIUM "passed basic validation but has characteristics that might affect deliverability (such as being a role address or having uncertain mailbox existence)"; LOW "failed one or more critical validation checks". (docs: https://aws.amazon.com/blogs/messaging-and-targeting/how-to-improve-email-sender-reputation-with-amazon-ses-email-validation/, posted 2026-01-16, checked 2026-11-15)
- **Per-check verdicts mean "strength of indication"**, not pass/fail: e.g. `IsRandomInput: HIGH` = very likely random; `LOW` = weak/no indication. So for `IsRoleAddress`, `IsDisposable`, `IsRandomInput` **HIGH is bad**; for `HasValidSyntax`, `HasValidDnsRecords`, `MailboxExists` HIGH is good. (docs: email-validation-api.html)
- **Syntax:** `HasValidSyntax` (RFC 5321/5322 per blog). **DNS/MX:** `HasValidDnsRecords` ("domain exists, has valid DNS records, and is configured to receive email"; blog: MX and corresponding A records). **Mailbox existence:** `MailboxExists` ("without actually sending an email"; blog says it "Predicts"). **Role:** `IsRoleAddress` (admin@, support@, info@). **Disposable:** `IsDisposable`. **Random:** `IsRandomInput`. (docs: email-validation-api.html, blog)
- **Catch-all / accept-all:** **no field for it.** Neither the API reference nor the guide nor the blog mention catch-all or accept-all (searched "catch", "accept-all"). [unverified: how a catch-all domain is reported; presumably a MEDIUM `MailboxExists`/`IsValid`, not documented]. No "unknown" verdict either; there are only the three values.

#### A3. Limits, regions, prerequisites
- **Rate:** no validation-specific quota is documented. The general SES quota says all API actions except `SendEmail`/`SendBulkEmail` "are throttled at one request per second", **not adjustable**. (docs: https://docs.aws.amazon.com/ses/latest/dg/quotas.html, checked 2026-11-15) So plan for **1 req/s per account per region** and handle 429. [unverified: whether `GetEmailAddressInsights` has its own, different limit]
- **Regions:** "Email validation is available in all AWS Regions where Amazon SES is available." (docs: https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-ses-email-validation/, checked 2026-11-15). Plan-included quotas and Auto Validation are per account per region. (docs: pricing page, blog)
- **Sandbox / production access:** "the Email Validation API works with an AWS account that is in the Amazon SES sandbox". (docs: blog above) The blog lists "at least one verified email address or domain" among its walkthrough prerequisites, but the API reference and guide do not say a verified identity is required for `GetEmailAddressInsights`. [unverified: whether a call succeeds with zero verified identities]
- **Opt-in:** API validation needs no enabling step in the docs (just IAM permission and a call). Auto Validation is separate and is switched on per region with `PutAccountSuppressionAttributes` (`ValidationAttributes.ConditionThreshold`). (docs: https://docs.aws.amazon.com/ses/latest/dg/email-validation-auto.html, checked 2026-11-15)

#### A4. Price
- **À la carte: $0.01 per email address validated using API or console.** (Auto Validation: $0.01 per 1,000.) (docs: https://aws.amazon.com/ses/pricing/, checked 2026-11-15)
- Plans: Pro ($105/account/region/month) includes 2,500 API validations/account/region/month; Enterprise ($500) 5,000; extra at $0.01. (docs: pricing)
- **No validation-specific free tier.** Only the general AWS Free Tier: new customers get up to $200 in credits usable on SES; credits must be used within 12 months. (docs: pricing)
- → $50 budget = 5,000 validations max. Ledger cost per call: **$0.01** flat.

#### A5. IAM
- Action: **`ses:GetEmailAddressInsights`**, access level **Read**, **no resource types** (so `"Resource": "*"`), condition key **`ses:ApiVersion`** only. (docs: https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html, checked 2026-11-15)
- The SES guide's sample policy also grants `iam:CreateServiceLinkedRole` "to enable CloudWatch metrics publishing for validation activity". (docs: email-validation-api.html) For least privilege, `ses:GetEmailAddressInsights` on `*` alone should be enough to call the API. [unverified: whether the first call fails without `iam:CreateServiceLinkedRole`]
- Least-privilege policy:
  ```json
  {"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ses:GetEmailAddressInsights","Resource":"*"}]}
  ```
  Optionally add `"Condition":{"StringEquals":{"aws:RequestedRegion":"us-east-1"}}` (global key) to pin a region.

#### A6. Terms
- **Nothing validation-specific** in the SES section (§15) of AWS Service Terms (Last Updated November 5, 2026). §15.4: AWS may suspend SES for AUP breaches, abusive/low-quality email, bounces, complaints. §15.6: AWS is not the CAN-SPAM "sender". (docs: https://aws.amazon.com/service-terms/, checked 2026-11-15)
- AWS AUP forbids using services "to distribute, publish, send, or facilitate the sending of unsolicited mass email or other messages, promotions, advertising, or solicitations (or 'spam')". (docs: https://aws.amazon.com/aup/, checked 2026-11-15) Validating prospect emails for cold outreach arguably "facilitates" sending; that's a judgement call, not explicit text.
- No text found saying validation may only be used on your own lists or on addresses you'll send through SES. The feature is described as protecting **your SES sender reputation** (sign-up forms, list cleaning). [unverified: any separate Email Validation addendum; none linked from the guide or pricing page]

#### A7. Package weight / SigV4 alternative
| Package | Version (npm today) | Unpacked size | Direct deps | Installed (`npm i --ignore-scripts`) |
|---|---|---|---|---|
| `@aws-sdk/client-sesv2` | 3.1169.0 (modified 2026-11-13) | 2,004,400 B | 9 | **24 packages, 19 MB** on disk |
| `aws4fetch` | 1.0.20 (2024-08-28) | 65,541 B | 0 | 1 package, 96 KB |
| `@smithy/signature-v4` | 5.7.5 (2026-10-29) | 106,908 B | 3 | 4 packages, 8.3 MB |
| `aws4` (Node, mhart) | 1.13.2 | 23,399 B | 0 | — |
(live: `npm view`, local install in scratchpad)
- **Hand-signed SigV4 is reasonable:** one JSON POST, one region, a fixed signing name `ses` (live: SDK source). `aws4fetch` maps host prefix `email` → service `ses` automatically (live: its `dist/aws4fetch.esm.mjs`). It uses `fetch` + WebCrypto (Node 18+). It fits the "all paid calls through `apps/engine/src/providers/`, undici" rule better than the 24-package SDK. [unverified: a real signed call; no keys were used]

---

### SES → `emailStatus` mapping (as implemented in `providers/ses.ts`)
SES returns LOW/MEDIUM/HIGH confidence per check; for the trait checks HIGH means the trait applies. It has **no catch-all signal**, so it never yields `catch_all`.
| SES result | Verdict | `Contact.emailStatus` |
|---|---|---|
| `HasValidSyntax`, `HasValidDnsRecords` or `MailboxExists` = LOW, or `IsValid` = LOW | invalid | `invalid` (next candidate) |
| `IsDisposable`, `IsRandomInput` or `IsRoleAddress` = HIGH | risky | `risky` |
| `IsValid` = HIGH (and none of the above) | valid | `verified` (published or found) / `pattern_verified` (generated) |
| `IsValid` = MEDIUM, or fields missing | unknown | `unknown` → Icypeas finder |

### Least-privilege IAM policy for the workspace key
Create an IAM user with only this policy, then an access key ("Other"), and enter the key ID, secret and SES region in Settings → Provider keys:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ses:GetEmailAddressInsights", "Resource": "*" }
  ]
}
```
The action has no resource types, so `Resource` must be `"*"`. The SES guide's sample adds `iam:CreateServiceLinkedRole` for CloudWatch metrics; whether calls fail without it is [unverified], so start without it and add it only if AWS asks.

### Notes from the check
- Stack Exchange: the 2025 Stack Apps help says to send the key as `Authorization: Bearer` and generate it with "Generate API Key" (new dashboard). providers.md says `key=` is optional and points to `/apps/oauth/register`. Re-check which auth style v2.3 accepts with `LE_E2E=1`.
- SES validation reports **no catch-all**, so it can't fill `Contact.emailStatus = catch_all` (Reacher's `smtp.is_catch_all` can).

---

## Getting your keys

<!-- generated:provider-help -->
Generated from `PROVIDER_HELP` in `packages/shared/src/provider-help.ts` (links checked 2026-11-15). "docs" means the vendor has no direct key page.

| Provider | Where it goes | Used for | Cost | Link | Minimum scope |
|---|---|---|---|---|---|
| Anthropic API | Settings → Provider keys | LLM for offer drafts, fit scoring and people extraction | pay as you go; claude-haiku-5-5 is $0.10 / $0.50 per million input / output tokens | [create](https://platform.claude.com/settings/keys) | no scopes; set a monthly spend limit in the Claude Console as a second cap |
| Amazon SES | Settings → Provider keys | Email validation (SES Email Validation API), before Icypeas; never sending | $0.01 per address validated; no free tier for validation | [create](https://console.aws.amazon.com/iam/home#/users) | an IAM user whose only policy allows ses:GetEmailAddressInsights on Resource "*"; create an access key ("Other"), then enter the key ID, secret and SES region |
| Icypeas | Settings → Provider keys | Email finder (and verifier when neither Reacher nor SES is set); never Find People | from $19/month for 1,000 credits; verify 0.1 credit, find 1 credit only when found | [create](https://app.icypeas.com/bo/api) | turn on "Activate API Access", then copy the API key (no scopes) |
| ipapi.is (later phase) | Settings → Provider keys | Website visitor company lookup (stream 1, Phase 3) | free key: 1,000 lookups/day, commercial use allowed | [create](https://ipapi.is/app/signup) | no scopes; the key is shown at ipapi.is/app after signup |
| Serper (later phase) | Settings → Provider keys | Reddit threads via Google search (stream 2, Phase 4) | 2,500 free queries, no card; paid packs start at $50 (capped at $0 here) | [create](https://serper.dev/api-keys) | no scopes |
| Stack Exchange (later phase) | Settings → Provider keys | Stack Exchange question search (stream 2, Phase 4) | free; 10,000 requests/day with a key | [create](https://stackapps.com/apps/oauth/register) | register an app, then "Generate API Key"; read-only, no OAuth needed |
| GitHub (later phase) | Settings → Provider keys | Issue search (stream 2, Phase 4) | free; 30 searches/minute with a token | [create](https://github.com/settings/personal-access-tokens/new) | fine-grained token, "Public repositories" access, no permissions |
| IPinfo Lite (later phase) | Settings → Provider keys | Optional country/ASN database instead of DB-IP (stream 1) | free; CC BY-SA 4.0, attribution required | [create](https://ipinfo.io/signup) | no scopes; the token is at ipinfo.io/dashboard/token |
| SAM.gov (later phase) | Settings → Provider keys | Optional monthly entity extract (not built yet) | free; 10 requests/day without a SAM.gov role | [docs](https://open.gsa.gov/api/entity-api/) | public API key from your SAM.gov Account Details page (shown once after re-entering your password) |
| SEC EDGAR User-Agent | LE_SEC_USER_AGENT | EDGAR import and officers; SEC requires a declared contact instead of a key | free; at most 10 requests/second | [docs](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) | a contact like "Lead Engine admin@yourdomain.com" |
| People Data Labs company dataset | Settings → Company data (download link) | Company universe import; no key, a download form | free; CC BY 4.0 | [create](https://www.peopledatalabs.com/company-dataset) | request the US file; paste the link they send into Settings → Company data |
<!-- /generated:provider-help -->

