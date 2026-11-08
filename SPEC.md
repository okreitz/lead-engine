# Lead Engine — Build Spec (v1)

A self-hosted engine that finds US B2B leads from three streams and keeps them in its own lean CRM.
Working name: **Lead Engine** (`le`). Runs locally on Olaf's Mac and on the netcup VPS (Coolify).
Open source under **AGPL-3.0**; the business model is paid hosting.

First users: &Human, &Human / okreitz consulting, and Olaf's new ventures. Each is a **workspace**.

---

## 1. Goals

1. **Stream 1, website intent:** identify which US companies visit a workspace's websites, then find the right people there.
2. **Stream 2, conversation intent:** find people publicly asking for what a workspace sells (Hacker News, Bluesky, Stack Exchange, GitHub, Reddit via search) and surface the thread.
3. **Stream 3, persona fit:** from a workspace's product, derive its ideal customer profile (ICP) and buyer personas, then find matching US companies and contacts.
4. **One lean CRM:** every lead from every stream lands on one account, with one score and a full signal timeline.
5. **Prove ROI before spending:** at most **$50/month** in paid data and LLM costs until a stream shows a return. Every paid call is metered.

### Non-goals for v1
- Sending email or sequences (later, see §14).
- Identifying individual website visitors by name (RB2B-style). Company-level only.
- Scraping LinkedIn, Reddit, G2 or any site whose terms forbid it.
- Linking a Reddit, Hacker News or Bluesky username to a real person.
- Any market outside the US.
- Billing and self-serve signup (Phase 5 designs for them).

### Hard constraints
- **Budget:** $50/month in total across paid providers and LLM API calls, enforced in code (§8).
- **US only:** enforced in code at every entry point (§9).
- **Memory:** the netcup VPS has 2 vCore and 4 GB RAM, shared with Coolify, Hermes (1 GB) and other apps. Web plus engine must stay under **512 MB RSS** idle on the VPS. No Chromium on the VPS by default. SQLite only, no Postgres or Redis.
- **Two run modes, one codebase:** `pnpm dev` on the Mac, and one Docker Compose stack on Coolify.
- **Licence hygiene:** copy code only from licences compatible with AGPL-3.0 (MIT, BSD, Apache-2.0, GPL-3.0, AGPL-3.0), with attribution in `NOTICE`. Repos with no licence are design references only (§13).

---

## 2. Architecture

```
                      Internet (workspace websites)
                                 │  pixel / beacon, HTTPS
                                 ▼
┌──────────────────────── netcup VPS (Coolify) ─────────────────────────┐
│  collector  :4511  (public, no auth, write-only, rate-limited)        │
│       │ in-process queue                                              │
│       ▼                                                               │
│  engine (Fastify) :4501 ── SQLite (/data/le.db)                       │
│   ├─ api/          REST + SSE for the web app, token or session auth  │
│   ├─ jobs/         SQLite-backed job queue + scheduler                │
│   ├─ streams/      visits · conversations · personas                  │
│   ├─ providers/    ipapi.is, Icypeas, Serper, … (metered)             │
│   ├─ llm/          claude CLI (Mac) or Anthropic API (VPS)            │
│   ├─ crm/          accounts, contacts, deals, activities              │
│   └─ commands.ts   allowlisted external binaries (httpx, claude)      │
│  web (Next.js) :4500  (behind login; Tailscale or HTTPS)              │
│  reacher (optional sidecar) :8080, internal only                      │
└───────────────────────────────────────────────────────────────────────┘
          ▲ Tailscale: read-only summary API
          │
   Ground Control (Mac): "Leads" card
```

- **The collector is a separate listener** so that the only public, unauthenticated surface is tiny and write-only. Everything else is behind authentication.
- **Local mode:** the same processes run on the Mac, bound to `127.0.0.1`. Heavy one-off jobs, like importing the company universe or browser crawling, run on the Mac and sync results to the VPS through the API.
- **Ground Control** shows a Leads card by reading `GET /api/v1/summary` with a read-only token. Ground Control holds no CRM data.

