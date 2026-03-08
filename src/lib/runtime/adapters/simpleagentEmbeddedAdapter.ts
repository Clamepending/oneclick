import {
  getServerlessEmbeddedCapabilities,
  runServerlessChatTurn,
  type ServerlessRuntimeModelConfig,
} from "@/lib/runtime/serverlessChatEngine";
import type { RuntimeMetadata } from "@/lib/runtime/runtimeMetadata";

export const SIMPLEAGENT_EMBEDDED_RUNTIME_KIND = "simpleagent_embedded" as const;

export type SimpleagentEmbeddedTurnInput = {
  deploymentId: string;
  sessionId: string;
  userMessage: string;
  requestOrigin: string;
  modelConfig: ServerlessRuntimeModelConfig;
};

export async function runSimpleagentEmbeddedTurn(input: SimpleagentEmbeddedTurnInput) {
  return runServerlessChatTurn({
    deploymentId: input.deploymentId,
    sessionId: input.sessionId,
    userMessage: input.userMessage,
    requestOrigin: input.requestOrigin,
    modelConfig: input.modelConfig,
  });
}

export function getSimpleagentEmbeddedCapabilities(runtimeMetadata: RuntimeMetadata) {
  const base = getServerlessEmbeddedCapabilities();
  return {
    runtime_kind: SIMPLEAGENT_EMBEDDED_RUNTIME_KIND,
    runtime_version: runtimeMetadata.runtimeVersion,
    ...base,
  };
}
