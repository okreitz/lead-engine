# Deploying on Coolify (netcup VPS)

The stack is two containers built from `deploy/Dockerfile`: **engine** (API :4501, collector :4511, SQLite on a volume) and **web** (Next.js :4500, which proxies `/api/v1` to the engine). Coolify's proxy terminates HTTPS; no ports are published on the host.

Coolify can't receive GitHub webhooks on this server. Pushes to `main` deploy through the GitHub workflow in section 8, or you can redeploy manually in the dashboard.

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
| `LE_SEC_USER_AGENT` | no | SEC EDGAR requires a declared contact User-Agent, e.g. `Lead Engine admin@yourdomain.com`. Without it, the EDGAR import and EDGAR officers are off. |
| `LE_REACHER` | no | `off` (default). Set `on` only after the port 25 test passes, together with `LE_REACHER_SECRET` (`openssl rand -hex 24`), `RCH_HELLO_NAME` and `RCH_FROM_EMAIL` (a domain whose reverse DNS matches the VPS), and add `--profile reacher` so the `reacher` sidecar starts. Until then Icypeas verifies (workspace key). |
| (workspace) Amazon SES key | no | Not an env var: each workspace enters an AWS access key ID, secret and region in Settings → Provider keys. Least privilege: an IAM user whose only policy allows `ses:GetEmailAddressInsights` on `"*"` (policy JSON in `docs/providers.md`). Validation only; SES sending is never used. |
| `LE_HTTPX_BIN` | no | Absolute path to ProjectDiscovery's `httpx` if you add it to the engine image; technographics are skipped without it. |
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
The compose file declares the named volume `le-data`, mounted at `/data` in the engine. It holds `/data/le.db` (SQLite with WAL files), `/data/imports/` (dataset downloads for Settings → Company data; deleted after a successful import, and you can copy a PDL file here with `docker cp` instead of pasting a link) and later the IP databases. Coolify shows it under **Persistent Storage**, read-only there because it comes from the compose file. Include it in Coolify's backups, or copy `le.db` with `sqlite3 /data/le.db ".backup ..."`. Nightly `VACUUM INTO` backups arrive in a later phase.

## 5. Health checks
Both services define compose health checks. The engine checks `GET /api/v1/health` on 4501 and the web checks `GET /login` on 4500. The web starts only after the engine is healthy. Coolify's own Healthcheck page isn't used for Git-based Compose applications.

## 6. Deploy and first login
1. **Deploy**. The build runs `pnpm install`, the engine bundle and `next build` (a few minutes on 2 vCores).
2. Open `https://leads.<your-domain>/login`. The first visit shows **Create the first user**. Enter the email, a 12+ character password, the workspace name and `LE_SETUP_TOKEN`.
3. Under **Settings**, set the budget and the LLM adapter (`anthropic-api` on the VPS) and add provider keys.

## 7. Memory
Each container is capped at 256 MB (`mem_limit`). `pnpm rss` measured about 190 MB idle for both together (limit 512 MB, CLAUDE.md).

## 8. Automatic deploys
Coolify can't receive GitHub webhooks here, so `.github/workflows/deploy.yml` deploys instead. After CI passes on a push to `main`, a GitHub runner joins the tailnet as a short-lived node tagged `tag:ci`, calls Coolify's `POST /api/v1/deploy`, waits until the deployment finishes, and leaves the tailnet. You can also start it by hand (Actions → Deploy → Run workflow). Until all five secrets below are set, the workflow skips with a notice, so it never fails CI.

One-time setup:
1. **Coolify API token:** Settings → Advanced → turn the API on. Then Keys & Tokens → API tokens → create a token with **deploy** permission (`read` too, so the workflow can follow the deployment).
2. **Tailscale tag and access rule** (admin console → Access controls):
   - Add `"tag:ci": ["autogroup:admin"]` under `tagOwners`.
   - Allow `tag:ci` to reach the VPS on port 8000 only.
3. **Tailscale OAuth client** (admin console → Settings → OAuth clients → Generate): scope **Auth keys: write**, tag `tag:ci`.
4. **GitHub secrets** (`okreitz/lead-engine` → Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `TS_OAUTH_CLIENT_ID` | OAuth client ID from step 3 |
| `TS_OAUTH_SECRET` | OAuth client secret from step 3 |
| `COOLIFY_URL` | Coolify over Tailscale, e.g. `http://<vps-tailscale-name>:8000` |
| `COOLIFY_TOKEN` | API token from step 1 |
| `COOLIFY_APP_UUID` | The application's UUID (the ID in its Coolify URL) |

If Coolify restricts API access by IP (Settings → Advanced → allowed IPs), add the tailnet range `100.64.0.0/10`.

## Local run of the same images
```sh
LE_MASTER_KEY=$(openssl rand -base64 32) LE_SETUP_TOKEN=$(openssl rand -hex 16) \
  docker compose -f deploy/compose.yaml -f deploy/compose.local.yaml up --build
# web on http://127.0.0.1:4500, collector on 127.0.0.1:4511
```