### Tech stack
- **Language:** TypeScript everywhere. pnpm workspace with `apps/web`, `apps/engine`, `packages/shared` (zod schemas, types). Same conventions as Ground Control.
- **UI:** Next.js (App Router), Tailwind, shadcn/ui, TanStack Query, dnd-kit for the pipeline board.
- **Engine:** Node 22+, Fastify, `undici` for HTTP, `execa` for allowlisted binaries, `maxmind` for reading `.mmdb` files, `isbot` for bot filtering.
- **DB:** SQLite through Drizzle with checked-in migrations; FTS5 for search; WAL mode. Nightly `VACUUM INTO` backups, 7 kept.
- **Jobs:** a small SQLite-backed queue (table `Job`) with retries, backoff and per-provider concurrency. No Redis.
- **Secrets:**
  - Instance secrets come from environment variables: Coolify secrets on the VPS, Keychain-loaded env on the Mac.
  - Workspace provider keys (bring-your-own) are stored AES-256-GCM-encrypted in SQLite under `LE_MASTER_KEY`.
  - Secrets never appear in logs, the repo or committed `.env` files.

---

## 3. Data model (SQLite)

```ts
Workspace       { id, name, slug, allowedCountries=['US'], monthlyBudgetUsd=50, timezone, createdAt }
User            { id, email, passwordHash, createdAt }            // argon2id
Membership      { userId, workspaceId, role: 'owner'|'member' }
ProviderKey     { workspaceId, provider, encryptedKey, createdAt } // BYO keys

// Product profile: the input to streams 2 and 3
Offer           { id, workspaceId, name, websiteUrl, summary, valueProps[], competitors[],
                  icp: { industries[], naics[], employeeRange, revenueRange?, states[], techUses[], techAvoids[],
                         mustHave[], exclude[] },
                  personas: { title, seniority, department, pains[], titleKeywords[] }[],
                  intentPhrases: { phrase, kind: 'seeking'|'alternative'|'pain'|'recommendation', negative[] }[],
                  version, approvedAt? }            // generated by LLM, edited and approved by a human

// Company universe: raw imported companies, not yet in the CRM
Company         { id, domain (unique), name, country, state?, city?, industry?, naics?, sizeRange?,
                  foundedYear?, linkedinUrl?, sources[], tech[], techCheckedAt?, updatedAt }

// CRM
Account         { id, workspaceId, companyId, stage, ownerUserId?, fitScore?, intentScore, priority,
                  firstSource: 'visits'|'conversations'|'personas'|'manual', firstSourceAt,
                  status: 'active'|'suppressed'|'archived', createdAt, updatedAt }
Contact         { id, workspaceId, accountId, fullName, title?, seniority?, department?, personaMatch?,
                  email?, emailStatus: 'verified'|'pattern_verified'|'risky'|'catch_all'|'unknown'|'invalid'|null,
                  linkedinUrl?, phone?, status: 'active'|'suppressed', createdAt }
FieldSource     { entity, entityId, field, source, url?, fetchedAt, confidence }   // provenance per field
Deal            { id, workspaceId, accountId, name, stage, valueUsd?, closedAt?, outcome?: 'won'|'lost' }
Activity        { id, workspaceId, accountId?, contactId?, dealId?, kind: 'note'|'email'|'call'|'meeting'|'reply'|'stage_change',
                  body, at, userId? }
NextStep        { id, workspaceId, accountId, text, dueAt, doneAt? }

// Signals: everything a stream observes
Signal          { id, workspaceId, accountId?, stream, kind, weight, occurredAt, payload(json), evidenceUrl?, expiresAt }
//   visits:        kind 'visit' | 'pricing_view' | 'demo_view' | 'form_identify'
//   conversations: kind 'thread'
//   personas:      kind 'fit' | 'hiring' | 'tech_change'
Thread          { id, workspaceId, source, url (unique per workspace), title, excerpt, author, postedAt,
                  intent: 0|1|2|3, pain?, stage?, suggestedReply?, companyMentioned?, state: 'new'|'replied'|'dismissed'|'converted',
                  feedback?: 'good'|'not_relevant', expiresAt }
Site            { id, workspaceId, domain, siteKey, createdAt }                      // where the pixel runs
Visit           { id, siteId, accountId?, sessionHash, path, referrer?, utm?, at }   // only for matched visits
IpCompany       { prefix (CIDR), companyDomain, source: 'form'|'rdap'|'ptr'|'asn'|'provider', confidence, seenAt, expiresAt }
IpLookupCache   { ip, result(json), fetchedAt }                                      // 30-day TTL

// Control
Suppression     { workspaceId|null, kind: 'email'|'domain', value, reason, createdAt }  // null = global
CostLedger      { id, workspaceId, provider, operation, units, usd, stream, jobId?, at }
Job             { id, workspaceId, type, payload, state, attempts, runAt, lastError? }
AuditLog        { id, workspaceId?, userId?, action, target, at, details }
```

