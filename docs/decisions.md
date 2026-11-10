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
