#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { LambdaClient, GetFunctionConfigurationCommand, UpdateFunctionConfigurationCommand } from "@aws-sdk/client-lambda";

const root = process.cwd();
dotenv.config({ path: path.join(root, ".env"), quiet: true });
dotenv.config({ path: path.join(root, ".env.local"), override: true, quiet: true });

function read(name) {
  const raw = process.env[name];
  if (!raw) return "";
  return String(raw).trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

const functionName = process.argv[2] || read("SQS_DEPLOYMENT_CONSUMER_LAMBDA_NAME");
if (!functionName) {
  console.error("Usage: node scripts/aws-sync-sqs-consumer-lambda-env.mjs <lambda-function-name>");
  process.exit(1);
}

const region = read("AWS_REGION");
if (!region) {
  console.error("AWS_REGION is required.");
  process.exit(1);
}

const allowList = [
  "NODE_ENV",
  "APP_BASE_URL",
  "DATABASE_URL",
  "DEPLOY_PROVIDER",
  "DEPLOY_QUEUE_PROVIDER",
  "ECS_CLUSTER",
  "ECS_SUBNET_IDS",
  "ECS_SECURITY_GROUP_IDS",
  "ECS_EXECUTION_ROLE_ARN",
  "ECS_TASK_ROLE_ARN",
  "ECS_SERVICE_PREFIX",
  "ECS_ASSIGN_PUBLIC_IP",
  "ECS_LOG_GROUP",
  "ECS_LOG_STREAM_PREFIX",
  "ECS_READY_URL_TEMPLATE",
  "ECS_STARTUP_TIMEOUT_MS",
  "OPENCLAW_IMAGE",
  "OPENCLAW_CONTAINER_PORT",
  "OPENCLAW_START_COMMAND",
  "OPENCLAW_ALLOW_INSECURE_CONTROL_UI",
  "OPENCLAW_CONFIG_MOUNT_BASE",
  "OPENCLAW_WORKSPACE_SUFFIX",
  "OPENCLAW_HEALTH_PATH",
  "OPENCLAW_STARTUP_TIMEOUT_MS",
  "OPENCLAW_TELEGRAM_BOT_TOKEN",
  "DEPLOY_STALE_STARTING_TIMEOUT_MS",
  "DEPLOY_SSH_PRIVATE_KEY",
  "DEPLOY_SSH_KNOWN_HOSTS",
];

const envVars = {};
for (const key of allowList) {
  const value = read(key);
  if (value) envVars[key] = value;
}

if (!envVars.DEPLOY_PROVIDER) envVars.DEPLOY_PROVIDER = "ecs";
if (!envVars.DEPLOY_QUEUE_PROVIDER) envVars.DEPLOY_QUEUE_PROVIDER = "sqs";

const client = new LambdaClient({ region });

const current = await client.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
const merged = {
  ...(current.Environment?.Variables ?? {}),
  ...envVars,
};

await client.send(
  new UpdateFunctionConfigurationCommand({
    FunctionName: functionName,
    Environment: { Variables: merged },
    Timeout: 900,
  }),
);

console.log(`Updated Lambda env for ${functionName} with ${Object.keys(envVars).length} keys`);