---

## 4. Shared core

### 4.1 Offer profile
1. The user enters a website URL (and optionally notes or competitors).
2. The engine fetches the homepage, plus up to 5 linked pages (pricing, product, customers, about), as readable text.
3. The LLM returns an `Offer` draft as schema-validated JSON: summary, ICP, personas, 20–40 intent phrases with negative keywords, and competitors.
4. A human edits and approves it. Streams 2 and 3 only run on an approved offer version. Changing it creates a new version.

### 4.2 Scoring
- **Fit (0–100):** firmographic rules from the ICP (industry, size, state, tech), plus the LLM's homepage fit score with reasons. Recomputed when the offer version changes.
- **Intent (0–100):** sum of signal weights with exponential decay. Half-lives: visits 14 days, threads 7 days, hiring 30 days. Capped and normalised.
- **Priority** = `0.6·fit + 0.4·intent` (weights configurable per workspace).
- Every score stores the top 3 reasons, so the UI can say *why*.

### 4.3 Provider waterfall
- Each paid operation is a typed provider call: `findEmail`, `verifyEmail`, `findPeople`, `ipLookup`, `serpSearch`, `llm`.
- Each call goes through `providers/index.ts`, which:
  1. checks suppression,
  2. checks the cache,
  3. checks the workspace budget and the provider's free quota (§8),
  4. calls the provider,
  5. writes `CostLedger`,
  6. writes `FieldSource`.
- Waterfalls are ordered lists per operation, cheapest first, and stop at the first confident result. Example `findEmail`: pattern + Reacher → Icypeas → (later) LeadMagic.
- Providers that bill only on success are preferred.

### 4.4 LLM adapter
- **`claude-cli`:** local mode. Only ever the official `claude` binary in headless print mode, run through `commands.ts`. Flags must come from a verified `docs/claude-cli.md` (Phase 0), never guessed. Never read, copy or proxy Claude credentials.
- **`anthropic-api`:** VPS and customers. The cheapest current Haiku model by default (configurable), low effort, structured JSON output, Batch API for non-urgent scoring.
- Every prompt takes untrusted text in a delimited data block. The model gets **no tools**, and only zod-validated output is used.
- A per-call token budget is enforced, and usage goes to `CostLedger`.

### 4.5 Crawler
- Plain HTTP fetch plus readability extraction. Browser (Playwright) only in local mode as an opt-in fallback.
- Obeys `robots.txt`, sends User-Agent `LeadEngineBot/<version> (+<project url>)`, at most 1 request per 2 seconds per host, 2 MB page cap, 10 s timeout.
- Never crawls LinkedIn, Reddit, G2, Capterra, Glassdoor or Facebook directly.

---

## 5. The three streams

### 5.1 Stream 3: persona fit (built first)

1. **Company universe import** (Mac job, re-run quarterly):
   - People Data Labs free company dataset (CC BY 4.0), filtered to `country = US` with a website.
   - SEC EDGAR company list.
   - SAM.gov entity extract.
   - Overture Places (US, with website) for local businesses.
   - Each source is normalised by domain and merged into `Company`. Only the ICP-matching subset is synced to the VPS.
2. **ICP filter:** SQL over `Company` by industry/NAICS, size, state and founded year. The result is a candidate list (default 500 per run).
3. **Technographics** (optional per ICP): `httpx -td` over the candidates' homepages through `commands.ts`. HTTP Archive (BigQuery) lookups are optional when a GCP project is configured.
4. **Fit scoring:** fetch the homepage, then the LLM returns fit 0–100, reasons and a short evidence quote. Candidates at or above the threshold (default 60) become `Account`s with a `fit` signal.
5. **People:**
   - Discover team, about, leadership and company pages from the sitemap and nav links.
   - The LLM extracts `{name, title, sourceUrl}` and matches the titles to personas.
   - Fallback: Icypeas *Find People* for the persona titles, within budget.
   - For public companies, add officers from EDGAR.
