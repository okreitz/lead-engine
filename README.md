# Lead Engine

A self-hosted engine that finds US B2B leads from three streams and keeps them in its own lean CRM:

1. **Website intent:** which US companies visit your sites (company-level, no cookies).
2. **Conversation intent:** public threads where people ask for what you sell (Hacker News, Bluesky, Stack Exchange, GitHub, Reddit via search).
3. **Persona fit:** companies and contacts that match the ideal customer profile derived from your product.

It runs locally or on a small VPS with SQLite, meters every paid API call, and stops at a monthly budget you set (default $50).

**Status:** Phase 1 (core and CRM). See [`SPEC.md`](SPEC.md) for the build plan, [`docs/providers.md`](docs/providers.md) for verified provider facts and [`docs/decisions.md`](docs/decisions.md) for the decision log.

## Develop
Requires Node 22.12+ and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm dev          # web 127.0.0.1:4500, engine 127.0.0.1:4501, collector 127.0.0.1:4511
pnpm typecheck && pnpm lint && pnpm test
pnpm db:migrate   # apply Drizzle migrations to data/le.db
pnpm rss          # build, start and measure idle RSS of web + engine (limit 512 MB)
docker compose -f deploy/compose.yaml up --build
```

First run: open http://127.0.0.1:4500 and create the first user and workspace. Off loopback (Docker, VPS) setup also needs `LE_SETUP_TOKEN`. Set `LE_MASTER_KEY` (`openssl rand -base64 32`) before saving provider keys.

## Licence
[AGPL-3.0-only](LICENSE). If you run a modified version as a service, you must offer its source to your users.
