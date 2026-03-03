import { mkdtemp, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { build } from "esbuild";
import dotenv from "dotenv";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  type LambdaClientConfig,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const execFileAsync = promisify(execFile);

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
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

function parseCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const REQUIRED_WORKER_FEATURES = [
  "deployment_strategy_v2",
  "simple_agent_microservices_ecs",
  "simple_agent_microservices_shared",
  "simple_agent_microservices_shared_ottoauth",
  "ottoagent_free",
  "simple_agent_ottoauth_ecs",
  "simple_agent_ottoauth_ecs_canary",
  "simple_agent_videomemory_free",
];

async function waitForFunctionUpdateComplete(lambda: LambdaClient, functionName: string) {
  const maxAttempts = 60;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await lambda.send(
      new GetFunctionConfigurationCommand({
        FunctionName: functionName,
      }),
    );
    const updateStatus = (status.LastUpdateStatus ?? "").toUpperCase();
    if (!updateStatus || updateStatus === "SUCCESSFUL") return;
    if (updateStatus === "FAILED") {
      throw new Error(
        `Lambda update failed for ${functionName}: ${status.LastUpdateStatusReason || "unknown reason"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Timed out waiting for Lambda update completion on ${functionName}.`);
}

async function main() {
  const region = readTrimmedEnv("AWS_REGION");
  if (!region) {
    throw new Error("AWS_REGION is required.");
  }
  const functionName = readTrimmedEnv("DEPLOY_QUEUE_LAMBDA_FUNCTION_NAME") || "oneclick-sqs-deploy-consumer";
  const buildSha = readTrimmedEnv("VERCEL_GIT_COMMIT_SHA") || readTrimmedEnv("GIT_COMMIT_SHA") || "local";

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oneclick-lambda-build-"));
  const outFile = path.join(tempDir, "index.js");
  const zipFile = path.join(tempDir, "lambda.zip");

  await build({
    entryPoints: [path.join(process.cwd(), "scripts/lambda-sqs-consumer-entry.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: outFile,
    loader: {
      ".node": "file",
    },
  });

  await execFileAsync("sh", ["-lc", "zip -q lambda.zip *"], { cwd: tempDir });
  const zipBytes = await readFile(zipFile);

  const lambda = new LambdaClient(buildAwsConfigWithTrimmedCreds(region));
  await lambda.send(
    new UpdateFunctionCodeCommand({
      FunctionName: functionName,
      ZipFile: zipBytes,
      Publish: true,
    }),
  );
  await waitForFunctionUpdateComplete(lambda, functionName);

  const current = await lambda.send(
    new GetFunctionConfigurationCommand({
      FunctionName: functionName,
    }),
  );
  const currentEnv = { ...(current.Environment?.Variables ?? {}) };
  const currentFeatures = parseCsv(currentEnv.DEPLOY_WORKER_FEATURES ?? "").map((item) => item.toLowerCase());
  const mergedFeatures = Array.from(new Set([...currentFeatures, ...REQUIRED_WORKER_FEATURES])).join(",");

  const nextEnv = {
    ...currentEnv,
    DEPLOY_WORKER_FEATURES: mergedFeatures,
    DEPLOY_WORKER_BUILD_SHA: buildSha,
  };

  await lambda.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: functionName,
      Environment: { Variables: nextEnv },
    }),
  );
  await waitForFunctionUpdateComplete(lambda, functionName);

  console.log(
    JSON.stringify(
      {
        ok: true,
        functionName,
        region,
        deployedFeatures: mergedFeatures,
        buildSha,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
