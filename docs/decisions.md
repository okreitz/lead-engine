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
