import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required.");
}

const poolMax = Number(process.env.PG_POOL_MAX ?? "1");
const poolIdleTimeoutMs = Number(process.env.PG_IDLE_TIMEOUT_MS ?? "10000");
const poolConnectionTimeoutMs = Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? "5000");

export const pool = new Pool({
  connectionString,
  max: poolMax,
  idleTimeoutMillis: poolIdleTimeoutMs,
  connectionTimeoutMillis: poolConnectionTimeoutMs,
});

let initialized = false;

export async function ensureSchema() {
  if (initialized) return;
  try {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS onboarding_sessions (
      user_id TEXT PRIMARY KEY,
      bot_name TEXT NOT NULL DEFAULT '',
      channel TEXT,
      model_provider TEXT,
      model_api_key TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      current_step INT NOT NULL DEFAULT 1,
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      bot_name TEXT,
      status TEXT NOT NULL,
      host_name TEXT,
      runtime_id TEXT,
      deploy_provider TEXT,
      model_provider TEXT,
      default_model TEXT,
      subsidy_proxy_token TEXT,
      openai_api_key TEXT,
      anthropic_api_key TEXT,
      openrouter_api_key TEXT,
      telegram_bot_token TEXT,
      runtime_user_id TEXT,
      runtime_bot_id TEXT,
      runtime_bot_secret TEXT,
      runtime_kind TEXT,
      runtime_version TEXT,
      runtime_contract_version TEXT,
      runtime_release_channel TEXT,
      ready_url TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS runtime_id TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deploy_provider TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS model_provider TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS default_model TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS bot_name TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS subsidy_proxy_token TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS openai_api_key TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS anthropic_api_key TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS openrouter_api_key TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS runtime_user_id TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS runtime_bot_id TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS runtime_bot_secret TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS runtime_kind TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS runtime_version TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS runtime_contract_version TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS runtime_release_channel TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'free';`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deactivation_reason TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS monthly_price_cents INT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deployment_flavor TEXT NOT NULL DEFAULT 'basic';`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS video_memory_ready_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS model_provider TEXT;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS model_api_key TEXT;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS deployment_flavor TEXT NOT NULL DEFAULT 'basic';`);
  await pool.query(`UPDATE deployments SET deployment_flavor = 'do_vm' WHERE deployment_flavor = 'lightsail';`);
  await pool.query(`UPDATE onboarding_sessions SET deployment_flavor = 'do_vm' WHERE deployment_flavor = 'lightsail';`);
  await pool.query(`UPDATE deployments SET deployment_flavor = 'deploy_openclaw_free' WHERE deployment_flavor IN ('do_vm', 'basic', 'lightsail');`);
  await pool.query(`UPDATE onboarding_sessions SET deployment_flavor = 'deploy_openclaw_free' WHERE deployment_flavor IN ('do_vm', 'basic', 'lightsail');`);
  await pool.query(`ALTER TABLE deployments ALTER COLUMN deployment_flavor SET DEFAULT 'simple_agent_free';`);
  await pool.query(`ALTER TABLE onboarding_sessions ALTER COLUMN deployment_flavor SET DEFAULT 'simple_agent_free';`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS deployments_user_id_idx ON deployments (user_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS deployments_trial_expiry_idx
    ON deployments (trial_expires_at)
    WHERE plan_tier = 'free';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deployment_events (
      id BIGSERIAL PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS runtime_chat_sessions (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS runtime_chat_messages (
      id BIGSERIAL PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      session_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE runtime_chat_messages ADD COLUMN IF NOT EXISTS session_id TEXT;`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS deployment_events_deployment_id_idx
    ON deployment_events (deployment_id, created_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS runtime_chat_messages_deployment_id_idx
    ON runtime_chat_messages (deployment_id, id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS runtime_chat_sessions_deployment_id_idx
    ON runtime_chat_sessions (deployment_id, updated_at DESC, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS runtime_chat_messages_deployment_session_id_idx
    ON runtime_chat_messages (deployment_id, session_id, id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS runtime_memory_docs (
      deployment_id TEXT NOT NULL,
      doc_key TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (deployment_id, doc_key)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS runtime_memory_docs_deployment_id_idx
    ON runtime_memory_docs (deployment_id, updated_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS runtime_memory_doc_prefs (
      deployment_id TEXT NOT NULL,
      doc_key TEXT NOT NULL,
      self_update_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (deployment_id, doc_key)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS runtime_memory_doc_prefs_deployment_id_idx
    ON runtime_memory_doc_prefs (deployment_id, updated_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS runtime_ottoauth_accounts (
      deployment_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      username TEXT NOT NULL,
      private_key TEXT NOT NULL,
      callback_url TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (deployment_id, bot_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS runtime_ottoauth_accounts_deployment_id_idx
    ON runtime_ottoauth_accounts (deployment_id, updated_at DESC);
  `);

  await pool.query(`
    WITH legacy_deployments AS (
      SELECT DISTINCT deployment_id
      FROM runtime_chat_messages
      WHERE session_id IS NULL
    ),
    created AS (
      INSERT INTO runtime_chat_sessions (id, deployment_id, name, created_at, updated_at)
      SELECT CONCAT('legacy_', deployment_id), deployment_id, 'Session 1', NOW(), NOW()
      FROM legacy_deployments
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    )
    UPDATE runtime_chat_messages
    SET session_id = CONCAT('legacy_', deployment_id)
    WHERE session_id IS NULL;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subsidy_usage_events (
      id BIGSERIAL PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      user_id TEXT,
      http_status INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE subsidy_usage_events ADD COLUMN IF NOT EXISTS user_id TEXT;`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS subsidy_usage_events_created_at_idx
    ON subsidy_usage_events (created_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS subsidy_usage_events_deployment_id_idx
    ON subsidy_usage_events (deployment_id, created_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_identities (
      id BIGSERIAL PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      bot_name TEXT NOT NULL,
      bot_name_normalized TEXT NOT NULL UNIQUE,
      runtime_slug TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS bot_identities_owner_user_id_idx
    ON bot_identities (owner_user_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS runtime_versions (
      id BIGSERIAL PRIMARY KEY,
      runtime_kind TEXT NOT NULL,
      runtime_version TEXT NOT NULL,
      runtime_contract_version TEXT NOT NULL,
      status TEXT NOT NULL,
      artifact_ref TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      promoted_at TIMESTAMPTZ,
      UNIQUE (runtime_kind, runtime_version)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS runtime_versions_kind_status_idx
    ON runtime_versions (runtime_kind, status, created_at DESC);
  `);

  await pool.query(
    `INSERT INTO runtime_versions (
       runtime_kind,
       runtime_version,
       runtime_contract_version,
       status,
       artifact_ref,
       metadata,
       promoted_at
     )
     VALUES (
       'simpleagent_embedded',
       $1,
       'v1',
       'stable',
       'embedded-runtime',
       '{"seed":"ensureSchema"}'::jsonb,
       NOW()
     )
     ON CONFLICT (runtime_kind, runtime_version)
     DO NOTHING`,
    [(process.env.SIMPLE_AGENT_EMBEDDED_RUNTIME_VERSION ?? "embedded-v1").trim() || "embedded-v1"],
  );

  await pool.query(
    `INSERT INTO runtime_versions (
       runtime_kind,
       runtime_version,
       runtime_contract_version,
       status,
       artifact_ref,
       metadata,
       promoted_at
     )
     VALUES (
       'simpleagent_vm_ssh',
       $1,
       'v1',
       'stable',
       'vm-runtime',
       '{"seed":"ensureSchema"}'::jsonb,
       NOW()
     )
     ON CONFLICT (runtime_kind, runtime_version)
     DO NOTHING`,
    [(process.env.SIMPLE_AGENT_VM_RUNTIME_VERSION ?? "vm-legacy-v1").trim() || "vm-legacy-v1"],
  );
    initialized = true;
  } catch (error) {
    initialized = false;
    throw error;
  }
}
