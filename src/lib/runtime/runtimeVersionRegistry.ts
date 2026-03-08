import { pool } from "@/lib/db";
import {
  RUNTIME_CONTRACT_VERSION,
  resolveDefaultRuntimeMetadata,
  type RuntimeMetadata,
} from "@/lib/runtime/runtimeMetadata";

type StableRuntimeVersionRow = {
  runtime_version: string;
  runtime_contract_version: string;
};

export async function resolveRuntimeMetadataForNewDeployment(input: {
  deploymentFlavor: string | null | undefined;
}): Promise<RuntimeMetadata> {
  const fallback = resolveDefaultRuntimeMetadata(input.deploymentFlavor);

  const result = await pool.query<StableRuntimeVersionRow>(
    `SELECT runtime_version, runtime_contract_version
     FROM runtime_versions
     WHERE runtime_kind = $1
       AND status = 'stable'
     ORDER BY COALESCE(promoted_at, created_at) DESC, created_at DESC
     LIMIT 1`,
    [fallback.runtimeKind],
  );

  const stable = result.rows[0];
  const stableVersion = stable?.runtime_version?.trim() || "";
  const stableContract = stable?.runtime_contract_version?.trim() || "";
  if (!stableVersion || stableContract !== RUNTIME_CONTRACT_VERSION) {
    return fallback;
  }

  return {
    ...fallback,
    runtimeVersion: stableVersion,
    runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
    runtimeReleaseChannel: "stable",
  };
}

