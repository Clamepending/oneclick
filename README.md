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
- `PLAN_STORAGE_GB_FREE` / `PLAN_STORAGE_GB_PAID` (displayed plan storage targets; defaults `1` and `10`)

Optional for background queue mode:

- `REDIS_URL` (required only if using separate worker process)

Runtime deployment mode:

- `DEPLOY_PROVIDER=lambda` (default, fully serverless runtime for non-VideoMemory deployments)
- `DEPLOY_PROVIDER=ssh` (legacy SSH host deployment; used by VideoMemory flavor)
- `DEPLOY_PROVIDER=ecs` (legacy mode)
- `DEPLOY_SSH_PRIVATE_KEY` can contain a PEM private key with `\\n` newlines.
- `DEPLOY_SSH_KNOWN_HOSTS` is optional but recommended for strict host verification.
- `OPENCLAW_TELEGRAM_BOT_TOKEN` is required when users select Telegram during onboarding; this token is injected at container launch.
- `OPENCLAW_ALLOW_INSECURE_CONTROL_UI=true` allows Control UI over plain HTTP for prototype environments (less secure; prefer HTTPS in production)
- `OPENCLAW_REQUIRE_PINNED_IMAGE=true` (recommended for production) rejects floating OpenClaw images such as `:latest`
- `NEXT_PUBLIC_DEPLOY_POLL_INTERVAL_MS` controls dashboard polling in browser (default `10000`)
- `PG_POOL_MAX`/`PG_IDLE_TIMEOUT_MS`/`PG_CONNECTION_TIMEOUT_MS` tune DB pool usage for serverless (defaults are safe for small Supabase poolers)

Deployment flavors in onboarding:

- `simple_agent_free` (Simple Agent serverless runtime)
- `simple_agent_videomemory_free` (Simple Agent + VideoMemory MCP sidecar)
`simple_agent_videomemory_free` remains on the legacy SSH/DO runtime and is intentionally unchanged.

Simple Agent Microservices flavor env knobs:

- required images: `SIMPLE_AGENT_MICROSERVICES_FRONTEND_IMAGE`, `SIMPLE_AGENT_MICROSERVICES_GATEWAY_IMAGE`, `SIMPLE_AGENT_MICROSERVICES_EXECUTION_IMAGE`, `SIMPLE_AGENT_MICROSERVICES_POST_IMAGE`
- optional images/config: `SIMPLE_AGENT_MICROSERVICES_REDIS_IMAGE`, `SIMPLE_AGENT_MICROSERVICES_POSTGRES_IMAGE`
- OttoAuth MCP sidecar image/config (required for shared OttoAuth compatibility): `SIMPLE_AGENT_MICROSERVICES_MCP_IMAGE`, `SIMPLE_AGENT_MICROSERVICES_MCP_TOOL_SERVICE_URL`, `SIMPLE_AGENT_MICROSERVICES_MCP_AUTO_OFF_IDLE_S`, `SIMPLE_AGENT_MICROSERVICES_MCP_LOOP_INTERVAL_S`
- optional runtime sizing: `SIMPLE_AGENT_MICROSERVICES_TASK_CPU`, `SIMPLE_AGENT_MICROSERVICES_TASK_MEMORY`
- optional runtime behavior: `SIMPLE_AGENT_MICROSERVICES_FRONTEND_PORT` (default `18789`), `SIMPLE_AGENT_MICROSERVICES_HEALTH_PATH`, `SIMPLE_AGENT_MICROSERVICES_TELEGRAM_API_BASE`
- shared runtime flavor: set `SIMPLE_AGENT_MICROSERVICES_SHARED_RUNTIME_ID` (recommended, `ecs:<cluster>|<service>`) or `SIMPLE_AGENT_MICROSERVICES_SHARED_BASE_URL`
- default heartbeat bootstrap for microservices flavors: `SIMPLE_AGENT_MICROSERVICES_DEFAULT_HEARTBEAT_INTERVAL_S` (default `86400`, 24h), optional `SIMPLE_AGENT_MICROSERVICES_DEFAULT_HEARTBEAT_CONTENT`
- OttoAuth MCP integration for shared flavor uses `OTTOAGENT_MCP_BASE_URL` (default `https://ottoauth.vercel.app`) and `OTTOAGENT_MCP_TOKEN`; shared deployments default-enable discovered OttoAuth MCP tools and validate tool discovery + callback route before marking deployment ready.

OttoAgent flavor env knobs:

