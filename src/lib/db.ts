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
      subsidy_proxy_token TEXT,
      openai_api_key TEXT,
      anthropic_api_key TEXT,
      openrouter_api_key TEXT,
      telegram_bot_token TEXT,
      ready_url TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS runtime_id TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deploy_provider TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS bot_name TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS subsidy_proxy_token TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS openai_api_key TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS anthropic_api_key TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS openrouter_api_key TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'free';`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deactivation_reason TEXT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS monthly_price_cents INT;`);
  await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deployment_flavor TEXT NOT NULL DEFAULT 'basic';`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS model_provider TEXT;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS model_api_key TEXT;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS deployment_flavor TEXT NOT NULL DEFAULT 'basic';`);
  await pool.query(`UPDATE deployments SET deployment_flavor = 'do_vm' WHERE deployment_flavor = 'lightsail';`);
  await pool.query(`UPDATE onboarding_sessions SET deployment_flavor = 'do_vm' WHERE deployment_flavor = 'lightsail';`);

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
    CREATE INDEX IF NOT EXISTS deployment_events_deployment_id_idx
    ON deployment_events (deployment_id, created_at);
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
    initialized = true;
  } catch (error) {
    initialized = false;
    throw error;
  }
}
