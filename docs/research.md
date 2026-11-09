# Research: sources, prices and reuse (November 2026)

Collected on 2026-11-08 from vendor pages, GitHub search and web sources. **[unverified]** means the figure came from a third party or memory. Phase 0 checked these against primary sources on 2026-11-08: **`docs/providers.md` is now the source of truth**, and each item below says what was resolved (**[verified]** / **[corrected]**) or is still **[unverified]**. Prices change; this file is a starting point, not a contract.

## Headline findings
- No open-source project covers all three streams. Stream 3 has usable references; stream 2 has young ones; stream 1 has only demos.
- Website visitors resolve to a company about 10–25% of the time with WHOIS/ASN data plus one cheap paid source. Vendors claim 30–50% in their own marketing. An in-house IP-to-company map built from form fills is the main way to improve this.
- Reddit's public Data API is being shut down. New access requests stopped 2026-10-31, RSS ends 2026-11-13, unregistered apps lose access 2027-01-12, and the public API closes in March 2027. Unauthenticated `.json` has returned 403 since May 2026. GummySearch closed on 2026-12-01 for lack of a commercial licence. (Secondary sources that agree: [DigitalApplied](https://www.digitalapplied.com/blog/reddit-api-rss-shutdown-ai-tools-deadlines), [Open RSS](https://openrss.org/work/161), [GummySearch](https://gummysearch.com/final-chapter); the r/redditdev post itself could not be fetched.)
- LinkedIn sued Proxycurl in January 2025 and it shut down in July 2025. *hiQ v. LinkedIn* made LinkedIn's user agreement enforceable against scrapers.

## Stream 1: website visits

