import { config as loadEnv } from "dotenv";
import { RUNTIME_CONTRACT_VERSION, type RuntimeKind } from "@/lib/runtime/runtimeMetadata";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

const ALLOWED_KINDS: RuntimeKind[] = ["simpleagent_embedded", "simpleagent_vm_ssh"];
const ALLOWED_STATUS = ["candidate", "stable", "disabled"] as const;
type RuntimeStatus = (typeof ALLOWED_STATUS)[number];

function usage() {
  console.log(
    "Usage: npm run runtime:register -- <runtime_kind> <runtime_version> [status=candidate] [artifact_ref]",
  );
  console.log(`Allowed runtime_kind: ${ALLOWED_KINDS.join(", ")}`);
  console.log(`Allowed status: ${ALLOWED_STATUS.join(", ")}`);
}

function parseArgs() {
  const runtimeKind = (process.argv[2] ?? "").trim();
  const runtimeVersion = (process.argv[3] ?? "").trim();
  const statusRaw = (process.argv[4] ?? "candidate").trim().toLowerCase();
  const artifactRef = (process.argv[5] ?? "").trim() || null;

  if (!runtimeKind || !runtimeVersion) {
    usage();
    throw new Error("Missing required args.");
  }
  if (!ALLOWED_KINDS.includes(runtimeKind as RuntimeKind)) {
    usage();
    throw new Error(`Unsupported runtime_kind: ${runtimeKind}`);
  }
  if (!ALLOWED_STATUS.includes(statusRaw as RuntimeStatus)) {
    usage();
    throw new Error(`Unsupported status: ${statusRaw}`);
  }
  return {
    runtimeKind: runtimeKind as RuntimeKind,
    runtimeVersion,
    status: statusRaw as RuntimeStatus,
    artifactRef,
  };
}

async function main() {
  const args = parseArgs();
  const { ensureSchema, pool } = await import("@/lib/db");
  await ensureSchema();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (args.status === "stable") {
      await client.query(
        `UPDATE runtime_versions
         SET status = 'candidate'
         WHERE runtime_kind = $1
           AND status = 'stable'
           AND runtime_version <> $2`,
        [args.runtimeKind, args.runtimeVersion],
      );
    }

    await client.query(
      `INSERT INTO runtime_versions (
         runtime_kind,
         runtime_version,
         runtime_contract_version,
         status,
         artifact_ref,
         metadata,
         promoted_at,
         created_at
       )
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, CASE WHEN $4 = 'stable' THEN NOW() ELSE NULL END, NOW())
       ON CONFLICT (runtime_kind, runtime_version)
       DO UPDATE
         SET runtime_contract_version = EXCLUDED.runtime_contract_version,
             status = EXCLUDED.status,
             artifact_ref = EXCLUDED.artifact_ref,
             promoted_at = CASE
               WHEN EXCLUDED.status = 'stable' THEN NOW()
               ELSE runtime_versions.promoted_at
             END`,
      [args.runtimeKind, args.runtimeVersion, RUNTIME_CONTRACT_VERSION, args.status, args.artifactRef],
    );

    await client.query("COMMIT");
    console.log(
      `Registered runtime version: kind=${args.runtimeKind} version=${args.runtimeVersion} status=${args.status} artifact=${args.artifactRef ?? "n/a"}`,
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
  console.error(`runtime:register failed: ${message}`);
  process.exitCode = 1;
});