6. **Email:**
   1. Learn the domain's email pattern from addresses published on its site.
   2. Generate permutations.
   3. Verify with Reacher (`deliverable` / `risky` / `catch_all` / `unknown`).
   4. Only `catch_all` and `unknown` go to Icypeas email-finder, within budget.
   5. Store each result with an `emailStatus` and a source.
7. **Hiring signal** (optional): career pages and ATS job boards (Greenhouse, Lever, Ashby public JSON) for roles that match the offer's pain points. No LinkedIn.

### 5.2 Stream 1: website visits

**Snippet.** One `<script async src="https://<collector-host>/p.js" data-site="<siteKey>">`, plus a `<noscript>` 1×1 pixel. It uses no cookies, no localStorage and no fingerprinting. It sends path, referrer, UTM parameters and timestamp.

**Collector pipeline.** This runs in memory, and nothing is written until a request passes every step:
1. Validate `siteKey`, schema, body size (2 KB) and rate limit. Read the client IP only from the proxy header that Coolify's proxy sets.
2. `isbot` user-agent check → drop.
3. Country lookup from a local free `.mmdb` (IPinfo Lite or DB-IP Lite). **If not US, drop.** Only an aggregate daily counter is kept.
4. Check the `IpCompany` map (most specific prefix). On a hit, go to step 7.
5. Classify the IP:
   - ASN type from the free ASN database first.
   - Then ipapi.is (free tier, 1,000 per day, cached 30 days in `IpLookupCache`).
   - **ISP, mobile, hosting and VPN → drop**, counter only.
6. For business-type IPs:
   - Company domain from ipapi.is `company.domain`, else RDAP (most specific record), else PTR record.
   - Write an `IpCompany` row with its source and confidence.
7. Resolve the domain to a `Company`, upsert the `Account` (`firstSource = visits`), and write a `Visit` plus a `Signal`. Pricing, demo and contact pages carry extra weight.
8. A new account at or above the fit threshold queues the stream 3 *people + email* job (budget permitting).

**Own IP map.** `POST /collect/identify` with `{siteKey, emailDomain}` is called from the site's form handler. It maps the visitor's IP prefix to the company domain with high confidence for 90 days. Free-mail domains are ignored. This map grows over time, and it is the main way match rates improve.

**Stored data:**
- Raw IPs are kept only inside `IpCompany` prefixes (company network ranges) and `IpLookupCache` (30-day TTL).
- `sessionHash` = HMAC(IP + user-agent + date), rotating daily. It can't be reversed or carried across days.

**Metrics:** sessions, US share, business share, match rate, and accounts per week, all per site.

### 5.3 Stream 2: conversation intent

**Sources** (each one is an adapter with `poll()` or `stream()`):

| Source | Method | Schedule |
|---|---|---|
| Hacker News | Algolia `search_by_date` per phrase | every 15 min |
| Bluesky | Jetstream WebSocket, `app.bsky.feed.post`, matched locally | live (VPS) |
| Stack Exchange | `/search/advanced` per phrase and chosen sites, with app key | hourly |
| GitHub | issues and discussions search per phrase | daily |
| Reddit | Serper `site:reddit.com "<phrase>"`, past 24 h | daily, budget-capped |

**Pipeline:**
1. Phrase and negative-keyword prefilter.
2. Dedupe by URL.
3. LLM scoring with structured output: intent 0–3, pain, buying stage, persona guess, company mentioned (only if the poster names it), suggested reply angle, and a `self_promo` flag.
4. Threads with intent ≥ 2 enter the **Conversations inbox**.

**Rules:**
- The thread is the lead.
- For Reddit, store only the URL plus the title and snippet returned by search, and link out. We don't copy content.
- No identity resolution, no auto-DM and no auto-posting. A person writes and posts every reply.
- An account is created only when the poster names their company and it resolves to a US `Company`.
- Feedback (`good` / `not_relevant`) is stored and used as few-shot examples for that workspace.
- Unactioned threads expire after 90 days.

---

## 6. CRM

