import { config as loadEnv } from "dotenv";
import { RUNTIME_CONTRACT_VERSION, type RuntimeKind } from "@/lib/runtime/runtimeMetadata";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

type RuntimeVersionRow = {
  runtime_kind: string;
  runtime_version: string;
  runtime_contract_version: string;
  status: string;
  promoted_at: string | null;
  created_at: string;
};

const ALLOWED_KINDS: RuntimeKind[] = ["simpleagent_embedded", "simpleagent_vm_ssh"];

function usage() {
  console.log("Usage: npm run runtime:promote -- <runtime_kind> <runtime_version>");
  console.log(`Allowed runtime_kind: ${ALLOWED_KINDS.join(", ")}`);
}

function parseArgs() {
  const runtimeKind = (process.argv[2] ?? "").trim();
  const runtimeVersion = (process.argv[3] ?? "").trim();
  if (!runtimeKind || !runtimeVersion) {
    usage();
    throw new Error("Missing required args.");
  }
  if (!ALLOWED_KINDS.includes(runtimeKind as RuntimeKind)) {
    usage();
    throw new Error(`Unsupported runtime_kind: ${runtimeKind}`);
  }
  return {
    runtimeKind: runtimeKind as RuntimeKind,
    runtimeVersion,
  };
}

async function main() {
  const args = parseArgs();
  const { ensureSchema, pool } = await import("@/lib/db");
  await ensureSchema();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const target = await client.query<RuntimeVersionRow>(
      `SELECT runtime_kind,
              runtime_version,
              runtime_contract_version,
              status,
              promoted_at,
              created_at
       FROM runtime_versions
       WHERE runtime_kind = $1
         AND runtime_version = $2
       LIMIT 1
       FOR UPDATE`,
      [args.runtimeKind, args.runtimeVersion],
    );
    const targetRow = target.rows[0];
    if (!targetRow) {
      throw new Error(
        `Target runtime version not found (${args.runtimeKind}:${args.runtimeVersion}). Register it as candidate first.`,
      );
    }
    if ((targetRow.status ?? "").trim().toLowerCase() === "disabled") {
      throw new Error(`Cannot promote disabled runtime version (${args.runtimeKind}:${args.runtimeVersion}).`);
    }
    if ((targetRow.runtime_contract_version ?? "").trim() !== RUNTIME_CONTRACT_VERSION) {
      throw new Error(
        `Contract mismatch: target=${targetRow.runtime_contract_version} expected=${RUNTIME_CONTRACT_VERSION}.`,
      );
    }

    const currentStable = await client.query<RuntimeVersionRow>(
      `SELECT runtime_kind,
              runtime_version,
              runtime_contract_version,
              status,
              promoted_at,
              created_at
       FROM runtime_versions
       WHERE runtime_kind = $1
         AND status = 'stable'
       ORDER BY COALESCE(promoted_at, created_at) DESC, created_at DESC
       FOR UPDATE`,
      [args.runtimeKind],
    );
    const previousStable = currentStable.rows[0] ?? null;

    await client.query(
      `UPDATE runtime_versions
       SET status = 'candidate'
       WHERE runtime_kind = $1
         AND status = 'stable'
         AND runtime_version <> $2`,
      [args.runtimeKind, args.runtimeVersion],
    );

    await client.query(
      `UPDATE runtime_versions
       SET status = 'stable',
           promoted_at = NOW()
       WHERE runtime_kind = $1
         AND runtime_version = $2`,
      [args.runtimeKind, args.runtimeVersion],
    );

    await client.query("COMMIT");

    const previous = previousStable ? `${previousStable.runtime_version}` : "none";
    console.log(
      `Promoted ${args.runtimeKind}:${args.runtimeVersion} to stable (previous stable: ${previous}).`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end().catch(() => null);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`runtime:promote failed: ${message}`);
  process.exitCode = 1;
});
