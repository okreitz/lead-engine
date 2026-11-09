# Deploying on Coolify (netcup VPS)

The stack is two containers built from `deploy/Dockerfile`: **engine** (API :4501, collector :4511, SQLite on a volume) and **web** (Next.js :4500, which proxies `/api/v1` to the engine). Coolify's proxy terminates HTTPS; no ports are published on the host.

Coolify can't receive GitHub webhooks on this server, so pushes don't deploy. Deploy manually in the dashboard, or through the Coolify API (see Ground Control's `docs/coolify-api.md`).

## 1. Create the resource
1. **Projects → your project → + New → Public/Private Repository (GitHub App)** → `okreitz/lead-engine`, branch `main`.
2. **Build Pack:** `Docker Compose`.
3. **Base Directory:** `/`. **Docker Compose Location:** `/deploy/compose.yaml`.
4. Save, then **Reload Compose File** so Coolify lists the `engine` and `web` services and their variables.

## 2. Environment variables
Set these under **Environment Variables**. Mark them as secrets where Coolify offers it, and never commit them.

| Variable | Required | Value |
|---|---|---|
| `LE_MASTER_KEY` | yes | `openssl rand -base64 32`. Encrypts workspace provider keys (AES-256-GCM). **Keep a copy outside the server**: without it, saved provider keys can't be decrypted. Don't change it once keys are saved. |
| `LE_SETUP_TOKEN` | yes | `openssl rand -hex 24`. Needed once, on the login page, to create the first user. Keep it set (it is harmless once a user exists) or rotate it. |
| `LE_COOKIE_SECURE` | no | `auto` (default): the session cookie is `Secure` when the request came over HTTPS. Use `true` when the app is only reached over HTTPS. |
| `ANTHROPIC_API_KEY` | no | Instance fallback for the `anthropic-api` LLM adapter. Workspaces can store their own key instead (Settings → Provider keys). |
| `LE_LOG_LEVEL` | no | `info` (default). |

There is no separate session secret. Sessions are random 256-bit tokens; only their SHA-256 is stored in SQLite, and every unsafe request also needs a per-session CSRF token.

## 3. Domains
Under the resource's **Domains**, set the domain per service. The port after the host is the **container** port; visitors still use 443.

| Service | Domain | Notes |
|---|---|---|
| `web` | `https://leads.<your-domain>:4500` | The app. Every page redirects to `/login` without a session, and every API call needs a session or token. Alternatively, reach it over Tailscale only and leave it without a public domain. |
| `engine` | none for now | Phase 3 adds the collector: `https://collect.<your-domain>:4511`. Never route port 4501 (the API) publicly. |

Ground Control reads `GET https://leads.<your-domain>/api/v1/summary` with a read-only token (Settings → API tokens), through the web container's proxy.

## 4. Storage
The compose file declares the named volume `le-data`, mounted at `/data` in the engine. It holds `/data/le.db` (SQLite with WAL files) and later the IP databases. Coolify shows it under **Persistent Storage**, read-only there because it comes from the compose file. Include it in Coolify's backups, or copy `le.db` with `sqlite3 /data/le.db ".backup ..."`. Nightly `VACUUM INTO` backups arrive in a later phase.

## 5. Health checks
Both services define compose health checks. The engine checks `GET /api/v1/health` on 4501 and the web checks `GET /login` on 4500. The web starts only after the engine is healthy. Coolify's own Healthcheck page isn't used for Git-based Compose applications.

## 6. Deploy and first login
1. **Deploy**. The build runs `pnpm install`, the engine bundle and `next build` (a few minutes on 2 vCores).
2. Open `https://leads.<your-domain>/login`. The first visit shows **Create the first user**. Enter the email, a 12+ character password, the workspace name and `LE_SETUP_TOKEN`.
3. Under **Settings**, set the budget and the LLM adapter (`anthropic-api` on the VPS) and add provider keys.

## 7. Memory
Each container is capped at 256 MB (`mem_limit`). `pnpm rss` measured about 190 MB idle for both together (limit 512 MB, CLAUDE.md).

## Local run of the same images
```sh
LE_MASTER_KEY=$(openssl rand -base64 32) LE_SETUP_TOKEN=$(openssl rand -hex 16) \
  docker compose -f deploy/compose.yaml -f deploy/compose.local.yaml up --build
# web on http://127.0.0.1:4500, collector on 127.0.0.1:4511
```
