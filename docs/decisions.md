# Decisions

## 2026-11-08: A separate product, not part of Ground Control
Ground Control is tied to Olaf's Mac (Keychain, launchd, local scan roots), so it can't be shared or sold. The lead engine runs locally and on the netcup VPS through Coolify, holds its own CRM, and Ground Control only shows a Leads card read from `/api/v1/summary`.

## 2026-11-08: AGPL-3.0, paid hosting
The engine is released under AGPL-3.0 and sold as hosting. That lets us reuse code from AGPL projects (Sellbird, OpenGTM, openleads, openenrich) and keeps hosted forks open. Customers bring their own data-provider keys, so we never resell provider data.

## 2026-11-08: US only
To avoid GDPR and Germany's UWG §7 cold-email ban, every entry point accepts US data only. The collector drops non-US visitors before storage, so EU visitors to our own sites are never recorded.

## 2026-11-08: $50/month until a stream proves ROI
All paid calls go through one metered provider layer with a hard monthly cap. Upgrades (ipapi.is API or database, Syften, LeadMagic, RB2B) follow the ladder in SPEC §8.4 only when the ROI view supports them.

## 2026-11-08: Reddit through search, not its API
Reddit's public Data API closes in March 2027, RSS ended in November 2026 and unauthenticated JSON has been blocked since May 2026 (secondary sources, see `docs/research.md`). We find Reddit threads with Serper `site:reddit.com` searches, store only URL, title and snippet, and link out.

## 2026-11-08: Company-level visitor identification only
Naming individual visitors needs a licensed identity graph that can't be built in-house, and it carries California CIPA pixel risk. v1 identifies companies only; RB2B is the upgrade path if visits prove valuable.

## 2026-11-08: Stream 3 first
Persona fit has the most free data (PDL free dataset, SEC EDGAR, SAM.gov) and builds the people and email waterfall that streams 1 and 2 reuse for their accounts.

## 2026-11-08: TypeScript 6, not 7
TypeScript 7.0 is the latest release, but `typescript-eslint` 8.72 supports only `<6.1.0`. We pin `~6.0.3` and revisit when typescript-eslint supports 7. ESLint stays on 9 because `eslint-config-next`'s React plugins aren't confirmed on 10.

## 2026-11-08: Shared package ships TypeScript source; the engine is bundled
`@le/shared` exports `src/index.ts` with no build step. Next.js transpiles it (`transpilePackages`), tsx runs it in dev, and `apps/engine/build.mjs` bundles it into `dist/` with esbuild while npm dependencies stay external. One less build to keep in sync.

## 2026-11-08: Containers bind 0.0.0.0, the host publishes on 127.0.0.1
Inside Docker the services must bind `0.0.0.0`. `deploy/compose.yaml` publishes every port on `127.0.0.1` only, and Coolify's proxy routes the collector domain (public) and the app domain (login). The API on 4501 is never routed publicly. `pnpm dev` binds `127.0.0.1` directly.

## 2026-11-08: The collector never logs client IPs
Request logging is off on the collector listener, and its request serialiser keeps only method and URL. Non-US visitors must be dropped before anything is stored, and logs count as storage.

## 2026-11-08: `claude-cli` adapter runs locked down, with no `--bare`
The adapter passes `--tools "" --disallowedTools "mcp__*" --strict-mcp-config --setting-sources "" --disable-slash-commands --no-session-persistence --json-schema …` from an empty temp directory, with the prompt on stdin. `--bare` would ignore the subscription login, so it's not used. `--max-budget-usd` is checked only after spending, so our own budget check runs first. Details are in `docs/claude-cli.md`.

## 2026-11-08: ipapi.is keys are per workspace in hosted mode
ipapi.is licenses data for the customer's own internal use. The only route for a product serving others is each user calling with their own key (terms §2.9). Hosted workspaces therefore bring their own free or paid ipapi.is key; a self-hosted instance may use one key. The same applies to Serper, whose terms allow one account per customer.

## 2026-11-08: DB-IP Lite is the default country/ASN database
It's CC BY 4.0 and needs no account. IPinfo Lite (CC BY-SA 4.0, token required, adds `as_domain`) is optional; it is downloaded at runtime and never shipped in the image or repo because of ShareAlike. MaxMind GeoLite2 isn't used: its EULA limits use to internal purposes. The UI shows the DB-IP link-back on pages that use lookup results.

## 2026-11-08: Stay inside Serper's free credits until stream 2 shows ROI
The smallest Serper purchase is $50 for 50k credits (valid 6 months), the whole monthly budget. Reddit-via-Serper runs on the 2,500 free queries. A paid pack is a budget decision for the ROI view, and if bought it is amortised over its 6 months in `CostLedger`.