- **Accounts list:** sortable by priority, filterable by stream, stage, fit and intent. FTS search over name and domain.
- **Account page:** firmographics, fit reasons, a signal timeline (visits, threads, fit, hiring), contacts with email status and sources, deals, activities and the next step.
- **Pipeline board:** stages per workspace. Default: New → Researching → Contacted → Replied → Meeting → Proposal → Won / Lost. Drag and drop; every stage change is written as an `Activity`.
- **Conversations inbox:** thread cards with score, excerpt, suggested reply, *Open thread*, *Mark replied*, *Not relevant* and *Create account*.
- **Contacts:** list and detail. *Copy email* and *Export CSV* respect suppression and include a CAN-SPAM reminder.
- **Manual entry:** add or edit accounts and contacts, log activities (note, email, call, meeting, reply).
- **Import / export:** CSV in and out for accounts, contacts and deals.
- **Suppression:** add an email or domain; every view hides suppressed records, and every stream checks the list before enriching.
- **ROI view** (§8.3).

---

## 7. API

- `apps/engine` serves `/api/v1/*` (session cookie for the web app, bearer token for automation and Ground Control), with zod schemas from `packages/shared`.
- `GET /api/v1/summary`: read-only token. Returns new accounts and threads this week, top 10 by priority, spend vs budget, and per-stream ROI. Used by Ground Control.
- `POST /collect/v`, `POST /collect/identify`, `GET /p.js`: public collector only.
- SSE `/api/v1/events` for live inbox and job updates.

---

## 8. Budget and ROI

### 8.1 Enforcement
- `Workspace.monthlyBudgetUsd` (default $50) caps the sum of `CostLedger.usd` for the calendar month.
- Every paid call checks the remaining budget first:
  - At 80%, a warning shows in the UI.
  - At 100%, paid calls stop, and jobs wait with the reason "budget reached".
