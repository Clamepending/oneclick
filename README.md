# OneClick OpenClaw

Minimal v1 implementation of a managed-first one-click deploy flow.

## Included in v1

- Google sign-in
- 3-step onboarding
- Async deployment creation (`queued -> starting -> ready|failed`)
- Progress polling page
- Shared-host model with one OpenClaw container per user
- Basic in-memory rate limiting

## Not included in v1

- Billing/payments
- Video gateway
- MCP addon servers
- Dedicated VM per user

## Environment

Copy and fill:

```bash
cp .env.example .env
```

Critical keys:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `AUTH_SECRET`
- `ADMIN_EMAILS` (optional comma-separated allowlist for `/admin`; if unset, any signed-in user can access admin in this prototype)
- `DATABASE_URL`
- `HOST_POOL_JSON`
- `OPENCLAW_IMAGE`

Optional for background queue mode:

- `REDIS_URL` (required only if using separate worker process)

Runtime deployment mode:

- `DEPLOY_PROVIDER=mock` (default placeholder runtime URL)
- `DEPLOY_PROVIDER=ssh` (real SSH host deployment using Docker)
- `DEPLOY_PROVIDER=digitalocean` (create Droplet via API from Vercel)
- `DEPLOY_SSH_PRIVATE_KEY` can contain a PEM private key with `\\n` newlines.
- `DEPLOY_SSH_KNOWN_HOSTS` is optional but recommended for strict host verification.
- `OPENCLAW_ALLOW_INSECURE_CONTROL_UI=true` allows Control UI over plain HTTP for prototype environments (less secure; prefer HTTPS in production)
- `OPENCLAW_GATEWAY_TOKEN` optionally pins a stable gateway token used in runtime URLs (`?token=...`) so browser access works reliably behind proxies
- `NEXT_PUBLIC_DEPLOY_POLL_INTERVAL_MS` controls dashboard polling in browser (default `10000`)
- `PG_POOL_MAX`/`PG_IDLE_TIMEOUT_MS`/`PG_CONNECTION_TIMEOUT_MS` tune DB pool usage for serverless (defaults are safe for small Supabase poolers)

## Run

```bash
npm install
npm run dev
```

Worker (separate process):

```bash
npm run worker -- --run
```

## Vercel deployment

- This app is Vercel-compatible out of the box.
- If `REDIS_URL` is not set, deployments are processed in-process (no separate worker required).
- On Vercel, set:
  - `AUTH_URL=https://your-app.vercel.app`
  - `APP_BASE_URL=https://your-app.vercel.app`
  - Google OAuth callback: `https://your-app.vercel.app/api/auth/callback/google`

### Import `.env` directly to Vercel

1. Install and authenticate Vercel CLI:

```bash
npm i -g vercel
vercel login
vercel link
```

2. Import env vars from local file:

```bash
# Production
npm run vercel:env:import -- .env production

# Preview
npm run vercel:env:import -- .env preview

# Development
npm run vercel:env:import -- .env development
```

This script replaces existing keys in the target environment and re-adds them from your local `.env`.

## Real container deployment via SSH hosts

Set:

- `DEPLOY_PROVIDER=ssh`
- `HOST_POOL_JSON` entries with SSH target:

```json
[{"name":"host-a","dockerHost":"ssh://ubuntu@1.2.3.4","publicBaseUrl":"http://1.2.3.4"}]
```

Requirements on each host:

- Docker installed and user has permission to run Docker.
- SSH access from deploy worker runtime.
- Port range `OPENCLAW_HOST_PORT_BASE` to `OPENCLAW_HOST_PORT_BASE + OPENCLAW_HOST_PORT_SPAN` open.

For Vercel + SSH deployment (one shared VM, one container per user):

- set `DEPLOY_PROVIDER=ssh`
- set `DEPLOY_SSH_PRIVATE_KEY` (escaped newlines)
- set `HOST_POOL_JSON` to your droplet (for example `ssh://root@64.225.46.105`)
- set `RUNTIME_BASE_DOMAIN` (for example `oneclickagent.net`) to enable `https://<user>.yourdomain` URLs
- optional: set `CADDY_EMAIL` for certificate issuer contact
- do not set `REDIS_URL` to localhost; either provide a real remote Redis or leave `REDIS_URL` unset
- each new deploy for a user destroys that user’s previous container
- if using `RUNTIME_BASE_DOMAIN`, open droplet ports `80/443` and point wildcard DNS (`*.yourdomain`) to droplet IP

## Real container deployment via DigitalOcean API (Vercel-friendly)

Set:

- `DEPLOY_PROVIDER=digitalocean`
- `DO_API_TOKEN` (DigitalOcean personal access token)
- optional sizing/region:
  - `DO_REGION` (default `nyc1`)
  - `DO_SIZE` (default `s-1vcpu-2gb`)
  - `DO_IMAGE` (default `ubuntu-24-04-x64`)
  - `DO_API_TIMEOUT_MS` (default `15000`)

Notes:

- This mode does not require `ssh` binary on Vercel.
- It creates a Droplet and launches the OpenClaw image via cloud-init.

## API

- `POST /api/onboarding/start`
- `POST /api/onboarding/step`
- `POST /api/deployments`
- `GET /api/deployments/:id`
- `GET /api/deployments/:id/events`
- `GET /api/admin/overview`

## Acceptance checklist

- Onboarding reaches deploy click in 3 screens.
- Deploy API returns quickly with `queued`.
- Deployment status transitions show on `/deployments/:id`.
- Build passes: `npm run build`.
