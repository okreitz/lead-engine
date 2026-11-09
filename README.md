# Lead Engine

A self-hosted engine that finds US B2B leads from three streams and keeps them in its own lean CRM:

1. **Website intent:** which US companies visit your sites (company-level, no cookies).
2. **Conversation intent:** public threads where people ask for what you sell (Hacker News, Bluesky, Stack Exchange, GitHub, Reddit via search).
3. **Persona fit:** companies and contacts that match the ideal customer profile derived from your product.

It runs locally or on a small VPS with SQLite, meters every paid API call, and stops at a monthly budget you set (default $50).

**Status:** Phase 0 (verify and scaffold). See [`SPEC.md`](SPEC.md) for the build plan, [`docs/providers.md`](docs/providers.md) for verified provider facts and [`docs/decisions.md`](docs/decisions.md) for the decision log.

## Develop
Requires Node 22.12+ and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm dev          # web 127.0.0.1:4500, engine 127.0.0.1:4501, collector 127.0.0.1:4511
pnpm typecheck && pnpm lint && pnpm test
pnpm db:migrate   # apply Drizzle migrations to data/le.db
docker compose -f deploy/compose.yaml -f deploy/compose.local.yaml up --build   # needs LE_MASTER_KEY, LE_SETUP_TOKEN; Coolify: deploy/coolify.md
```

## Licence
[AGPL-3.0-only](LICENSE). If you run a modified version as a service, you must offer its source to your users.
