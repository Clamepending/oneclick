import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  type LambdaClientConfig,
} from "@aws-sdk/client-lambda";
import type { DeploymentFlavor } from "@/lib/plans";

type WorkerFeatureRequirement = {
  feature: string;
  label: string;
};

const BASE_WORKER_FEATURES: WorkerFeatureRequirement[] = [
  {
    feature: "deployment_strategy_v2",
    label: "deployment strategy v2",
  },
  {
    feature: "runtime_chat_sessions_scoped_pk",
    label: "runtime chat session scoped primary key migration",
  },
];

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function parseCsvSet(value: string) {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function buildAwsConfigWithTrimmedCreds(region: string): LambdaClientConfig {
  const accessKeyId = readTrimmedEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = readTrimmedEnv("AWS_SECRET_ACCESS_KEY");
  const sessionToken = readTrimmedEnv("AWS_SESSION_TOKEN");
  if (!accessKeyId || !secretAccessKey) {
    return { region };
  }
  return {
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: sessionToken || undefined,
    },
  };
}

function getRequiredWorkerFeatures(selectedDeploymentFlavor: DeploymentFlavor): WorkerFeatureRequirement[] {
  const required = [...BASE_WORKER_FEATURES];
  if (selectedDeploymentFlavor === "simple_agent_videomemory_free") {
    required.push({ feature: "simple_agent_videomemory_free", label: "Simple Agent + VideoMemory" });
  }
  return required;
}

export async function ensureQueueWorkerSupportsFlavor(input: {
  selectedDeploymentFlavor: DeploymentFlavor;
  queueUsable: boolean;
}) {
  if (!input.queueUsable) return { ok: true as const };
  const requiredFeatures = getRequiredWorkerFeatures(input.selectedDeploymentFlavor);

  const region = readTrimmedEnv("AWS_REGION");
  if (!region) {
    return {
      ok: false as const,
      error:
        "Deployments require AWS_REGION so OneClick can verify queue worker compatibility.",
    };
  }

  const functionName = readTrimmedEnv("DEPLOY_QUEUE_LAMBDA_FUNCTION_NAME") || "oneclick-sqs-deploy-consumer";
  try {
    const lambda = new LambdaClient(buildAwsConfigWithTrimmedCreds(region));
    const config = await lambda.send(
      new GetFunctionConfigurationCommand({
        FunctionName: functionName,
      }),
    );
    const workerFeatures = parseCsvSet(
      config.Environment?.Variables?.DEPLOY_WORKER_FEATURES ?? "",
    );
    const missingFeatures = requiredFeatures
      .filter((item) => !workerFeatures.has(item.feature) && !workerFeatures.has("*"))
      .map((item) => item.feature);
    if (missingFeatures.length > 0) {
      return {
        ok: false as const,
        error:
          `Deployments are blocked because queue worker ${functionName} is outdated (missing DEPLOY_WORKER_FEATURES=${missingFeatures.join(",")}). Update the Lambda consumer and retry.`,
      };
    }

    if (input.selectedDeploymentFlavor === "simple_agent_videomemory_free") {
      const hasDoToken = Boolean((config.Environment?.Variables?.DO_API_TOKEN ?? "").trim());
      const hasSshKey = Boolean((config.Environment?.Variables?.DEPLOY_SSH_PRIVATE_KEY ?? "").trim());
      const hasRuntimeBaseDomain = Boolean((config.Environment?.Variables?.RUNTIME_BASE_DOMAIN ?? "").trim());
      const missing: string[] = [];
      if (!hasDoToken) missing.push("DO_API_TOKEN");
      if (!hasSshKey) missing.push("DEPLOY_SSH_PRIVATE_KEY");
      if (!hasRuntimeBaseDomain) missing.push("RUNTIME_BASE_DOMAIN");
      if (missing.length > 0) {
        return {
          ok: false as const,
          error:
            `Simple Agent + VideoMemory is blocked because queue worker ${functionName} is missing required SSH runtime env vars: ${missing.join(", ")}.`,
        };
      }
    }

    return { ok: true as const };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return {
      ok: false as const,
      error:
        `Deployments are blocked because OneClick could not verify queue worker ${functionName}: ${details}`,
    };
  }
}
