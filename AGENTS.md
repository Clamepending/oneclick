# Repo Preferences (OneClick)

This file captures project-specific working preferences so future chats/agents can continue consistently.

## Collaboration preferences

- Prefer doing the work directly (code + infra) with minimal user manual steps.
- Explain AWS/infrastructure issues in plain English.
- When user action is required, give a short, concrete checklist.
- Test changes (including likely edge cases) before reporting done.
- Keep the codebase minimalist; remove stale paths/dependencies/docs when safely possible.

## Deployment / release workflow

- Push to `main` only; do **not** manually trigger Vercel deploys unless explicitly asked.
- Vercel auto-deploys from `main`.
- If local repo is dirty/unrelated changes exist, use a clean git worktree for production-safe commits/pushes.

## Current production architecture (authoritative)

- App hosting: Vercel
- Runtime deployment provider: AWS ECS/Fargate (`DEPLOY_PROVIDER=ecs`)
- Deployment queue: AWS SQS + AWS Lambda consumer (`DEPLOY_QUEUE_PROVIDER=sqs`)
- Queue consumer is AWS Lambda (event-driven), not a local/always-on worker
- Redis/BullMQ is removed from the deployment path and should not be reintroduced unless explicitly requested

## Cost / safety priorities

- Cost control is a top priority (user expects low-volume usage and wants to avoid surprise AWS bills).
- Prefer low-cost defaults and scale-to-zero patterns when possible.
- Keep ECS task sizing conservative unless there is a clear need to increase it.
- Avoid orphaned ECS services/tasks; clean up failed deployments automatically when possible.
- Preserve and improve budget alerts / cost guardrails rather than removing them.

## Infra change safety

- Be careful editing `.env` / `.env.local`; avoid breaking existing values.
- Prefer scripts/tooling that merge env vars safely and avoid accidental trailing newlines in secrets.
- If a change could affect production runtime behavior, summarize the impact clearly before/after deployment.

## Legacy paths to avoid

- Do not use or restore DigitalOcean deployment code.
- Do not rely on SSH host-pool deployment for normal production flow unless explicitly requested.
- Do not tell the user to run a local deployment worker for normal operation (Lambda consumer handles queue jobs).

## UX / debugging preferences

- Favor clear, actionable deployment errors (queue unavailable, ECS timeout reason, cleanup outcome).
- Admin/debug views should help identify the newest active deployment and avoid confusing stale runtime links.

## Production tolerance

- There are currently no real customers; disruption is acceptable if it simplifies architecture and reduces cost.
- The user’s own deployment can be replaced/killed during infrastructure migrations if needed (with a clear note).
