import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required.");
}

export const pool = new Pool({ connectionString });

let initialized = false;

export async function ensureSchema() {
  if (initialized) return;
  initialized = true;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS onboarding_sessions (
      user_id TEXT PRIMARY KEY,
      bot_name TEXT NOT NULL DEFAULT '',
      channel TEXT,
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
      status TEXT NOT NULL,
      host_name TEXT,
      ready_url TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

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
}
