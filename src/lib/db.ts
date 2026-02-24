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
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS model_provider TEXT;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS model_api_key TEXT;`);
  await pool.query(`ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT;`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS deployments_user_id_idx ON deployments (user_id);
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
