# UI design

How the web app looks and behaves. SPEC §6 says *what* the CRM does; this file says *how* it is presented. Build the UI from this file.

Based on research of Apollo, ZoomInfo (SalesOS, WebSights), Clay, Common Room, Octolens, Leadfeeder/Dealfront, RB2B, Warmly, 6sense, Demandbase, Attio, folk, Twenty, HubSpot and Linear (November 2026). That research used public docs, changelogs and reviews only; no paid product was logged into. Patterns marked *(ours)* are our synthesis rather than a copy. Sources are at the end.

## 1. Principles

These come straight from what users complain about in the products above.

1. **Every score explains itself.** Priority, fit and intent always show their top 3 reasons, and each reason links to the signal behind it. No black-box scores (6sense and ZoomInfo Copilot complaints).
2. **Every enriched field shows its source.** A small source dot with provider, date and cost on hover. Provenance lives inline, never on a separate "data health" page (Clay cell details, Attio citations, Common Room read-only external fields).
3. **No surprise spend.**
   - Every paid action shows its estimated cost and a dry-run count before it runs.
   - Misses are never charged without being labelled.
   - Every charge traces back to a record in the ledger.

   These address Clay, Apollo and ZoomInfo credit complaints.
4. **Opinionated defaults, few columns, progressive disclosure.** No spreadsheet builder, no arbitrary formula columns (Apollo "cluttered", Clay's 2–6-week learning curve).
5. **Keyboard first, mouse friendly.** Linear-style shortcuts everywhere, with a `?` sheet listing them.
6. **AI output is a draft.** Drafted ICP fields, suggested replies and research notes are accepted, edited or rejected by a person. Nothing is auto-applied or auto-sent.
7. **Status is never colour alone.** Every badge has a text label.

## 2. Navigation

Collapsible left sidebar, at most 8 items. Badges show counts.

```
┌──────────────────┐
│ ◆ Lead Engine  ▾ │  ← workspace switcher
│ ⌘K Search…       │
├──────────────────┤
│ ☀ Today          │  ← default landing page
│ ✉ Inbox      12  │  ← unhandled conversations
│ ▦ Accounts       │
│    · Hot         │  ← pinned saved views
│    · Visitors    │
│    · Conversations│
│    · Persona fit │
│    · My views…   │
│ ⇶ Pipeline       │
│ ◉ Visitors       │
│ ✎ Offer profile v3│
│ $ ROI    $31/50  │
├──────────────────┤
│ ⚙ Settings       │  ← sites & snippet, provider keys, budget, suppression, members
└──────────────────┘
```

- **Landing page is Today**, not Accounts: a short, prioritised work list beats a big table (Linear's Priority inbox, HubSpot's Top signals) *(ours)*.
- **Global keys:**
  - `⌘K` command palette (search records and run commands)
  - `G` then a letter to jump: `G T` Today, `G I` Inbox, `G A` Accounts, `G P` Pipeline, `G V` Visitors, `G O` Offer, `G R` ROI, `G S` Settings
  - `?` shortcut sheet, `/` focus search, `Esc` close the side sheet

## 3. Screens

### 3.1 Today (landing)

```
Today · Mon 9 Nov                                        Budget $31 / $50 ▓▓▓▓▓▓░░░
┌─ New signals on top accounts ───────────────────────────────────────────────┐
│ 87  Acme Robotics      ▮▮▮▮▯ fit ▮▮▮▮▮ intent  pricing ×2 · hiring RevOps    │
│ 81  Northwind Freight  ▮▮▮▮▮ fit ▮▮▮▯▯ intent  HN thread · matches ICP       │
│ …  (top 10 since your last visit)                                           │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Inbox: 12 unhandled ────────┐ ┌─ Next steps due ────────────────────────────┐
│ ●3 "alternative to X?" HN 2h │ │ ☐ Acme: send case study      today          │
│ ●2 "how do I …" SE 5h        │ │ ☐ Northwind: follow up       overdue 1d     │
└──────────────────────────────┘ └─────────────────────────────────────────────┘
```

- No vanity charts here.
- Each row opens the account in a side sheet.

### 3.2 Accounts

```
Accounts   [Hot] [Visitors] [Conversations] [Persona fit] [+ view]          ⌘K
Filters: (Stage: New, Researching) (Fit ≥ 60) (+ filter)   Sort: Priority ↓   Columns ▾
┌──┬──────────────────────┬────────────────────────────┬──────────┬─────────┬────────┬──────────┐
│☐ │ Company              │ Priority                   │ Stage    │ Stream  │ Last   │ Next step│
├──┼──────────────────────┼────────────────────────────┼──────────┼─────────┼────────┼──────────┤
│☐ │ Acme Robotics  acme.io│ 87 ▮▮▮▮▯▮▮▮▮▮ [pricing×2][ICP]│ New      │ ◉ visit │ 2h     │ —        │
│☐ │ Northwind  nwf.com   │ 81 ▮▮▮▮▮▮▮▮▯▯ [HN][ICP][hiring]│ Research │ ✉ conv  │ 1d     │ call Thu │
└──┴──────────────────────┴────────────────────────────┴──────────┴─────────┴────────┴──────────┘
  2 selected: [Set stage ▾] [Add to pipeline] [Suppress] [Export CSV]         142 accounts
```

- **Table:** TanStack Table plus TanStack Virtual, sticky header, pinned company column, footer count. View state (filters, sort, columns) lives in the URL.
- **Saved views:** each keeps its own filters, sort and columns, and can be pinned to the sidebar (Twenty, Attio). Stream presets ship as defaults (Leadfeeder default feeds). A view can later trigger alerts (Apollo saved-search alerts, HubSpot) — see SPEC §14.
- **Filters:** values inside one filter are OR, separate filters are AND (Leadfeeder).
- **Priority cell:** the number, two mini bars (fit, intent) and up to 3 reason chips. Hovering opens a card with the full breakdown and links to the signals (Demandbase hover factors, Warmly reasons) *(ours)*.
- **Row:** hover shows a preview icon; `Space` or clicking the name opens the side sheet, `Enter` opens the full page (Attio preview, Twenty).
- **Bulk bar** appears on selection (HubSpot). Suppress asks for confirmation.
- **Keys:** `J/K` move, `X` select, `Space` preview, `Enter` open, `S` set stage.

### 3.3 Account page (and side sheet)

The side sheet shows the header and the first two sections; "Open full page" shows everything.

```
Acme Robotics · acme.io · Austin, TX · 51–200 · Industrial automation
Priority 87  Fit 78 ▮▮▮▮▯  Intent 92 ▮▮▮▮▮   Stage [New ▾]   Next step [+ add]
┌─ Fit ───────────────────┐┌─ Signals  [All][Visits][Threads][Fit][Hiring] ─┐┌─ Contacts ────────────────┐
│ ✓ Industry match        ││ ◉ 2h  Visited /pricing, /demo (3 pages)         ││ Jane Doe · VP Ops          │
│ ✓ 51–200 employees      ││ ✉ 1d  HN: "looking for …" intent 3 → open ↗     ││  jane@acme.io [Verified]•  │
│ ✓ Uses HubSpot •        ││ ★ 3d  Fit scored 78 (homepage) •                ││ John Roe · Head of RevOps  │
│ ✗ Not in target state   ││ ⚑ 5d  Hiring: RevOps Manager (Greenhouse) ↗      ││  john@acme.io [Catch-all]• │
│ Firmographics           │└─────────────────────────────────────────────────┘│ Deals · Activities · Notes │
│ Founded 2014 • (PDL)    │                                                   └───────────────────────────┘
└─────────────────────────┘
```

- **Layout:** header with KPIs, then three columns: fit and firmographics, signal timeline, then people and deals (Common Room organisation profile, Demandbase KPI cards, Twenty widgets) *(ours)*. On narrow screens the columns stack: header, signals, contacts, fit.
- **`•` is the source dot.** Its tooltip shows provider, URL, fetched date and cost, if any.
  - Fields from external sources are read-only until a person overrides them; an override is logged (Common Room, Attio edit history).
- **Email status badges** (text plus colour):
  - `Verified` green
  - `Pattern verified` green outline
  - `Risky` amber
  - `Catch-all` amber outline
  - `Unknown` grey
  - `Invalid` red, struck through
- **"Wrong company" correction:** visitor matches show their match source and confidence, and `W` marks a match wrong. The correction feeds the IP map and is logged (complaints about false IP matches).
- **Paid enrichment buttons** ("Find people", "Find email") show the estimated cost and the remaining budget before running. A confirmation dialog appears only when the cost exceeds $1 or 10% of what's left.

### 3.4 Pipeline

```
Pipeline   view: [All ▾]   [Table | Board]
New (14)        Researching (6)   Contacted (9)   Replied (3)   Meeting (2)   Proposal (1)  │Won│Lost│
┌────────────┐  ┌────────────┐
│Acme  87    │  │Northwind 81│
│next: —     │  │call Thu    │
│2d in stage │  │5d in stage │
└────────────┘  └────────────┘
```

- **One saved view, two layouts:** the same view renders as a table or a board.
- **Cards** show company, priority, next step and days in stage (Attio card fields).
- **Columns** show count and deal value totals (folk). Won and Lost collapse into narrow columns.
- **Dragging a card** changes the stage optimistically and writes an `Activity`.
- **Keys:** `Enter` opens a card; `[` and `]` move the selected card one stage left or right.

### 3.5 Inbox (conversations, Phase 4)

```
Inbox  [Priority 12] [All] [Replied] [Dismissed]          source ▾  intent ▾
┌─────────────────────────────────────┬──────────────────────────────────────────────┐
│● 3  HN   "Alternative to X for …"  2h│ Hacker News · @user · 2h · matched "alternative to X" │
│● 2  SE   "How do I sync …"         5h│ Excerpt …                                     │
│  2  BSKY "anyone using …"          1d│ Pain: manual CRM sync   Stage: evaluating     │
│                                     │ Suggested reply (draft, editable)              │
│                                     │ ┌──────────────────────────────────────────┐  │
│                                     │ │ …                                        │  │
│                                     │ └──────────────────────────────────────────┘  │
│                                     │ [Copy reply] [Open thread ↗ o] [Replied r]     │
│                                     │ [Not relevant x] [Create account a]            │
└─────────────────────────────────────┴──────────────────────────────────────────────┘
```

- **Layout:** two panes (Linear inbox). Priority tab by default.
- **Keys:** `J/K` move, `O` open the thread, `R` mark replied, `X` not relevant, `A` create account, `H` snooze (Linear, Octolens).
- **Labels:** Buy intent, Alternative, Pain, Question (Octolens).
- **Feedback:** relevant / not relevant is stored and improves later scoring.
- **Replies are copied, never posted by the app.** "Create account" is enabled only when the poster named their company (SPEC §5.3).

### 3.6 Visitors (Phase 3)

```
Visitors  site: [andhuman.com ▾]   last 30 days
Match rate 22%  (identified 184 / sessions 836)   dropped: non-US 41% · bot 9% · ISP/mobile/VPN 28%
┌──────────────────────┬────────┬────────┬──────────┬──────────────────────────────┬────────────┐
│ Company              │ Visits │ Pages  │ Last     │ Intent pages                 │ Match      │
│ Acme Robotics        │ 3      │ 7      │ 2h       │ /pricing ×2 · /demo          │ ipapi • hi │
│  ▸ path: / → /product → /pricing → /demo                                                 │
└──────────────────────┴────────┴────────┴──────────┴──────────────────────────────┴────────────┘
```

- **Header:** site picker, match-rate KPI and a breakdown of dropped traffic (HubSpot, WebSights).
- **Default filter:** "More than 2 pages or an intent page". ISP-type matches are already dropped (Leadfeeder Top companies).
- **Intent pages** (pricing, demo, contact) are set per site and tagged in the list (HubSpot "Intent", RB2B Hot Pages, WebSights page priority).
- **Match column:** source and confidence for each match.

### 3.7 Offer profile

```
Offer profile  v3 (approved 2 Nov)   [Compare with v2]   [Draft new version]
┌─ ICP ──────────────────────────────────────────┐┌─ Preview ──────────────────────────┐
│ Industries  [Industrial automation ✓][Logistics ✎][Retail ✗] ││ 142 companies match             │
│ Size        51–500                     ✓       ││  · 38 Texas · 21 California …      │
│ States      any                        ✓       ││ Sample: Acme, Northwind, …         │
│ Tech uses   HubSpot, Salesforce        ✎       │└────────────────────────────────────┘
├─ Personas ─────────────────────────────────────┤
│ VP Operations · pains: … ✓                     │
├─ Intent phrases (28) ──────────────────────────┤
│ "alternative to X" [alternative] ✓  "how to sync …" [pain] ✎  …                │
└────────────────────────────────────────────────┘           [Approve as v4]
```

- **Each LLM-drafted field** shows accept ✓, edit ✎ or reject ✗, and a "why" tooltip (Linear Triage Intelligence).
- **Live preview:** while editing, the right pane shows how many companies would match, so the user sees the effect before approving (Common Room scoring review, HubSpot intent setup) *(ours)*.
- **Approve** creates a new version. **Compare** shows a field-level diff.

### 3.8 ROI

```
ROI · November      Budget $31.40 / $50   forecast $44 by month end   ▓▓▓▓▓▓░░░
┌──────────────┬────────┬──────────┬───────────┬─────────┬──────────┬──────────────┬─────────────┐
│ Stream       │ Spend  │ Accounts │ Qualified │ Replies │ Meetings │ $/qualified  │ $/meeting   │
│ Persona fit  │ $22.10 │ 240      │ 61        │ 7       │ 2        │ $0.36        │ $11.05      │
│ Visits       │ $0.00  │ 18       │ 6         │ 1       │ 1        │ $0.00        │ $0.00       │
│ Conversations│ $1.20  │ 4        │ 4         │ 3       │ 0        │ $0.30        │ —           │
│ LLM          │ $8.10  │          │           │         │          │              │             │
└──────────────┴────────┴──────────┴───────────┴─────────┴──────────┴──────────────┴─────────────┘
Ledger  [provider ▾] [stream ▾]   every paid call, linked to its record
```

- Budget bar per stream against the sub-caps, with a month-end forecast.
- The ledger table links every charge to the record it was spent on (Clay Run Info, HubSpot's list of what costs credits).

### 3.9 Settings

Tabs:
- **Sites & snippet:** domain, snippet with a copy button, install check, intent pages.
- **Provider keys:** masked, last used, a test button.
- **Budget:** monthly cap, sub-caps, the 80% warning.
- **Suppression:** emails and domains, with add, import and reason.
- **Members.**
- **Danger zone:** delete workspace by typing its name.

## 4. Building blocks

| Block | Implementation | Used in |
|---|---|---|
| DataTable | TanStack Table + TanStack Virtual; sticky header, pinned columns, selection with bulk bar, footer aggregates, URL state | Accounts, Visitors, ROI ledger, Contacts |
| ViewBar | Saved-view tabs, filter chips (OR within, AND between), sort, column toggle | Accounts, Pipeline, Inbox |
| ScoreCell + ScoreHoverCard | Number, fit/intent mini bars, reason chips; shadcn HoverCard | Today, Accounts, Pipeline cards |
| SourceDot, EmailStatusBadge | shadcn Tooltip, Badge; always text plus colour | Account page, Contacts |
| RecordSheet | shadcn Sheet from the right, "Open full page" | Everywhere a record is listed |
| CommandPalette | shadcn Command (cmdk) + shortcut hook + `?` dialog | Global |
| TwoPane | shadcn Resizable | Inbox |
| SignalTimeline | Vertical list with type icons and type filter | Account page |
| Kanban | dnd-kit sortable + optimistic TanStack Query mutation | Pipeline |
| VersionDiff | Field-level diff | Offer profile |
| BudgetMeter + CostConfirm | shadcn Progress + AlertDialog with cost estimate | Header, ROI, enrichment buttons |
| EmptyState | Says the next step ("Approve your offer profile", "Install the snippet") | Every list |
| Skeleton rows | shadcn Skeleton | Every list |

## 5. Anti-patterns (don't build)

- No spreadsheet or formula builder (Clay).
- No score without reasons, and no "buying stage" prediction without the signals behind it.
- No hidden or after-the-fact charges, and no spend outside the ledger.
- No colour-only status or traffic lights.
- No vanity charts on the landing page.
- No more than 8 sidebar items.
- No auto-applied AI text or auto-sent replies.
- No modals except to confirm destructive or costly actions.

## 6. Build order

| Phase | Screens |
|---|---|
| 1 | Shell (sidebar, ⌘K, shortcuts), Today, Accounts, Account page and sheet, Pipeline, Offer profile, ROI (spend and ledger), Settings (keys, budget, suppression, members) |
| 2 | Contacts with email statuses and source dots in use; cost-confirm on enrichment |
| 3 | Visitors, Settings → Sites & snippet |
| 4 | Inbox |

## Sources

- HubSpot buyer intent: https://knowledge.hubspot.com/reports/use-buyer-intent
- HubSpot buying signals workspace: https://knowledge.hubspot.com/prospecting/use-buying-signals-in-sales-workspace
- Common Room AI scoring: https://www.commonroom.io/docs/using-common-room/ai-native-scoring/
- Common Room organisation profiles: https://www.commonroom.io/docs/using-common-room/organizations-page/organization-profiles/
- Common Room activity: https://www.commonroom.io/docs/using-common-room/activity-page/
- Octolens relevance: https://octolens.com/docs/learn/ai-relevance.md
- Octolens CLI: https://octolens.com/docs/cli/guides/watch-live.md
- Linear inbox: https://linear.app/docs/inbox
- Linear triage: https://linear.app/docs/triage
- Linear triage intelligence: https://linear.app/docs/triage-intelligence
- Twenty layout: https://docs.twenty.com/getting-started/core-concepts/layout
- Attio table views: https://attio.com/help/reference/managing-your-data/views/create-and-manage-table-views.md
- Attio kanban: https://attio.com/help/reference/workspace/kanban-views
- Attio navigation: https://attio.com/help/getting-started/navigating-your-workspace
- Attio web research agent: https://attio.com/changelog/2026/web-research-agent
- Clay columns: https://university.clay.com/docs/table-columns-overview
- Clay waterfall: https://university.clay.com/docs/building-a-data-waterfall
- Leadfeeder feeds: https://help.leadfeeder.com/en/articles/13921756-basic-feeds-vs-custom-feeds
- Leadfeeder custom feeds: https://help.leadfeeder.com/features/feeds/custom-feeds
- ZoomInfo WebSights guide: https://tech-docs.zoominfo.com/websights-implementation-guide.pdf
- Apollo saved-search alerts: https://knowledge.apollo.io/hc/en-us/articles/4409803718669
- Warmly signals: https://www.warmly.ai/p/signals
- Warmly lead scoring: https://www.warmly.ai/p/blog/lead-scoring
- Complaints:
  - Apollo on Capterra: https://www.capterra.com/p/158696/Apollo/reviews/
  - Apollo review by Salesforge: https://salesforge.ai/blog/apollo-io-review
  - Clay reviews roundup (ZoomInfo's site): https://pipeline.zoominfo.com/sales/clay-reviews
  - Clay credit usage thread: https://community.clay.com/x/support/0kl140fuay85/guidance-on-data-waterfalls-avoiding-credit-usage
  - ZoomInfo on TrustRadius: https://www.trustradius.com/reviews/zoominfo-salesos-2023-06-21-12-15-02
  - Leadfeeder on G2: https://www.g2.com/products/dealfront-group-gmbh-leadfeeder/reviews
  - Common Room on G2: https://g2.com/products/common-room/reviews
  - 6sense on G2: https://g2.com/products/6sense-sales/reviews
  - False visitor matches (Knock2): https://www.knock2.ai/blog/website-visitor-identification-false-positives

Many complaint sources are competitor blogs; treat them as directional.