- `OTTOAGENT_IMAGE` / `OTTOAGENT_BUILD_ON_HOST` / `OTTOAGENT_BUILD_REPO`
- `OTTOAGENT_CONTAINER_PORT` / `OTTOAGENT_START_COMMAND`
- `OTTOAGENT_MODEL` / `OTTOAGENT_LLM_URL`
- `OTTOAGENT_MCP_IMAGE` / `OTTOAGENT_MCP_BUILD_ON_HOST` / `OTTOAGENT_MCP_BUILD_REPO`
- `OTTOAGENT_MCP_PORT` / `OTTOAGENT_MCP_PATH` / `OTTOAGENT_MCP_START_COMMAND`
- optional passthroughs for MCP container auth/config: `OTTOAGENT_MCP_BASE_URL`, `OTTOAGENT_MCP_TOKEN`, `OTTOAGENT_MCP_REFRESH_MS` (default `86400000`, 24h heartbeat/refresh)
- `OTTOAGENT_MCP_BUILD_REPO` is optional; if omitted, OneClick builds a built-in OttoAuth MCP HTTP bridge image.
  - Built-in bridge behavior: keeps `ottoauth_list_services` / `ottoauth_get_service` / `ottoauth_http_request`, auto-discovers endpoint-specific OttoAuth tools from docs, and returns structured HTTP failure payloads (status/url/body) instead of generic RPC errors.

## Run

```bash
npm install
npm run dev
```

Worker (separate process):

```bash
npm run worker -- --run
```

## Cost Guardrails (recommended)

Application-level hard limits (cheap + effective):

- `DEPLOYMENTS_PAUSED=true` to block all new deployments
- `DEPLOY_MAX_IN_PROGRESS_GLOBAL` to cap total `queued/starting` deployments
- `DEPLOY_MAX_READY_GLOBAL` to cap total running bots (`ready`)

Age-based auto-stop sweep (optional):

- Set `DEPLOY_AUTO_STOP_READY_AFTER_MINUTES` (for example `180`)
- Dry run: `DEPLOY_COST_GUARD_DRY_RUN=true npm run cost:guard:sweep`
- Real run: `npm run cost:guard:sweep`

This sweep stops `ready` deployments older than the configured age and marks them failed with a cost-guard reason.

## AWS ECS (minimal manual setup)

The repo includes a Terraform stack that creates the AWS base infra for ECS mode (VPC, subnets, security group, ECS cluster, IAM roles, logs, ECR).

Fastest path:

```bash
# In your shell (use the IAM access key you created)
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1

# Creates/updates AWS infra and writes .env.aws-ecs
npm run aws:bootstrap
```

Then copy values from `.env.aws-ecs` into your app runtime env (`.env.local`, Vercel env, etc.) and set `DEPLOY_PROVIDER=ecs`.

Infra source: `infra/aws/`

### SQS Lambda consumer sync

Deploying app code does not automatically update the SQS Lambda consumer bundle. After worker/deploy logic changes, run:

```bash
npm run aws:deploy-worker
```

This updates `oneclick-sqs-deploy-consumer` code and stamps `DEPLOY_WORKER_FEATURES` so app can block unsupported deployment flavors (for example `simple_agent_microservices_ecs`, `simple_agent_microservices_shared_ottoauth`, `ottoagent_free`, and `simple_agent_ottoauth_ecs_canary`) instead of silently launching partial runtimes.

### ECS runtime smoke test (recommended)

After changing `OPENCLAW_IMAGE` (or any ECS runtime settings), run:

```bash
npm run aws:smoke
```

This now validates:

- ECS service create/update/delete path
- Task reaches `running`
- OpenClaw Control UI shell is served
- Control UI JS asset loads
- `__openclaw/control-ui-config.json` responds

Optional Telegram probe validation (helps catch runtime Telegram regressions):

```bash
ECS_SMOKE_TELEGRAM_TOKEN=<your-bot-token> npm run aws:smoke
```

### Shared Microservices OttoAuth smoke test (recommended)

Use this after shared-runtime or OttoAuth MCP changes:

```bash
npm run aws:smoke:shared-ottoauth
```

Optional overrides:

```bash
# direct runtime URL override (otherwise uses SIMPLE_AGENT_MICROSERVICES_SHARED_* env)
ECS_SHARED_OTTOAUTH_SMOKE_BASE_URL=https://runtime.example.com \
npm run aws:smoke:shared-ottoauth

# include mutating endpoint-tools in smoke run (default: false / skip mutating)
ECS_SHARED_OTTOAUTH_SMOKE_ALLOW_MUTATING_TOOLS=true \
npm run aws:smoke:shared-ottoauth
```

### Serverless Telegram smoke test (recommended for dogfooding)

Use this to validate serverless Telegram ingestion, session persistence, runtime event logging, and replay execution parity.

```bash
ONECLICK_TELEGRAM_SMOKE_DEPLOYMENT_ID=<deployment-id> \
ONECLICK_TELEGRAM_SMOKE_CHAT_ID=<telegram-chat-id> \
ONECLICK_TELEGRAM_SMOKE_BASE_URL=https://www.oneclickagent.net \
npm run smoke:telegram:serverless
```

Optional strict mode:

```bash
# Require both webhook + replay execution to be fully processed (not just logged)
ONECLICK_TELEGRAM_SMOKE_REQUIRE_PROCESSED=true \
ONECLICK_TELEGRAM_SMOKE_DEPLOYMENT_ID=<deployment-id> \
ONECLICK_TELEGRAM_SMOKE_CHAT_ID=<telegram-chat-id> \
ONECLICK_TELEGRAM_SMOKE_BASE_URL=https://www.oneclickagent.net \
npm run smoke:telegram:serverless
```

