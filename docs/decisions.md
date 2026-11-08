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

## OPEN, needs Olaf: RDAP in the visitor pipeline
ARIN's RDAP/Whois Terms of Use forbid use "as part of a commercial service or product" and for "marketing research", and every ARIN RDAP response points to them. SPEC §5.2 step 6 uses RDAP as a company-domain fallback. Options:
- (a) drop RDAP and rely on ipapi.is, the form-built IP map and PTR;
- (b) keep it off by default, opt-in for self-hosted non-commercial use only, never in hosted mode;
- (c) ask ARIN for written authorisation.

Proposed: **(a) now, (c) in parallel**. Until decided, Phase 3 builds no RDAP adapter.

## OPEN, needs Olaf: Icypeas and LinkedIn-derived data
Icypeas Find People returns LinkedIn profile URLs and Sales Navigator URNs, and its API sells LinkedIn profile scrapers. CLAUDE.md says not to use vendors that scrape LinkedIn. Options:
- (a) drop Icypeas entirely; LeadMagic starts at $99/mo, Hunter at $49 for 2,000 credits, but their data sources are unchecked;
- (b) keep only email-finder and verifier calls, which take name + domain and return an email, and never call Find People or the scrapers;
- (c) find another finder whose sourcing is clean.

Proposed: **(b) only if you accept the vendor-level risk; otherwise (a)/(c)**. Either way, SPEC §5.1 step 5's Find People fallback is removed. Until decided, no Icypeas adapter is built.

## PENDING: netcup port 25
netcup's default firewall policy blocks SMTP; the live test from the VPS is pending. See the last section of `docs/providers.md` for the command and what each result means for Reacher.