- Free quotas are tracked as counters (ipapi.is 1,000 per day, Serper's free credits) and used before paid calls.
- Per-stream sub-caps are optional (default: stream 3 60%, stream 2 20%, stream 1 10%, LLM 10%).

### 8.2 Starting budget (about $30 of $50)

| Item | Monthly |
|---|---|
| netcup VPS (existing) | $0 |
| Stream 1: free country/ASN databases, ipapi.is free tier, RDAP, PTR | $0 |
| Stream 2: HN, Bluesky, Stack Exchange, GitHub | $0 |
| Stream 2: Reddit via Serper (about 600 searches after the free credits) | about $1 |
| Stream 3: Icypeas 1,000 credits, only after Reacher | $19 |
| LLM: Anthropic API on the VPS (Mac uses `claude` CLI) | about $5 |
| Headroom | about $20 |

### 8.3 ROI view
For each stream and month: spend, accounts created, qualified accounts (fit ≥ threshold and stage ≥ Contacted), replies, meetings, deals won and their value. It also shows **cost per qualified account** and **cost per meeting**. Attribution uses `Account.firstSource`, plus the signals present before each stage change.

### 8.4 Upgrade ladder (only when the ROI view supports it)

| Trigger | Upgrade | Cost |
|---|---|---|
| More than 1,000 new IPs/day needing classification | ipapi.is API | +$20 |
| More than 20,000 new IPs/day | ipapi.is self-hosted IP-to-Company DB | +$89 |
| Reddit threads convert to meetings | Syften (real-time Reddit, Product Hunt, Slack) | +$50 |
| Email find rate under 50% | LeadMagic as a second finder | per result |
| Visits convert and named visitors are wanted | RB2B (US only) | +$79 |
| Need narrow X/Twitter coverage | X API pay-per-use | per read |

---

## 9. Compliance (US only)

- **Country gate:** `allowedCountries = ['US']` is enforced in the collector (drop before storage), in the company import (US only), in contact creation (the account's company must be US-based), and in conversation account creation.
- **Provenance:** every contact field has a `FieldSource` (source, URL, time). The account page shows it.
- **Suppression:** a global list and a per-workspace list, checked before enrichment, display and export. An opt-out request is honoured within 10 business days (CAN-SPAM). The UI makes adding one a single click.
- **Retention:**
  - Unmatched visit data is never stored.
  - `IpLookupCache` 30 days.
  - Unactioned threads 90 days.
  - Contacts on archived accounts are deleted after 12 months.
- **Website owners:** `docs/privacy-snippet.md` gives a privacy-policy paragraph (company-level analytics from IP, no cookies, opt-out contact) covering CCPA disclosure.
- **No person-level visitor identification and no session replay.** This also keeps California wiretap-law (CIPA) pixel risk low.
- **Outreach** (outside the engine in v1): exports carry a CAN-SPAM checklist (accurate headers, honest subject, physical address, working opt-out).
- **Data sources:** only sources whose terms allow this use (see `docs/research.md`). No LinkedIn scraping, and no data from LinkedIn-scraping vendors.

---

## 10. Security

- **Binding:**
  - Local mode binds to `127.0.0.1`.
  - On the VPS, the web app and API are reachable only over HTTPS through Coolify's proxy, with login required (argon2id, httpOnly session cookies, CSRF protection), or over Tailscale only.
  - The collector is the only public, unauthenticated surface.
- **Collector hardening:** strict schemas, 2 KB bodies, per-IP and per-site rate limits, no reads, `siteKey` must match the site's domain (Origin/Referer check).
- **Command registry** (`apps/engine/src/commands.ts`): every external binary (`claude`, `httpx`) is a named entry with argument arrays and validated parameters. No shell interpolation.
- **Untrusted text:** web pages, posts, threads and provider responses are data. They are passed to the LLM only inside delimited data blocks, the model gets no tools, and output is schema-validated. Nothing from them is executed or followed as an instruction.
- **Secrets:** see §2. Logs mask anything that looks like a key or token.
- **Audit:** logins, exports, suppression changes, budget changes, provider-key changes and deletions go to `AuditLog`.
- **Destructive actions** (delete account, bulk delete, clear workspace) need a confirmation dialog. Deleting a workspace requires typing its name.

---

## 11. Phases

Build phase by phase. Finish each phase's acceptance criteria before starting the next. Each phase ends with a summary of what was built and verified, plus an ROI note where relevant.

**Phase 0: Verify and scaffold (1–2 days)**
- ✅ `docs/claude-cli.md`: the headless `claude` flags this repo uses, verified with `claude --help` and the docs (Ground Control's file is the starting point; recheck every flag).
- ✅ `docs/providers.md`: verified endpoints, auth, limits and current prices for ipapi.is, Icypeas, Serper, HN Algolia, Bluesky Jetstream, Stack Exchange, GitHub search, RDAP, IPinfo Lite/DB-IP Lite downloads and the PDL free dataset. Items marked unverified in `docs/research.md` are resolved or still flagged.
- ✅ Outbound port 25 from the netcup VPS tested. If it is blocked, Reacher is disabled and Icypeas verification replaces it.
- ✅ pnpm monorepo, lint, typecheck and vitest pass in CI; Dockerfile and `deploy/compose.yaml` build; `pnpm dev` runs web (4500) and engine (4501), with the collector on 4511.

**Phase 1: Core and CRM (about 1 week)**
- ✅ Workspaces, users and login; encrypted provider keys; audit log.
- ✅ Offer profile: URL → draft → edit → approve, with versions.
- ✅ Accounts, contacts, deals, activities, next steps; pipeline board; CSV import and export; suppression list.
- ✅ Provider layer with cache, cost ledger, budget enforcement and a fake provider for tests.
- ✅ Scoring with reasons; `GET /api/v1/summary`.
- ✅ Idle RSS of web + engine under 512 MB, measured with `pnpm rss`.

**Phase 2: Stream 3, persona fit (1–2 weeks)**
- ✅ US company universe imported on the Mac from at least the PDL free dataset and SEC EDGAR; the ICP subset syncs to the VPS.
- ✅ For one real workspace: 500 candidates → fit-scored accounts with reasons → people from team pages → emails with statuses, all within $20 of spend.
- ✅ Each contact field shows its source.
- ✅ **ROI checkpoint:** 200 qualified contacts handed to outreach; replies and meetings logged in the CRM after 3 weeks.

**Phase 3: Stream 1, website visits (about 1 week)**
- ✅ Collector deployed on the VPS behind a Coolify domain; the snippet is installed on at least two of the &Human / okreitz sites.
- ✅ Fixture tests prove that non-US, bot, ISP, mobile, hosting and VPN traffic is dropped before storage.
- ✅ Matched visits appear on account timelines; form identification grows the IP map; match rate is shown per site.
- ✅ New high-fit visiting accounts get contacts through the stream 3 jobs.
- ✅ **ROI checkpoint:** match rate and accounts per week after 30 days.

**Phase 4: Stream 2, conversation intent (about 1 week)**
- ✅ HN, Bluesky, Stack Exchange, GitHub and Reddit (via Serper) adapters run on schedule within quota.
- ✅ The inbox shows scored threads with suggested replies; feedback changes later scoring; expiry works.
- ✅ **ROI checkpoint:** threads replied to vs. conversations started vs. meetings after 30 days.

**Phase 5: Productise**
- ✅ A Coolify one-click template and docs; multi-workspace onboarding; per-workspace budgets and BYO keys.
- ✅ Public AGPL release with `NOTICE`, a contribution guide and a hosted-plan landing page. Billing is designed, not necessarily built.

---

## 12. Repo layout

```
lead-engine/
  apps/
    web/            Next.js UI (CRM, inbox, offer editor, ROI, settings)
    engine/
      src/
        api/          routes, auth, SSE
        collector/    public listener, pipeline, p.js
        jobs/         queue, scheduler, job types
        streams/      visits/, conversations/, personas/
        providers/    index.ts (meter, cache, budget), ipapi.ts, icypeas.ts, serper.ts, reacher.ts, rdap.ts, …
        llm/          claude-cli.ts, anthropic-api.ts, prompts/
        crawler/      fetch, robots, readability
        crm/          accounts, contacts, deals, activities, scoring
        db/           schema.ts, migrations/
        commands.ts   allowlisted binaries
      test/
  packages/
    shared/         zod schemas, types, constants
  deploy/
    Dockerfile, compose.yaml, coolify.md
  docs/
    research.md       sources, prices and verification status (Nov 2026)
    providers.md      verified provider APIs (Phase 0)
    claude-cli.md     verified CLI usage (Phase 0)
    decisions.md      short decision log
    privacy-snippet.md
  data/             gitignored: downloads, mmdb files, local db
  CLAUDE.md  SPEC.md  README.md  LICENSE  NOTICE
```

---

## 13. Reuse and licensing

- **Licence:** AGPL-3.0-only. The hosted service must offer its source to users (AGPL §13), which this project embraces.
- **Copy code from** (with attribution in `NOTICE`):

  | Project | Licence | What we take |
  |---|---|---|
  | Franco | MIT | Prospecting agent patterns |
  | SignalForce | MIT | Fit × intent scoring design |
  | lead-signal-listener | MIT | Keyword/scoring design |
  | fire-enrich | MIT | Enrichment agent decomposition |
  | dataforge | MIT | Email extraction, US registry importers |
  | Sellbird | AGPL-3.0 | ICP, signal and decision-maker flow |
  | OpenGTM | AGPL-3.0 | Waterfall design |
  | openleads | AGPL-3.0 | Evidence labels on emails |
  | openenrich | AGPL-3.0 | Local waterfall engine |
  | OpenMagpie | Apache-2.0 | Source adapters (check its `ee/` directory, which is excluded) |

- **Run as separate tools:**
  - Reacher (check-if-email-exists): Docker sidecar; licence rechecked in Phase 0.
  - httpx with its wappalyzergo detection: MIT.
- **Design reference only (no licence):** leadecho, redsignal, visitor-signal-engine.
- **Data licences:**
  - PDL free dataset: CC BY 4.0, attribution required.
  - DB-IP Lite: CC BY 4.0.
  - IPinfo Lite: check terms in Phase 0.
  - Overture: CDLA-Permissive-2.0 / Apache-2.0.
  - Cloudflare Radar lists: CC BY-NC, **not allowed**.
  - OpenStreetMap: ODbL, avoid in redistributed data.

---

## 14. Later (design for, don't build)

Email sending with sequences and CAN-SPAM footer (own SMTP or listmonk) · LeadMagic and other finders in the waterfall · Syften adapter · RB2B webhook import · X API adapter · HTTP Archive technographics at scale · Ground Control Leads card and actions · billing and self-serve signup · Chrome extension for logging LinkedIn conversations manually · additional countries (needs a GDPR design first).
