import {
  getSimpleagentEmbeddedCapabilities,
  runSimpleagentEmbeddedTurn,
  SIMPLEAGENT_EMBEDDED_RUNTIME_KIND,
} from "@/lib/runtime/adapters/simpleagentEmbeddedAdapter";
import type { ServerlessRuntimeModelConfig } from "@/lib/runtime/serverlessChatEngine";
import type { RuntimeMetadata } from "@/lib/runtime/runtimeMetadata";

export class RuntimeRouterError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 500, code = "runtime_router_error") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type RuntimeRouterTurnInput = {
  deploymentId: string;
  sessionId: string;
  userMessage: string;
  requestOrigin: string;
  modelConfig: ServerlessRuntimeModelConfig;
  runtimeMetadata: RuntimeMetadata;
};

function ensureContractCompatibility(input: {
  runtimeMetadata: RuntimeMetadata;
  adapterContractVersion: string;
}) {
  if (input.runtimeMetadata.runtimeContractVersion !== input.adapterContractVersion) {
    throw new RuntimeRouterError(
      `Runtime contract mismatch: deployment requires ${input.runtimeMetadata.runtimeContractVersion}, adapter supports ${input.adapterContractVersion}.`,
      409,
      "runtime_contract_mismatch",
    );
  }
}

export function getRuntimeCapabilities(runtimeMetadata: RuntimeMetadata) {
  if (runtimeMetadata.runtimeKind === SIMPLEAGENT_EMBEDDED_RUNTIME_KIND) {
    return getSimpleagentEmbeddedCapabilities(runtimeMetadata);
  }
  throw new RuntimeRouterError(
    `Runtime kind '${runtimeMetadata.runtimeKind}' is not supported on this route.`,
    409,
    "runtime_kind_not_supported",
  );
}

export async function runRuntimeTurn(input: RuntimeRouterTurnInput) {
  if (input.runtimeMetadata.runtimeKind !== SIMPLEAGENT_EMBEDDED_RUNTIME_KIND) {
    throw new RuntimeRouterError(
      `Runtime kind '${input.runtimeMetadata.runtimeKind}' is not supported on this route.`,
      409,
      "runtime_kind_not_supported",
    );
  }

  const capabilities = getSimpleagentEmbeddedCapabilities(input.runtimeMetadata);
  ensureContractCompatibility({
    runtimeMetadata: input.runtimeMetadata,
    adapterContractVersion: capabilities.runtime_contract_version,
  });

  const turn = await runSimpleagentEmbeddedTurn({
    deploymentId: input.deploymentId,
    sessionId: input.sessionId,
    userMessage: input.userMessage,
    requestOrigin: input.requestOrigin,
    modelConfig: input.modelConfig,
  });

  return {
    status: "ok" as const,
    runtime: {
      runtime_kind: input.runtimeMetadata.runtimeKind,
      runtime_version: input.runtimeMetadata.runtimeVersion,
      runtime_contract_version: input.runtimeMetadata.runtimeContractVersion,
      runtime_release_channel: input.runtimeMetadata.runtimeReleaseChannel,
    },
    capabilities,
    ...turn,
  };
}

