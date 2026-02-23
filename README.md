# OneClick OpenClaw

Minimal v1 implementation of a managed-first one-click deploy flow.

## Included in v1

- Google sign-in
- 3-step onboarding
- Async deployment creation (`queued -> starting -> ready|failed`)
- Progress polling page
- Shared-host model with one OpenClaw container per user (provider adapter ready)
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
- `DATABASE_URL`
- `HOST_POOL_JSON`
- `OPENCLAW_IMAGE`

Optional for background queue mode:

- `REDIS_URL` (required only if using separate worker process)

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

## API

- `POST /api/onboarding/start`
- `POST /api/onboarding/step`
- `POST /api/deployments`
- `GET /api/deployments/:id`
- `GET /api/deployments/:id/events`

## Acceptance checklist

- Onboarding reaches deploy click in 3 screens.
- Deploy API returns quickly with `queued`.
- Deployment status transitions show on `/deployments/:id`.
- Build passes: `npm run build`.