### Free IP data
| Source | Gives | Terms |
|---|---|---|
| IPinfo Lite | Country, ASN, AS name, AS domain (no company) | Free, unlimited API and download, **but needs a free account token**; CC BY-SA 4.0, product use allowed with attribution **[corrected]** |
| MaxMind GeoLite2 ASN | ASN and org | Free account, EULA, delete old copies within 30 days |
| DB-IP Lite | Country / ASN | CC BY 4.0, monthly, no account **[verified]** |
| iptoasn.com | IP range → ASN | Public domain, hourly |
| [sapics/ip-location-db](https://github.com/sapics/ip-location-db) | Prebuilt ASN/geo databases | Mixed source licences |
| RIPE/APNIC/LACNIC/AFRINIC bulk WHOIS | Sub-allocations of large companies | Free downloads |
| ARIN bulk WHOIS | US ranges | Agreement limits use to operational/technical research; **not for products** |
| RDAP, reverse DNS (PTR) | Most specific org record; sometimes a corporate hostname | Free, rate-limited. **[corrected]** ARIN RDAP falls under the same RDAP/Whois Terms of Use, which forbid use "as part of a commercial service or product" and for marketing research. **RDAP is dropped**; PTR is kept (`docs/decisions.md`) |

### Paid IP-to-company
| Vendor | Price | Notes |
|---|---|---|
| [ipapi.is](https://ipapi.is/pricing.html) | 1,000/day free **with a free key** (keyless: 30/day, cut-down response); API $20/mo (20k/day); IP-to-Company DB $89/mo **[verified]** | Company name, domain, type (business/isp/hosting/education/government/banking); VPN, datacenter and mobile flags. Licence is internal-use only unless each user brings their own key, so hosted mode is BYO key. **Chosen** |
| [MaxMind GeoIP2 ISP](https://www.maxmind.com/en/geoip-databases) | $539/yr | Organization field from WHOIS; Connection Type DB $1,507/yr |
| [ipregistry](https://ipregistry.co/pricing) | $29/mo for 100k | Company data and VPN detection |
| [ipdata](https://ipdata.co/pricing.html) | From $50/mo | Company name, domain and type |
| [Leadfeeder/Dealfront](https://www.leadfeeder.com/pricing/) | Free tier: last 100 companies/mo | Useful as a benchmark |
| [RB2B](https://www.rb2b.com/pricing) | Free 150 company resolutions/mo; Starter $79/mo | Person-level, US only, identity-graph based (can't be self-built) |
| IPinfo company data, Snitcher API, KickFire, HubSpot Breeze, 6sense, Demandbase | Enterprise or quote **[unverified]**; not checked in Phase 0 because they are out of budget | Out of budget |

### Reference repos (stream 1)
Only demos exist: [loootai/looot-reveal](https://github.com/loootai/looot-reveal) (MIT, vendor-locked), [f0rest06/visitor-signal-engine](https://github.com/f0rest06/visitor-signal-engine) (no licence), [Scalencyai/leadtracker](https://github.com/Scalencyai/leadtracker). Useful building blocks: [jedisct1/iptoasn-webservice](https://github.com/jedisct1/iptoasn-webservice) (BSD-2), [zmap/zannotate](https://github.com/zmap/zannotate) (Apache-2.0).

## Stream 2: conversation intent

| Source | Access | Cost | Verdict |
|---|---|---|---|
| Reddit Data API | OAuth | Free tier non-commercial; closes March 2027 | Don't build on it |
| Reddit via Google SERP ([Serper](https://serper.dev)) | `site:reddit.com` queries | 2,500 free, then $1 per 1,000, **but the smallest pack is $50 for 50k credits, valid 6 months** **[corrected]** | **Chosen**; link out, don't copy content |
| Hacker News Algolia | `search_by_date`, no key | $0 | Chosen |
| Bluesky Jetstream | WebSocket, no auth | $0 | Chosen; use Jetstream v2 with the official `@bsky/jetstream` client (MIT OR Apache-2.0) instead of skyware-js/jetstream (MPL-2.0, v1 API) **[corrected]** |
| Stack Exchange API | App key, 10,000 requests/day by default (300/day per IP without a key) **[verified]** | $0 | Chosen |
| GitHub issues/discussions | REST/GraphQL search | $0 | Chosen for developer-tool offers |
| X API | Pay-per-use, $0.005 per post read | Variable | Later, narrow queries only |
| Google Custom Search JSON API | Closed to new customers, ends 2027-01-01 | — | No |
| LinkedIn, G2, Capterra, Discord, Quora | ToS forbid scraping | — | No |
| [Syften](https://syften.com/pricing) | $29.95–119.95/mo, API on all plans **[verified]** | — | Upgrade path for Reddit, but it claims no Reddit licence and reads Reddit "from the perspective of a logged-out user"; **removed from the upgrade ladder** **[resolved: no licence found]** |
| [F5Bot](https://f5bot.com) | Free / $49.99 Gold | — | Reddit coverage after March 2027 unknown |
| [Octolens](https://octolens.com/pricing) | From $159/mo | — | Too expensive for now |

**LLM scoring cost:** about 500 input and 80 output tokens per post with the cheapest Haiku model; well under $1 per 1,000 posts.

**Identity:** Reddit's Public Content Policy forbids using its content to identify individuals. The thread is the lead; reply in it openly.

**Reference repos:**
- [obris-dev/openmagpie](https://github.com/obris-dev/openmagpie): Apache-2.0; `ee/` is reserved but doesn't exist. Python, so reuse means porting; only its HN and RSS connectors fit our rules **[verified]**.
- [yangyixxxx/lead-signal-listener](https://github.com/yangyixxxx/lead-signal-listener): MIT.
- [dancolta/subscope](https://github.com/dancolta/subscope): MIT. Relies on dead Reddit endpoints.
- [rohansx/leadecho](https://github.com/rohansx/leadecho): no licence.
- [vipulawl/reddit-leads](https://github.com/vipulawl/reddit-leads): AGPL.

## Stream 3: persona fit

### Company data (US)
| Source | Coverage | Terms |
|---|---|---|
| [PDL free company dataset](https://docs.peopledatalabs.com/docs/free-company-dataset) | 22M+ companies worldwide, name, domain, size, industry, LinkedIn URL | CC BY 4.0, quarterly |
| SEC EDGAR | US public companies, officers (no domains: `website` is empty) | Free, 10 req/s, declared User-Agent required **[verified]** |
| SAM.gov, USAspending | Government suppliers, NAICS | Free; SAM.gov needs an API key (10 requests/day), so it is optional and uses the monthly extract only **[verified]** |
| [Overture Places](https://docs.overturemaps.org/) | Tens of millions of POIs with websites | CDLA-Permissive-2.0 / Apache-2.0 |
| GLEIF LEI, Wikidata | Entity matching, larger firms | CC0 |
| Common Crawl web graph, Tranco, Majestic | Domain universe and size proxy | Free; Cloudflare Radar is CC BY-NC (**not allowed**) |
| OpenCorporates | Global registries | No self-serve free tier; from £2,250/yr. Skip |
| Crunchbase | Funding | Free Basic API discontinued. Skip |

### Technographics
[projectdiscovery/httpx](https://github.com/projectdiscovery/httpx) `-td` with [wappalyzergo](https://github.com/projectdiscovery/wappalyzergo) (MIT) is the best choice. HTTP Archive on BigQuery covers about 12.7M **URLs** monthly, from CrUX (**[corrected]**; the domain count is still **[unverified]**). 300k homepages take about 1–3 hours on one VPS (estimate).

### People and email
| Vendor | Price | Notes |
|---|---|---|
| [Icypeas](https://icypeas.com/pricing) | $19/mo subscription for 1,000 credits; email search charged only when found; Find People 0.02 credits per result; credits don't expire **[verified]** | **Email finder and verifier only.** Find People is not used (it returns LinkedIn profile data), and LinkedIn-derived fields are never stored (`docs/decisions.md`) |
| [LeadMagic](https://leadmagic.io/pricing) | $0.007–0.02 per found email; failed lookups free; **plans start at $99/mo** **[verified]** | Upgrade path |
| [Hunter](https://hunter.io/pricing) | $49/mo for 2,000 credits | Mid-priced |
| [People Data Labs](https://www.peopledatalabs.com/pricing/person) | 100 free credits/mo with emails hidden; about $0.28/record | Too expensive per record |
| [Apollo](https://www.apollo.io/pricing) | API only on Custom plans; terms bar backend use | Skip |
| ZoomInfo | Median contract about $33.5k/yr (Vendr, Feb 2026) **[corrected]**; about $3 per contact **[unverified]** | The benchmark we beat |
| Coresignal, Bright Data, ScrapIn | LinkedIn-derived | Same legal risk as Proxycurl. Skip |

**Self-hosted verification:** [reacherhq/check-if-email-exists](https://github.com/reacherhq/check-if-email-exists) (10.4k stars), **MIT since v0.11.9 (2026-10-09)** **[verified]**. Needs outbound port 25 and a clean IP. Expect roughly 20–40% of B2B domains to be catch-all or unknown (estimate). netcup port 25: the default firewall policy "netcup Mail block" blocks SMTP and can be removed by the customer (docs); the live test on the VPS is still pending **[unverified]**.

**Crawling:**
- [Crawl4AI](https://github.com/unclecode/crawl4ai): Apache-2.0, Python.
- [Firecrawl](https://github.com/firecrawl/firecrawl): AGPL.
- [ScrapeGraphAI](https://github.com/ScrapeGraphAI/Scrapegraph-ai): MIT. Not used as a dependency; see "Evaluated and rejected" below.

The engine starts with plain fetch plus readability in Node to stay inside the memory budget.

**Expected cost:** about $0.02–0.05 per enriched contact with the waterfall in SPEC §5.1 (estimate), versus about $0.28 at PDL and about $3 at ZoomInfo (the ZoomInfo figure is **[unverified]**).

## End-to-end and orchestration projects

| Project | Stars | Licence | Covers | Use |
|---|---|---|---|---|
| [ethanplusai/sellbird](https://github.com/ethanplusai/sellbird) | 4.9k | AGPL-3.0 | Stream 3 + outreach; `claude` CLI | Closest reference |
| [GortexAI/franco](https://github.com/GortexAI/franco) | 723 | MIT | Stream 3; `claude`/Codex CLI | Copyable patterns |
| [debpalash/OpenGTM](https://github.com/debpalash/OpenGTM) | 100 | AGPL-3.0 | Clay-like workbench and waterfalls | Design reference; about 4 GB RAM |
| [eracle/OpenOutreach](https://github.com/eracle/OpenOutreach) | 3.5k | GPL-3.0 | ICP agent; tied to BetterContact | Prompt ideas |
| [sami2919/SignalForce](https://github.com/sami2919/SignalForce) | 12 | MIT | Fit × intent scoring | Scoring design |
| [firecrawl/fire-enrich](https://github.com/firecrawl/fire-enrich) | 1.3k | MIT | Enrichment agents | Agent decomposition |
| [Nuclear-Marmalade/dataforge](https://github.com/Nuclear-Marmalade/dataforge) | 59 | MIT | Email extraction, US registries | Importers |
| [openenrich/openenrich](https://github.com/openenrich/openenrich) | 11 | AGPL-3.0 | Waterfall engine | Design reference |
| [Samyrrrrrr990/openleads](https://github.com/Samyrrrrrr990/openleads) | 63 | AGPL-3.0 | Evidence labels on emails | Idea |

Licence notes:
- n8n uses the Sustainable Use License (not OSI-approved).
- RudderStack and Mautic use the Elastic License 2.0 (per this research).
- Avoid both as embedded dependencies.

## Evaluated and rejected

### ScrapeGraphAI (checked 2026-11-09, v2.3.1, MIT)
LLM-driven scraping pipelines (`SmartScraperGraph`: fetch → html2text → chunk → LLM fills a schema). Not used as a dependency, for these reasons. Each was checked against its `pyproject.toml` and source on `main` on 2026-11-09.

- **Telemetry on by default and it carries our data.** `scrapegraphai/telemetry/telemetry.py` defaults to enabled (`_check_config_and_environ_for_telemetry_flag(True, …)`) and posts prompt, schema, page content, LLM response and source URL to `https://sgai-oss-tracing.onrender.com/v1/telemetry`. It can be disabled with `SCRAPEGRAPHAI_TELEMETRY_ENABLED=false`, but leaking crawled company pages and extracted names by default is unacceptable for this product.
- **Works around site terms.**
  - Its web search (`utils/research_web.py`) scrapes Bing and DuckDuckGo directly with rotating random user-agents.
  - Dependencies include `undetected-playwright` (bot-detection evasion) and `free-proxy` (proxy rotation), plus loaders for the Browserbase and scrape.do unblocking services (`docloaders/browser_base.py`, `docloaders/scrape_do.py`).
  - The standard graphs don't check robots.txt. An optional `RobotsNode` exists for custom graphs only: it fetches robots.txt with Chromium and asks the LLM whether scraping is allowed. That is not a deterministic check.
- **Doesn't fit the stack.** It needs Python ≥3.12, the full LangChain stack and Playwright/Chromium, against our TypeScript engine, 512 MB VPS budget and no-Chromium-on-VPS rule. LLMs go through LangChain, so the `claude` CLI path isn't possible.

**What we take instead:** SPEC §4.4–4.5 already covers the same single-page extraction in TypeScript: our own fetch with robots.txt and rate limits, readability, and Claude with schema-validated output. Because it's MIT, its extraction prompts and chunking approach may be borrowed, with attribution in `NOTICE`.

## Legal (US only)
- **CAN-SPAM:** opt-out regime. Accurate headers, honest subject, physical address, opt-outs honoured within 10 business days.
- **CCPA/CPRA:** disclose IP-based company analytics in the site's privacy policy; sending IPs to an identity graph probably counts as "sharing".
- **California CIPA:** pixel lawsuits mostly target person-level tools; courts are split (*Camplisson v. Adidas* proceeded, *Price v. Headspace* dismissed).
- **Why not the EU:** under GDPR an IP address is personal data (*Breyer*, C-582/14), and Germany's UWG §7(2) requires prior consent for B2B cold email.