Notes:
- Requires `DATABASE_URL` access to the same DB used by OneClick runtime APIs.
- Uses the deployment's existing `telegram_bot_token`; no extra token env is required.

If your shared runtime is missing the `mcp-tool-service` sidecar, build/push and roll it in-place:

```bash
npm run aws:build:mcp-tool-service
npm run aws:shared:mcp:ensure
```

### Runtime version promotion / rollback

OneClick uses `runtime_versions` as the stable pointer for new deployments.

Register candidate:

```bash
npm run runtime:register -- simpleagent_embedded embedded-v2 candidate simpleagent:embedded-v2
```

Promote candidate to stable:

```bash
npm run runtime:promote -- simpleagent_embedded embedded-v2
```

Rollback:

```bash
# rollback to most recent previous candidate
npm run runtime:rollback -- simpleagent_embedded

# or rollback to explicit version
npm run runtime:rollback -- simpleagent_embedded embedded-v1
```

Detailed release procedure:
- `docs/RUNTIME_RELEASE_RUNBOOK.md`

### Optional AWS Budget Alerts

The Terraform stack supports opt-in monthly cost alerts via AWS Budgets.

In `infra/aws/terraform.tfvars`, set for example:

```hcl
enable_monthly_budget_alerts = true
monthly_budget_limit_usd = 25
budget_alert_email_addresses = ["you@example.com"]
```

Then re-run:

```bash
npm run aws:bootstrap
```

## Vercel deployment

- This app is Vercel-compatible out of the box.
- If `REDIS_URL` is not set, deployments are processed in-process (no separate worker required).
- On Vercel, set:
  - `AUTH_URL=https://your-app.vercel.app`
  - `APP_BASE_URL=https://your-app.vercel.app`
  - `AUTH_COOKIE_DOMAIN=.yourdomain.com` (optional, but recommended when app + bot dashboards use sibling subdomains)
  - `BOT_AUTH_LOGIN_BASE_URL=https://app.yourdomain.com` (optional canonical login host for bot subdomains)
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
- set `RUNTIME_BASE_DOMAIN` (for example `oneclickagent.net`) to enable `https://<user>.yourdomain` URLs
- set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` so deploy worker can create/update runtime DNS records automatically
- optional: set `BOT_DASHBOARD_BASE_DOMAIN` to enable bot dashboard URLs at `https://<bot-slug>.yourdomain` (routes to `/bots/:slug`)
- optional but recommended for shared auth sessions across `app.yourdomain` + `bot.yourdomain`: set `AUTH_COOKIE_DOMAIN=.yourdomain`
- optional: set `BOT_AUTH_LOGIN_BASE_URL` to your canonical app host (for example `https://app.yourdomain`) so unauthenticated bot subdomain visits always go through one login origin
- optional: set `CADDY_EMAIL` for certificate issuer contact
- do not set `REDIS_URL` to localhost; either provide a real remote Redis or leave `REDIS_URL` unset
- each new deploy for a user destroys that user’s previous container
- if using `RUNTIME_BASE_DOMAIN`, open VM ports `80/443`; runtime subdomains are managed automatically via Cloudflare DNS API
- deployment step: after launch, enter the customer’s own OpenAI or Anthropic API key in OpenClaw (never use your personal key in customer deployments)

### Wildcard DNS quick setup

If you want bot dashboards on `botname.oneclickagent.net`, use a dedicated dashboard base domain and add wildcard DNS:

1. Pick domains so runtime and dashboard traffic do not conflict:
   - App/login host: `app.oneclickagent.net` (points to Vercel app)
   - Bot dashboard host wildcard: `*.oneclickagent.net` (also points to Vercel app)
   - Runtime host wildcard: use a different base domain such as `*.runtime.oneclickagent.net` (points to your runtime host/proxy)
2. Add DNS records:
   - `app` CNAME -> your Vercel target (or A/ALIAS depending provider)
   - `*` CNAME -> same Vercel target (for bot dashboard subdomains)
   - `*.runtime` A/CNAME -> your runtime ingress host
3. In Vercel project domains:
   - add `app.oneclickagent.net`
   - add `*.oneclickagent.net`
4. Set environment variables:
   - `APP_BASE_URL=https://app.oneclickagent.net`
   - `AUTH_URL=https://app.oneclickagent.net`
   - `BOT_DASHBOARD_BASE_DOMAIN=oneclickagent.net`
   - `BOT_AUTH_LOGIN_BASE_URL=https://app.oneclickagent.net`
   - `AUTH_COOKIE_DOMAIN=.oneclickagent.net`
   - `RUNTIME_BASE_DOMAIN=runtime.oneclickagent.net`
5. Update Google OAuth callback URL:
   - `https://app.oneclickagent.net/api/auth/callback/google`

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
