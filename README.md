# Lead Engine

A self-hosted engine that finds US B2B leads from three streams and keeps them in its own lean CRM:

1. **Website intent:** which US companies visit your sites (company-level, no cookies).
2. **Conversation intent:** public threads where people ask for what you sell (Hacker News, Bluesky, Stack Exchange, GitHub, Reddit via search).
3. **Persona fit:** companies and contacts that match the ideal customer profile derived from your product.

It runs locally or on a small VPS with SQLite, meters every paid API call, and stops at a monthly budget you set (default $50).

**Status:** specification. See [`SPEC.md`](SPEC.md) for the build plan and [`docs/research.md`](docs/research.md) for the sources behind it.

## Licence
[AGPL-3.0-only](LICENSE). If you run a modified version as a service, you must offer its source to your users.
