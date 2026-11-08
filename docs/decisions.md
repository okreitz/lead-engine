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
