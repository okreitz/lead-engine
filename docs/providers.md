# Providers: verified endpoints, limits, prices and terms

Checked **2026-11-08** for Phase 0 (SPEC §11). Labels:
- **live**: the endpoint was called from the build container and the response seen.
- **docs**: the vendor's or operator's own page, fetched that day.
- **[unverified]**: not confirmed; says what was tried.

No accounts were created, no keys were used and nothing was spent. Live calls used only free, keyless endpoints. Prices change; recheck them before relying on any figure for a budget decision. None of this is legal advice.

## What this changes (read first)

| # | Finding | Impact | Status |
|---|---|---|---|
| 1 | **ARIN's RDAP/Whois Terms of Use cover RDAP** and forbid use "as part of a commercial service or product" and "for … marketing research". | SPEC §5.2 step 6 ("else RDAP") is not usable as written for US IPs in a hosted product. research.md's "use per-IP RDAP instead [of bulk WHOIS]" doesn't avoid the restriction. | **Open: Olaf to decide** (see `decisions.md`) |
| 2 | **Icypeas data is LinkedIn-derived.** Find People returns `linkedin.com/in/…` URLs and Sales Navigator URNs, and the API sells LinkedIn profile/company scrapers. | Conflicts with CLAUDE.md "don't use vendors that [scrape LinkedIn]". At minimum, drop Find People (SPEC §5.1 step 5). | **Open: Olaf to decide** |
| 3 | **ipapi.is:** keyless calls are now 30/day with a cut-down response. The 1,000/day free tier needs a free key. Data is for internal use only, unless **each user calls with their own key**. | The collector needs a key. **Hosted mode must use a per-workspace (BYO) ipapi.is key**, never a shared instance key. | Decided (fits the BYO-key model) |
| 4 | **netcup blocks outbound SMTP by default** on servers with its firewall enabled (the "netcup Mail block" policy, removable by the customer). | Reacher depends on it. Live test pending (see the last section). | **Pending: test on the VPS** |
| 5 | **Reacher is now MIT** (since v0.11.9, 2026-10-09). `/v0/check_email` is deprecated; use `/v1/check_email`. `is_reachable` ∈ `safe\|risky\|invalid\|unknown`; catch-all is `smtp.is_catch_all`. | The sidecar raises no licence issue. SPEC §5.1 step 6.3 labels need a mapping (below). | Decided |
| 6 | **Serper's smallest paid pack is $50 for 50k credits** (valid 6 months). There is no pay-as-you-go option. | SPEC §8.2 "about 600 searches ≈ $1" is wrong. The first paid search costs $50, the whole monthly budget. Stay inside the 2,500 free queries until stream 2 shows ROI. | Decided (budget note) |
| 7 | **SEC EDGAR has no domains:** `website` was `""` for all 6 large caps sampled. | EDGAR gives names, SIC, state and officers, but domains must come from elsewhere (the PDL match). | Note for Phase 2 |
| 8 | **SAM.gov needs a key** even for the public monthly extract. Non-federal users without a role get 10 requests/day. | Use only the monthly extract, and the key goes in instance config. No contact emails at the Public level. | Note for Phase 2 |
| 9 | **Bluesky Jetstream v2** exists, with an official MIT/Apache client `@bsky/jetstream`. | Use v2 + `@bsky/jetstream` instead of `@skyware/jetstream` (MPL-2.0, v1). | Decided |
| 10 | **Syften claims no Reddit licence**; it reads Reddit "from the perspective of a logged-out user". | It's doubtful as the SPEC §8.4 Reddit upgrade under our vendor rule. Ask Syften in writing before buying. | Note |
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

  Permitted use is "Internet operational or technical research". The ToU allows "prior written authorization" from ARIN. **⇒ Finding #1.** Options are in `decisions.md`.

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
- **Policy conflict: finding #2.** Find People and the scrapers are LinkedIn-derived. Nothing below is used until Olaf decides.
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
| Reacher / check-if-email-exists | **MIT** since v0.11.9 (2026-10-09): `LICENSE.md` on master (live), CHANGELOG, `Cargo.toml`. Docker image `reacherhq/backend:v0.11.11`. | Run as a sidecar; add a NOTICE entry if we ship it in compose. |
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