## 2026-11-08: Reacher statuses map onto `emailStatus`
Reacher is MIT since v0.11.9, so the sidecar is fine. Use `/v1/check_email` with `x-reacher-secret`. Mapping: `safe` → `verified`/`pattern_verified`; `risky` + `smtp.is_catch_all` → `catch_all`; other `risky` → `risky`; `invalid` → `invalid`; `unknown` → `unknown`.

## 2026-11-08: Drop LinkedIn-derived fields on import
The PDL free dataset's `linkedin_url` and `id` come from LinkedIn, so they are not imported. We don't scrape LinkedIn and don't want to store its identifiers. The `industry` enum is kept as a label.

## 2026-11-09: Guideline: do what we can without breaking anyone's terms
Olaf's rule for the open Phase 0 items: use every source we can, but never break a provider's or site's terms and conditions. The decisions below apply it.

## 2026-11-09: No ARIN RDAP
ARIN's RDAP/Whois Terms of Use forbid use "as part of a commercial service or product" and for "marketing research", and every ARIN RDAP response points to them. RDAP is removed from SPEC §5.2 step 6. Business IPs resolve to a company through ipapi.is `company.domain`, then the PTR hostname, then our own `IpCompany` map from form fills. We are not asking ARIN for permission for now.

## 2026-11-09: Icypeas email finder and verifier only; no LinkedIn-derived data
Icypeas *Find People* returns LinkedIn profile URLs and Sales Navigator IDs, so it is not used. People come from team, about and leadership page crawling, plus SEC EDGAR officers for public companies. The email finder and verifier break no terms and return only an email, a certainty and a status, so they stay. The data-source rule in CLAUDE.md and SPEC §1/§9 was narrowed (Olaf's decision, confirmed 2026-11-09) from "don't use vendors that scrape LinkedIn" to "never scrape LinkedIn or other ToS-protected sites, and never store or use LinkedIn-derived profile data, including when a vendor returns it". Every provider adapter keeps only the fields we need and drops LinkedIn-derived fields before storage.

## 2026-11-09: Reacher off by default; Icypeas verifier as fallback
Until the VPS port 25 test passes, Reacher sits behind a config flag that defaults to off, and Icypeas email-verification (0.1 credit) is the verifier. When it is enabled it runs at low volume with per-domain throttling. If netcup's default SMTP block is in place, deleting the "netcup Mail block" firewall policy in the server control panel is netcup's own documented option.

## 2026-11-09: Serper free only; Syften dropped; SAM.gov optional
- **Serper:** the Reddit (Serper) sub-cap defaults to $0, so the engine runs on the 2,500 free queries and never buys the $50 pack. Raising it is a manual budget decision.
- **ipapi.is:** each workspace uses its own free key, as its terms require.
- **Syften:** removed from the upgrade ladder (SPEC §8.4, §14). It claims no Reddit licence.
- **SAM.gov:** optional. It needs an API key and allows 10 requests/day, so we use only the monthly public extract.

## PENDING: netcup port 25
Still waiting for Olaf's test on the VPS (`nc -vz -w5 gmail-smtp-in.l.google.com 25`). See the last section of `docs/providers.md`.

## 2026-11-09: The browser talks only to the web app; it proxies `/api/v1` to the engine
`apps/web/src/app/api/v1/[...path]/route.ts` forwards an allowlist of headers to `LE_ENGINE_URL`. The session cookie stays first-party and httpOnly on the web origin, the engine port is never exposed, and `LE_ENGINE_URL` is read at request time so the standalone Docker build needs no rebuild per deployment.

## 2026-11-09: Sessions are random tokens stored as SHA-256, with a per-session CSRF token
argon2id (`@node-rs/argon2`, m=19 MiB, t=2, p=1) for passwords. Cookies are httpOnly, SameSite=Lax, Secure over HTTPS, 30-day absolute and 7-day idle lifetime. Every unsafe method needs `x-csrf-token` matching the session. Bearer tokens (SHA-256 stored) are opt-in per route; read tokens are GET-only.

## 2026-11-09: First-user setup needs `LE_SETUP_TOKEN` off loopback
`POST /auth/setup` works only while no user exists. When the engine binds anything but loopback (Docker, VPS), it also needs `LE_SETUP_TOKEN`, so nobody can claim a fresh public instance first.

## 2026-11-09: Provider keys are AES-256-GCM with workspace and provider as AAD
Format `v1.<iv>.<tag>.<ct>`. Binding the ciphertext to `workspaceId:provider` stops a copied row from decrypting elsewhere. Keys are never returned by the API; without `LE_MASTER_KEY` saving a key answers 503.

## 2026-11-09: No `linkedinUrl` columns
SPEC §3 lists `linkedinUrl` on Company and Contact. Since we never store LinkedIn-derived data, the columns don't exist, so nothing can be written to them by mistake.

## 2026-11-09: One provider pipeline for every paid call, LLM included
`providers/index.ts` runs suppression → per-workspace cache → free quota or budget → call → `CostLedger` → `FieldSource`. LLM calls are the `llm` operation of the same pipeline (`llm/index.ts`), so budget, cache and metering are identical for data providers and models. Failed calls that still cost money (e.g. the CLI's post-spend `--max-budget-usd` stop) are metered too. Every response passes `stripLinkedIn()` before it is cached, returned or stored.

## 2026-11-09: Budget months are UTC calendar months; checks use an upper-bound estimate
A paid call is refused when the month's spend is at the budget or when spend plus the call's worst-case estimate would pass it, so a single call can't overshoot. At 80% the UI warns; at 100% jobs move to `waiting` with the reason and resume at the next month, or immediately when an owner raises the budget or adds a key. Jobs run one at a time per process, so two checks can't race.

## 2026-11-09: Per-stream sub-caps are off by default; provider caps are always on
SPEC §8.1 calls the stream sub-caps optional. They are stored with the SPEC defaults (60/20/10/10%) and enforced only when `settings.enforceSubCaps` is true. Provider caps such as Serper's $0 paid cap are always enforced, so Serper never goes past its free queries.

## 2026-11-09: `anthropic-api` uses `messages.create` with `output_config.format`, then zod
The SDK's `parse()` throws before we can read usage on truncated output. We call `create` with a JSON-schema format from the zod schema at `effort: low`, check `stop_reason` (refusal, max_tokens), record the cost, then JSON-parse and zod-validate. Unknown models are refused because their price is unknown. SDK 1.x sends the key as `Authorization: Bearer`.

## 2026-11-09: Untrusted text goes in escaped `<untrusted_data>` blocks
`llm/prompt.ts` strips control and bidi characters, neutralises any `<untrusted_data`/`</untrusted_data` inside the data, sanitises attributes and caps each block at 12k characters. The system prompt always carries the "data, not instructions" rules. A test checks that the CLI adapter's flags match `docs/claude-cli.md` exactly.

## 2026-11-09: Suppression is a query-time filter, not a status flag
Every list, detail, board and export query adds `NOT EXISTS` guards against the global and workspace suppression lists (`crm/filters.ts`). A domain covers its subdomains and every email at them. Adding an entry hides records at once and removing one restores them, with no batch updates to drift. New contacts with a suppressed email are refused, and CSV imports skip them. The API manages workspace entries; global entries (`workspace_id` NULL) are for the instance operator and are honoured everywhere, but have no UI yet.

## 2026-11-09: The pipeline board moves accounts; deal stages are logged too
SPEC §6's board is per account (`Account.stage`). Deals keep their own stage on the account page. Both kinds of stage change write a `stage_change` Activity with `{from, to}`, which the ROI view will use for attribution.

## 2026-11-09: CSV import is per-row, US-only, and exports neutralise formulas
Each row runs in its own savepoint, so bad rows are reported (row number + reason) without undoing good ones. Accounts need an explicit US country; contacts and deals match accounts by domain. Exports leave out suppressed records, prefix cells starting with `= + - @` to stop spreadsheet formula injection, are audited, and sit behind the CAN-SPAM checklist in the UI.

## 2026-11-09: Crawler without a DOM, with an SSRF guard
`crawler/` uses undici and a regex-based readable-text extractor, with no jsdom or Chromium, which keeps idle memory low. Users type URLs, so the crawler resolves hosts through a `lookup` that refuses loopback, private, CGNAT, link-local and metadata addresses at connect time (no DNS-rebinding gap). It re-checks blocked sites, address and robots.txt on every redirect hop. robots.txt: 4xx = allow, 5xx or network error = disallow (RFC 9309). Limits: 1 request per 2 s per host, 10 s, 2 MB, HTML/text only. Pages go to the LLM only as `<untrusted_data>` blocks.

## 2026-11-09: Offer drafts run as jobs; approved versions are immutable
`POST /offers` creates a `drafting` version and an `offer.draft` job: homepage plus up to 5 same-site key pages (pricing > product > solutions > customers > about), then a zod-validated LLM draft that needs 20–40 intent phrases. A budget stop leaves the version `drafting` with the job waiting and the reason shown. Two invalid outputs mark it `failed`, and both calls are metered. Editing a draft updates it in place; editing an approved version creates a new draft. Approving supersedes the previous approved version and rescores every account. The workspace's active ICP is its most recently approved offer version.

## 2026-11-09: Scoring formulas
- **Fit:** rule points are industry/NAICS 35, size 25, state 15 and tech 15. Unknown fields get half credit, rules that don't apply are left out, avoided tech costs −25, and an exclude match sets fit to 0. When stream 3 writes an LLM `fit` signal, the score is the mean of rules and LLM.
- **Intent:** 100·(1 − e^(−Σ wᵢ·0.5^(ageᵢ/halfLife)/10)), with half-lives of 14 d for visits, 7 d for threads and 30 d for hiring. `fit` signals and expired signals don't count.
- **Priority:** 0.6·fit + 0.4·intent, with fit 0 when there is no approved ICP.
- Every score stores its top 3 reasons. Accounts are rescored when created, imported or rescored by hand, when an offer version is approved, and hourly for decay.

## 2026-11-09: `GET /api/v1/summary` attributes ROI by first source
It accepts a read token and covers the current UTC week (from Monday) and month. The ROI rows are per `Account.firstSource`: spend from `CostLedger.stream`, accounts created, qualified (fit ≥ threshold and stage from Contacted on, excluding Lost), reply and meeting activities, and won deals with value. Threads are counted from `conversations` signals until stream 2 adds the Thread table. Suppressed accounts are left out.

## 2026-11-09: `pnpm rss` measures production builds
It builds the engine bundle and the Next standalone server, starts both on spare ports with a throwaway DB, and warms them up (setup, 20 accounts, every page and the main API routes). After 20 s idle it takes the peak of 5 `ps` samples per process tree and fails over 512 MB. First result in the Linux container (Node 22): engine 98.8 MB + web 91.7 MB = **190.5 MB**.

## 2026-11-09: Coolify deploy: no published ports, required secrets, a login gate on every page
`deploy/compose.yaml` targets Coolify's Docker Compose build pack: services only `expose` ports and Coolify's proxy routes the domains (web :4500 now, collector :4511 in Phase 3; the API :4501 is never routed). `LE_MASTER_KEY` and `LE_SETUP_TOKEN` use `${VAR:?}`, so Coolify won't deploy without them. Local runs add `deploy/compose.local.yaml`, which publishes on 127.0.0.1. `apps/web/src/proxy.ts` redirects every page without a session cookie to `/login`; the engine still validates every API call. Steps are in `deploy/coolify.md`.

## 2026-11-09: The UI follows docs/ui.md
Before building any screens, we researched the UIs of Apollo, ZoomInfo, Clay, Common Room, Octolens, Leadfeeder, RB2B, Warmly, 6sense, Attio, Twenty, HubSpot and Linear. The main complaints were credit anxiety, untrusted data, black-box scores and clutter. So every score shows its reasons, every enriched field shows its source, every paid action shows its cost first, the sidebar has at most 8 items, and the app opens on a Today page. Details and sketches are in `docs/ui.md`.

## 2026-11-10: LLM offer drafts are reviewed field by field before approval
The draft model now returns a one-sentence `rationale` per field, stored apart from the profile in `offer_versions.rationale`. A finished LLM draft starts with `review = {}`, and approval answers 409 `unreviewed` until each of the 15 review fields (name, summary, value props, competitors, the 9 ICP fields, personas, intent phrases) is accepted, edited or rejected. Rejecting a field reverts it to the last approved value (or empties it). Versions a person creates by editing an approved one have `review = null` and need no review.

## 2026-11-10: The offer preview counts only the workspace's own companies
`POST /offers/preview` runs the rule-based fit (no LLM, no paid calls) over the workspace's non-archived accounts, without suppressed domains. It returns how many reach the fit threshold, the top 5 states and 5 sample names. `companies` is shared across workspaces, so a wider "market" count would reveal other workspaces' records; Phase 2's persona-fit source can add a market count later.

## 2026-11-10: Paid actions show an estimate and confirm only when costly
`needsCostConfirm` in `@le/shared`: confirm when the estimate is over $1 or over 10% of the month's remaining budget; otherwise the estimate is shown next to the button and the action runs. The offer draft estimate is the upper bound the budget check uses (every page at its size cap plus the full output allowance). The budget stop at 100% still applies on the engine side.

## 2026-11-10: ROI forecast is linear; ledger rows say what was charged
The month-end forecast is spend ÷ elapsed share of the UTC month, with at least one day counted as elapsed. Stream bars compare spend with the sub-cap shares (shown even when not enforced). LLM spend also counts in its stream, as the budget check does. `GET /ledger` labels each row `paid`, `free_quota` or `not_charged` (usd 0 without a free quota, e.g. a miss), and links it to its record, resolved only within the workspace.

## 2026-11-15: Deploys run from GitHub Actions over Tailscale
Coolify only listens on the tailnet and can't receive GitHub webhooks, and cloud build sessions can't reach it. After CI passes on `main`, `deploy.yml` joins the tailnet as an ephemeral `tag:ci` node (Tailscale OAuth client), calls Coolify's deploy API and waits for the result. Without its five secrets it skips, so it never turns CI red. Coolify's dashboard stays off the public internet.

## 2026-11-15: No Mac in the loop; the company universe is imported on the VPS
Olaf's decision: everything is built in cloud sessions and runs on the VPS. The universe import (SPEC §5.1 step 1) is the `universe.import` engine job, started from Settings → Company data or the API. It downloads to the data volume with HTTP Range resume and stream-parses in ~15 s slices (`ContinueJob` puts the job back in the queue without using an attempt), filtering to US + website + ICP while reading and writing 1,000 rows per transaction together with the resume checkpoint. PDL has no fixed URL, so the owner pastes PDL's emailed link or copies the file into `/data/imports`. Measured: 1M rows in 5 min, peak RSS +80 MB over the idle process.

## 2026-11-15: ROI checkpoints are measured after go-live
They need real outreach and weeks of replies, so they don't block finishing a phase. Each phase's ROI checkpoint is read from the ROI view after go-live.

## 2026-11-15: Universe companies are flagged and carry per-field origins
`companies.universe` marks rows a public dataset listed; the ICP filter and any market counts read only those, so companies another workspace typed in or matched from visits stay private. Imports fill only empty fields and record the dataset per field in `companies.origins` (a person's edit sets `manual`); the account page turns these into source dots with the dataset's licence, which is how the CC BY 4.0 attribution reaches the UI. EDGAR only tags existing companies by unique normalised name, since it has no websites.

## 2026-11-15: Find matching companies = ranked SQL candidates, then a sliced fit job
The ICP filter runs in SQL over universe companies (industry phrase or word LIKE, NAICS prefix, size overlap with unknown sizes allowed, states, founded years, exclusions), skipping suppressed domains and existing accounts; up to 4× the limit are ranked by the rule-based fit and the top N (default 500) are stored as the run's candidates. The `persona.fit` job fetches homepages 5 at a time (robots.txt, per-host throttle), runs `httpx -td` on those already fetched, then one LLM call per candidate. Final fit = mean(rules, LLM), and at or above the workspace threshold the company becomes an account with a `fit` signal. The model's quote is kept only if it appears verbatim on the page. The estimate is the per-call budget upper bound × candidates, and `needsCostConfirm` decides the dialog.

## 2026-11-15: httpx is optional and locked down
`commands.ts` accepts only `-silent -json -td -duc -nc -fr -version` and numeric `-timeout -rl -t -maxr -retries` plus a `User-Agent` header; targets go on stdin. `-pd` (cloud upload) and `-ss` (Chrome) can't be passed. `LE_HTTPX_BIN` points at ProjectDiscovery's binary because Python's `httpx` package installs a CLI with the same name. The image doesn't ship httpx; without it, runs note "Technographics skipped" and continue.

## 2026-11-15: People come from the company's own pages and EDGAR, matched to personas
`people.find` reads up to 3 team/about/leadership pages (homepage nav + sitemap), and the LLM returns name, title, source page and persona. A person is kept only if their name appears on the page they cite; an unknown persona falls back to title-keyword matching. Public companies add Form 3/4/5 officers from EDGAR (`isOfficer`, true/false or 1/0). Every contact field gets a FieldSource: name/title/email from the page or filing, `personaMatch` from the LLM or keywords, seniority from title rules, department from the persona. No people-search vendor.

## 2026-11-15: Email waterfall and statuses
Candidates: an address the site publishes for that person, else the domain's pattern learned from published addresses (`companies.email_pattern`), else the top 3 permutations. Reacher verifies when `LE_REACHER=on` (free, one check per domain per minute; a throttled check reschedules the job instead of sleeping), else Icypeas verification (0.1 credit). Invalid → next candidate; catch-all, risky or unknown → stop, and only catch-all/unknown go to the Icypeas finder (1 credit, only when found). Icypeas `not_found` on verification can't separate catch-all from unknown, so it maps to `unknown`; `probable` maps to `risky`; a verified generated address is `pattern_verified`, a verified published or found one `verified`. A rejected Icypeas key or empty credits fails the job permanently with that message. Without any verifier, only published or pattern addresses are stored, as `unknown`.

## 2026-11-15: Reacher is an opt-in compose profile, pinned to v0.11.11
`reacherhq/backend:latest` still points at the pre-MIT v0.11.8, so the tag is pinned. The image bundles Chromium for some headless checks, so it is never in the default stack: it runs only with `--profile reacher` and `LE_REACHER=on`, after the port 25 test. A Chromium-free build from the MIT source is the alternative if that matters.

## 2026-11-15: Hiring signals from public ATS boards linked on the site
Greenhouse, Lever and Ashby boards linked from the company's homepage, team or careers page are read through their public job-board APIs (the documented, unauthenticated GET endpoints). Postings whose titles match a persona become `hiring` signals (weight 3, 60-day expiry, 30-day half-life) with the posting URL as evidence. Their third-party terms weren't found ([unverified] in providers.md); we only read listings the companies publish for applicants, at one request per board.

## 2026-11-15: Phase 2 acceptance runs on fixtures
`test/acceptance.test.ts` runs 600 fixture companies through a 500-candidate run with people and emails on, using the fake crawler, LLM ($0.001/call) and Icypeas: 375 accounts with reasons, 1,125 contacts from team pages, 1,109 with an email (verified, pattern_verified, risky, unknown), $6.44 of the $20 test budget, a source on every contact field and no LinkedIn data. A real-provider run needs `LE_E2E=1` and keys, and is open.

## 2026-11-15: Amazon SES Email Validation as an optional verifier; no SES sending
Olaf approved it for Phase 2. The waterfall is pattern → Reacher (flag) → SES → Icypeas, with Icypeas verification used only when neither Reacher nor SES is configured and the Icypeas finder only for catch-all or still-unknown results. A verifier's risky or unknown answer passes the address to the next one; valid, invalid or catch-all ends the chain. SES `GetEmailAddressInsights` costs $0.01 per address, reports LOW/MEDIUM/HIGH confidence per check and has no catch-all signal (mapping in `docs/providers.md`), and AWS throttles non-sending SES calls to 1 per second, which the adapter respects. Credentials are BYO per workspace (access key ID, secret, region as one encrypted value) and need only `ses:GetEmailAddressInsights` on `*`. The request is signed with aws4fetch (MIT, 65 KB, no dependencies) instead of `@aws-sdk/client-sesv2` (24 packages, 19 MB installed). **SES sending stays out of scope** (SPEC §14): AWS's Acceptable Use Policy forbids sending or facilitating unsolicited mass email. The AUP doesn't say whether validating cold-outreach addresses counts as "facilitating"; that judgement is Olaf's, which is why SES is optional and off until a key is saved.

## 2026-11-15: Provider key help has one source
`PROVIDER_HELP` in `packages/shared` holds, per key or setting, what it is for, its cost or free tier, a checked link to where it is created (or the vendor's docs page when there is no direct page, marked as such) and the minimum scope. Settings → Provider keys, Company data, job wait reasons and missing-key messages read it, and `pnpm docs:keys` writes the "Getting your keys" table in `docs/providers.md`; a test fails when the table is stale. External links open in a new tab with `rel="noopener noreferrer"`.


## 2026-11-15: Reacher lives in its own compose file
The first Phase 2 deploy failed on Coolify. The cause turned out to be config (next entry), but Coolify builds from `deploy/compose.yaml`, and an opt-in `profiles` service there can't be relied on to stay off either. So the Chromium-bundling Reacher image moved to `deploy/compose.reacher.yaml`, run only after the port 25 test. The deploy workflow now prints the last lines of Coolify's deployment log when a deploy fails.

## 2026-11-15: Empty environment variables count as unset
Compose passes unset optional variables as `${VAR:-}`, i.e. an empty string. An empty `LE_SEC_USER_AGENT` failed config validation, so the Phase 2 engine stopped at startup and the Coolify deploy failed (reproduced locally). `loadConfig` now drops empty values before validating; a test covers it. The same fix is in the Phase 3 branch.

## 2026-11-15: The collector reads the client IP from X-Real-Ip, and only from the proxy
Coolify routes domains through Traefik. Traefik deletes every `X-Forwarded-*` and `X-Real-Ip` header a client sends (it trusts no upstream by default) and sets `X-Real-Ip` to the TCP peer it saw (`pkg/middlewares/forwardedheaders`, Traefik v3.6), so the value can't be spoofed and is a single address, unlike `X-Forwarded-For`. The collector reads it only when the request comes from a loopback or private address (the proxy on the Docker network); any other peer's socket address is used instead. `LE_CLIENT_IP_HEADER` changes the header name. A CDN in front (e.g. Cloudflare's orange cloud) would make every visitor look like the CDN, so the collector DNS record must be DNS-only.

## 2026-11-15: The collector answers first, then classifies in memory
`/collect/v` and `/collect/identify` validate the body (2 KB, strict schema), the site key, Origin (or Referer) against the site's domain and subdomains, and the per-IP (60/min) and per-site (3,000/min) limits, then answer 202 and queue the event in an in-memory queue (1,000 max, 503 beyond). The pipeline writes nothing until a visit is matched; every outcome increments `visit_daily(site, day, outcome)`, the only trace dropped traffic leaves. Sessions are counted once per daily session hash, which is held in memory for the day only. Unknown location fails closed (`unclassified`).

## 2026-11-15: A short local ASN list runs before ipapi.is
DB-IP and IPinfo Lite carry an AS number but no type, so `collector/asn-types.ts` lists large US hosting, mobile and residential-ISP networks (AWS, Hetzner, Comcast, T-Mobile, …). A hit drops the visit without using the 1,000 free ipapi.is lookups. Mixed backbones that also sell business lines (Lumen, Verizon Business 701, AT&T 7018) and companies that browse from their own ASN (Google 15169, Microsoft 8075) are left to ipapi.is. The IpCompany map is checked first, so form fills still identify companies behind any of these networks.

## 2026-11-15: ipapi.is: key in the POST body, free tier only, own 30-day cache
Lookups are `POST https://api.ipapi.is` with `{q, key}`, which the developer page recommends to keep keys out of URLs and logs. The adapter has a 1,000/day free quota and a $0 paid cap, so it never buys credits; beyond the quota visits are `unclassified`. Results are trimmed to the fields the pipeline uses (no abuse contacts, no coordinates) and cached 30 days in `ip_lookup_cache` per workspace (their terms §2.2, and BYO data isn't shared). 403 and 429 pause lookups for that workspace for an hour, since ipapi.is bans clients that keep sending.

## 2026-11-15: The IP map: company prefixes, PTR hosts, and form fills only from business IPs
A company match from ipapi.is maps the IPv4 /24 (IPv6 /48) around the visitor, narrowed until it fits inside the company's own registered network, for 30 days at confidence 0.8. A PTR match maps only the single address (/32, /64) at 0.5, and ISP-generated hostnames (static-1-2-3-4, dsl, cable, pool, …) and hosting/ISP domains never count. `/collect/identify` maps the company prefix at 0.95 for 90 days, but only when the IP classifies as a business: on ISP, mobile, hosting or VPN addresses a prefix is shared by unrelated people (and a home address mapped to an employer would be person-level data), so those form fills are ignored. "Wrong company" sets `wrong` on the row, which then blocks that domain for that prefix.

## 2026-11-15: Session hashes use a random daily salt that is deleted the next day
`sessionHash` = HMAC-SHA256(salt, site + IP + user agent), truncated to 128 bits. The salt is random per UTC day and stored in `daily_salts` only for that day; the first event of a new day deletes the old one. A hash can't be recomputed afterwards, even with the IP and the instance secrets, and sessions can't be linked across days.

## 2026-11-15: The snippet: path only, no cookies, honours GPC and DNT
`p.js` sends the path without its query string (query strings carry emails and tokens), the external referrer without its query, and UTM values, as a `text/plain` `fetch` with `credentials: 'omit'` and `mode: 'no-cors'` (a simple request: no preflight, no cookies). It sends nothing when the browser signals Global Privacy Control or Do Not Track; CCPA treats GPC as an opt-out. `window.leIdentify(email)` sends only the domain. It hooks `history.pushState` for single-page apps.

## 2026-11-15: Visiting companies become US accounts; people jobs are capped
A business IP located in the US is taken as a US company (`createAccount` with country US); an existing non-US company record is refused and counted `non_us`. A newly created account at or above the fit threshold queues `people.find` with emails when an offer is approved, the budget isn't reached, it has no contacts and no pending job, and fewer than 20 visit-triggered people jobs were queued in the last 24 hours.

## 2026-11-15: `pnpm rss` with stream 1
The warm-up now loads the real DB-IP Lite databases (downloaded into the throwaway data folder, or `--geo-dir`), adds a site and sends 300 collector page views before idling. Linux container, Node 22: engine 121.2 MB + web 96.0 MB = **217.2 MB** with the databases already on disk, and engine 156.5 MB + web 96.1 MB = **252.6 MB** right after the engine downloaded and gunzipped them itself (the download leaves a higher RSS watermark until the next restart). The two .mmdb files are read into one Buffer each (~18 MB) and decoded lazily with a 2,000-record cache.

## 2026-11-16: Stream 2 runs as scheduled jobs plus one Bluesky connection
A one-minute scheduler queues `conversations.poll` per source and workspace when due (HN 15 min, Stack Exchange hourly, GitHub and Reddit daily) and `conversations.score` while threads wait. Polls run in ~20 s slices (`ContinueJob`) so they never block other jobs; a source error, a missing key or a used-up free quota is shown on the source and retried later, never failing the queue. Sources run only for workspaces with an approved offer. Bluesky is one Jetstream connection for the whole engine, opened only while a workspace needs it, matched locally against every workspace's phrases; deletion events remove stored posts. `LE_BLUESKY=off` turns it off.

## 2026-11-16: Free APIs with keys go through the provider layer; HN and Bluesky don't
Stack Exchange, GitHub and Serper calls are provider-layer adapters: counted against a free quota (SE 10,000/day, GitHub 5,000/day, Serper 2,500 lifetime) with a $0 paid cap, so they appear in the ledger at $0 and a used-up grant stops the source instead of spending. HN and Bluesky need no key and have no quota to meter, so they call out directly. All three keys are BYO per workspace and the sources wait without them.

## 2026-11-16: Stack Exchange key as `key=`
The 2025 Stack Apps help says to send an API key as the `key` query parameter; the older docs page says `Authorization: Bearer`. Live, the API reads both (an unknown key is reported as an unknown application, an unknown Bearer value as an invalid access token). We follow the newer page; the `LE_E2E=1` test checks it with a real key.

## 2026-11-16: The prefilter is word-window matching with per-phrase negatives
A phrase matches when its words (stop words dropped, plurals folded) all appear within max(6, 3 × words) tokens, or verbatim; any negative keyword vetoes that phrase. Search APIs (GitHub especially) match loosely, so every hit is re-checked locally, and the Bluesky firehose is cut to a handful of posts a day. Bluesky stores at most 300 matches per workspace per day, and the scorer at most 300 threads per workspace per day (`settings.conversations.dailyScoringCap`).

## 2026-11-16: Threads store redacted excerpts; companies only from the poster's own words
Excerpts (1,200 chars) have emails and phone numbers removed before storage or scoring. Reddit keeps only URL, title and Serper's snippet and no author; Bluesky keeps the DID, never a resolved handle. The LLM's `companyMentioned` is kept only if the name appears in the post, and "Create account" needs it to resolve to an existing US `Company` (by domain, else one unique name match) that isn't suppressed. The account gets `firstSource = conversations` and a `thread` signal (weight 3 for intent 2, 5 for intent 3).

## 2026-11-16: Thread retention and feedback
Unactioned threads (state `new` or `dismissed` without feedback) are deleted 90 days after posting, hourly. `X` dismisses with `not_relevant` feedback, `R` marks replied with `good` (unless set otherwise), and both are kept: the three newest of each verdict go into the scoring prompt as few-shot examples, inside an untrusted-data block. Self-promotion posts stay out of the Priority tab but appear in All.

## 2026-11-16: `pnpm rss` with the Bluesky Jetstream open
The warm-up now writes an approved offer into the throwaway database, turns the polled sources off (they would call HN and an LLM) and waits until the engine's Jetstream connection is reading real posts; the run fails if it closes while sampling. Linux container, Node 22, DB-IP databases downloaded by the engine: after 20 s idle, engine 199.6 MB + web 96.5 MB = **296.1 MB** (1,086 posts read); after 180 s idle, engine 164.9 MB + web 96.9 MB = **261.7 MB** (6,319 posts read). So Bluesky adds roughly 10–40 MB over Phase 3's 252.6 MB, and RSS doesn't grow over time.

## 2026-11-16: The Anthropic API is the default LLM adapter
The first real offer draft on the VPS failed with "claude CLI returned no JSON (exit -1)". A workspace with no saved setting fell back to the `claude` CLI unless the instance had `ANTHROPIC_API_KEY`, ignoring the workspace's own key, and the CLI isn't in the Docker image. The settings page already showed the API as the default. Now an unsaved setting means the API; the CLI is chosen only explicitly (local mode), and a CLI that can't start says to switch adapters.

## 2026-11-16: Workspace logo in its own table, PNG/JPEG/WebP only
Each workspace can upload a sidebar logo (Settings → General). The bytes live in `workspace_logos`, not `workspaces`, so they never load with the workspace row; `/auth/me` only reports `logoUpdatedAt`, which the image URL uses as its cache key. SVG is refused because it can carry script; the type is checked by magic bytes and served with `nosniff` and `default-src 'none'`.
