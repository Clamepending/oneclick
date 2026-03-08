# Runtime Release Runbook

Purpose: safely roll new runtime behavior into OneClick by promoting tested runtime versions from `candidate` to `stable`.

## Scope

- Runtime kinds:
  - `simpleagent_embedded` (serverless path)
  - `simpleagent_vm_ssh` (VideoMemory SSH path)
- Contract gate:
  - `runtime_contract_version` must be `v1`

## Important behavior

- New deployments now resolve runtime version from `runtime_versions` where `status='stable'`.
- Existing deployments remain pinned to the metadata already stored on that deployment row.
- Redeploying creates a new deployment and resolves runtime metadata from current stable.

## Prerequisites

1. `DATABASE_URL` points to the target OneClick database.
2. Runtime candidate has already been built/published.
3. Smoke prerequisites are available:
   - ECS smoke env (if testing ECS paths)
   - Telegram smoke env (`ONECLICK_TELEGRAM_SMOKE_*`) for serverless webhook/session/replay validation

## 1) Register a candidate version

```bash
cd /Users/mark/Desktop/projects/oneclick
npm run runtime:register -- simpleagent_embedded embedded-v2 candidate simpleagent:embedded-v2
```

For VideoMemory/SSH runtime:

```bash
npm run runtime:register -- simpleagent_vm_ssh vm-legacy-v2 candidate simpleagent:vm-legacy-v2
```

## 2) Run release validation

Serverless Telegram regression smoke:

```bash
ONECLICK_TELEGRAM_SMOKE_REQUIRE_PROCESSED=true \
ONECLICK_TELEGRAM_SMOKE_DEPLOYMENT_ID=<deployment-id> \
ONECLICK_TELEGRAM_SMOKE_CHAT_ID=<telegram-chat-id> \
ONECLICK_TELEGRAM_SMOKE_BASE_URL=https://www.oneclickagent.net \
npm run smoke:telegram:serverless
```

Optional additional checks:

```bash
npm run aws:smoke
npm run aws:smoke:shared-ottoauth
```

VideoMemory freeze gate (required before promoting shared refactors):

1. Verify `simple_agent_videomemory_free` still routes via SSH in deploy strategy.
2. Run existing VideoMemory smoke flow and confirm callback/webhook path stays healthy.

## 3) Promote candidate to stable

```bash
npm run runtime:promote -- simpleagent_embedded embedded-v2
```

This demotes current stable to `candidate` and marks target as `stable`.

## 4) Verify rollout pointer

Use SQL or admin tooling to confirm one stable row per kind:

```sql
SELECT runtime_kind, runtime_version, status, promoted_at
FROM runtime_versions
WHERE runtime_kind IN ('simpleagent_embedded', 'simpleagent_vm_ssh')
ORDER BY runtime_kind, promoted_at DESC NULLS LAST, created_at DESC;
```

Then create a fresh deployment and verify deployment metadata event includes the new stable version.

## 5) Rollback (if regressions are detected)

Rollback to the most recent prior candidate:

```bash
npm run runtime:rollback -- simpleagent_embedded
```

Or rollback to a specific known-good version:

```bash
npm run runtime:rollback -- simpleagent_embedded embedded-v1
```

Repeat smoke validation after rollback.

