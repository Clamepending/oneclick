import { config as loadEnv } from "dotenv";
import { type RuntimeKind } from "@/lib/runtime/runtimeMetadata";

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
  console.log("Usage: npm run runtime:rollback -- <runtime_kind> [target_runtime_version]");
  console.log(`Allowed runtime_kind: ${ALLOWED_KINDS.join(", ")}`);
}

function parseArgs() {
  const runtimeKind = (process.argv[2] ?? "").trim();
  const targetRuntimeVersion = (process.argv[3] ?? "").trim() || null;
  if (!runtimeKind) {
    usage();
    throw new Error("Missing runtime_kind arg.");
  }
  if (!ALLOWED_KINDS.includes(runtimeKind as RuntimeKind)) {
    usage();
    throw new Error(`Unsupported runtime_kind: ${runtimeKind}`);
  }
  return {
    runtimeKind: runtimeKind as RuntimeKind,
    targetRuntimeVersion,
  };
}

async function main() {
  const args = parseArgs();
  const { ensureSchema, pool } = await import("@/lib/db");
  await ensureSchema();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const stable = await client.query<RuntimeVersionRow>(
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
       LIMIT 1
       FOR UPDATE`,
      [args.runtimeKind],
    );
    const stableRow = stable.rows[0];
    if (!stableRow) {
      throw new Error(`No stable runtime found for runtime_kind=${args.runtimeKind}.`);
    }

    const target = args.targetRuntimeVersion
      ? await client.query<RuntimeVersionRow>(
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
          [args.runtimeKind, args.targetRuntimeVersion],
        )
      : await client.query<RuntimeVersionRow>(
          `SELECT runtime_kind,
                  runtime_version,
                  runtime_contract_version,
                  status,
                  promoted_at,
                  created_at
           FROM runtime_versions
           WHERE runtime_kind = $1
             AND runtime_version <> $2
             AND status IN ('candidate', 'stable')
           ORDER BY COALESCE(promoted_at, created_at) DESC, created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [args.runtimeKind, stableRow.runtime_version],
        );
    const targetRow = target.rows[0];
    if (!targetRow) {
      throw new Error(
        args.targetRuntimeVersion
          ? `Target runtime version not found: ${args.runtimeKind}:${args.targetRuntimeVersion}.`
          : `No rollback candidate available for runtime_kind=${args.runtimeKind}.`,
      );
    }
    if (targetRow.runtime_version === stableRow.runtime_version) {
      console.log(
        `Rollback no-op: ${args.runtimeKind}:${targetRow.runtime_version} is already stable.`,
      );
      await client.query("COMMIT");
      return;
    }
    if ((targetRow.status ?? "").trim().toLowerCase() === "disabled") {
      throw new Error(`Cannot rollback to disabled runtime version (${args.runtimeKind}:${targetRow.runtime_version}).`);
    }
    if (targetRow.runtime_contract_version !== stableRow.runtime_contract_version) {
      throw new Error(
        `Contract mismatch: stable=${stableRow.runtime_contract_version} target=${targetRow.runtime_contract_version}.`,
      );
    }

    await client.query(
      `UPDATE runtime_versions
       SET status = 'candidate'
       WHERE runtime_kind = $1
         AND runtime_version = $2`,
      [args.runtimeKind, stableRow.runtime_version],
    );

    await client.query(
      `UPDATE runtime_versions
       SET status = 'stable',
           promoted_at = NOW()
       WHERE runtime_kind = $1
         AND runtime_version = $2`,
      [args.runtimeKind, targetRow.runtime_version],
    );

    await client.query("COMMIT");
    console.log(
      `Rolled back ${args.runtimeKind} stable from ${stableRow.runtime_version} to ${targetRow.runtime_version}.`,
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
  console.error(`runtime:rollback failed: ${message}`);
  process.exitCode = 1;
});
