import { config as loadEnv } from "dotenv";
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  type ECSClientConfig,
} from "@aws-sdk/client-ecs";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function buildAwsConfig(region: string): ECSClientConfig {
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

function parseSharedRuntimeId(runtimeId: string) {
  if (!runtimeId.startsWith("ecs:")) return null;
  const body = runtimeId.slice(4);
  const split = body.split("|");
  if (split.length !== 2) return null;
  return {
    cluster: split[0].trim(),
    serviceName: split[1].trim(),
  };
}

function asEnvMap(environment: Array<{ name?: string; value?: string }> | undefined) {
  const map = new Map<string, string>();
  for (const entry of environment ?? []) {
    const key = String(entry.name ?? "").trim();
    if (!key) continue;
    map.set(key, String(entry.value ?? ""));
  }
  return map;
}

function mapToEnvList(map: Map<string, string>) {
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, value]) => ({ name, value }));
}

function upsertEnvironment(
  environment: Array<{ name?: string; value?: string }> | undefined,
  name: string,
  value: string,
) {
  const map = asEnvMap(environment);
  map.set(name, value);
  return mapToEnvList(map);
}

function ensureDependsOn(
  dependsOn: Array<{ containerName?: string; condition?: string }> | undefined,
  containerName: string,
  condition = "START",
) {
  const out: Array<{ containerName: string; condition: "START" | "HEALTHY" | "COMPLETE" | "SUCCESS" }> = [];
  let found = false;
  for (const entry of dependsOn ?? []) {
    const name = String(entry.containerName ?? "").trim();
    if (!name) continue;
    const nextCondition = String(entry.condition ?? "START").toUpperCase();
    const normalizedCondition =
      nextCondition === "HEALTHY" || nextCondition === "COMPLETE" || nextCondition === "SUCCESS"
        ? (nextCondition as "HEALTHY" | "COMPLETE" | "SUCCESS")
        : ("START" as const);
    if (name === containerName) {
      out.push({ containerName, condition: (condition as "START") });
      found = true;
      continue;
    }
    out.push({ containerName: name, condition: normalizedCondition });
  }
  if (!found) {
    out.push({ containerName, condition: (condition as "START") });
  }
  return out;
}

async function waitForServiceStable(ecs: ECSClient, cluster: string, serviceName: string) {
  const timeoutMs = 20 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const described = await ecs.send(
      new DescribeServicesCommand({
        cluster,
        services: [serviceName],
      }),
    );
    const service = described.services?.[0];
    if (!service) {
      throw new Error(`Shared runtime service not found while waiting: ${serviceName}`);
    }
    const primary = (service.deployments ?? []).find((item) => item.status === "PRIMARY");
    if ((service.deployments ?? []).some((item) => item.rolloutState === "FAILED")) {
      throw new Error(`Service rollout failed for ${serviceName}.`);
    }
    const stable =
      (service.pendingCount ?? 0) === 0 &&
      (service.runningCount ?? 0) >= (service.desiredCount ?? 0) &&
      primary?.rolloutState === "COMPLETED";
    if (stable) {
      return {
        desiredCount: service.desiredCount ?? 0,
        runningCount: service.runningCount ?? 0,
        taskDefinition: service.taskDefinition ?? "",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`Timed out waiting for ${serviceName} to become stable.`);
}

async function main() {
  const runtimeId = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_SHARED_RUNTIME_ID");
  const parsedRuntime = parseSharedRuntimeId(runtimeId);
  if (!parsedRuntime) {
    throw new Error("SIMPLE_AGENT_MICROSERVICES_SHARED_RUNTIME_ID must use ecs:<cluster>|<service> format.");
  }

  const region = readTrimmedEnv("AWS_REGION");
  if (!region) {
    throw new Error("AWS_REGION is required.");
  }

  const mcpImage = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_MCP_IMAGE");
  if (!mcpImage) {
    throw new Error("SIMPLE_AGENT_MICROSERVICES_MCP_IMAGE is required.");
  }

  const mcpToolServiceUrl = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_MCP_TOOL_SERVICE_URL") || "http://127.0.0.1:8004";
  const ottoAuthBaseUrl = readTrimmedEnv("OTTOAGENT_MCP_BASE_URL") || "https://ottoauth.vercel.app";
  const autoOffIdleSeconds = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_MCP_AUTO_OFF_IDLE_S") || "300";
  const loopIntervalSeconds = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_MCP_LOOP_INTERVAL_S") || "1";
  const refreshMs = readTrimmedEnv("OTTOAGENT_MCP_REFRESH_MS") || String(24 * 60 * 60 * 1000);

  const ecs = new ECSClient(buildAwsConfig(region));

  const serviceDescription = await ecs.send(
    new DescribeServicesCommand({
      cluster: parsedRuntime.cluster,
      services: [parsedRuntime.serviceName],
    }),
  );
  const service = serviceDescription.services?.[0];
  if (!service) {
    throw new Error(`Shared runtime service not found: ${parsedRuntime.serviceName}`);
  }
  const taskDefinitionArn = String(service.taskDefinition ?? "").trim();
  if (!taskDefinitionArn) {
    throw new Error("Shared runtime service is missing taskDefinition.");
  }

  const taskDefinitionDescription = await ecs.send(
    new DescribeTaskDefinitionCommand({
      taskDefinition: taskDefinitionArn,
    }),
  );
  const taskDefinition = taskDefinitionDescription.taskDefinition;
  if (!taskDefinition) {
    throw new Error(`Unable to load task definition: ${taskDefinitionArn}`);
  }

  const clonedContainers = JSON.parse(JSON.stringify(taskDefinition.containerDefinitions ?? [])) as Array<Record<string, unknown>>;
  const gatewayContainer = clonedContainers.find((container) => String(container.name ?? "") === "gateway-service");
  const executionContainer = clonedContainers.find((container) => String(container.name ?? "") === "execution-service");
  if (!gatewayContainer || !executionContainer) {
    throw new Error("Expected gateway-service and execution-service containers in shared runtime task definition.");
  }

  const gatewayEnvMap = asEnvMap((gatewayContainer.environment as Array<{ name?: string; value?: string }> | undefined));
  const runtimeGatewayToken = gatewayEnvMap.get("AGENT_GATEWAY_AUTH_TOKEN") || "";
  const configuredGatewayToken = readTrimmedEnv("OTTOAGENT_MCP_TOKEN") || runtimeGatewayToken;
  if (!configuredGatewayToken) {
    throw new Error("OTTOAGENT_MCP_TOKEN is missing and no AGENT_GATEWAY_AUTH_TOKEN is set on gateway-service.");
  }

  const baseLogConfiguration = gatewayContainer.logConfiguration;
  const mcpContainer: Record<string, unknown> = {
    name: "mcp-tool-service",
    image: mcpImage,
    essential: false,
    environment: [
      { name: "MCP_DEFAULT_ENABLED", value: "1" },
      { name: "MCP_AUTO_OFF_IDLE_S", value: autoOffIdleSeconds },
      { name: "MCP_LOOP_INTERVAL_S", value: loopIntervalSeconds },
      { name: "OTTOAUTH_BASE_URL", value: ottoAuthBaseUrl },
      { name: "AGENT_GATEWAY_URL", value: "http://127.0.0.1:8001/hooks/ottoauth" },
      { name: "AGENT_GATEWAY_AUTH_TOKEN", value: configuredGatewayToken },
      { name: "OTTOAGENT_MCP_REFRESH_MS", value: refreshMs },
    ],
    portMappings: [{ containerPort: 8004, protocol: "tcp" }],
    logConfiguration: baseLogConfiguration,
  };

  const existingMcpIndex = clonedContainers.findIndex((container) => String(container.name ?? "") === "mcp-tool-service");
  if (existingMcpIndex >= 0) {
    const existing = clonedContainers[existingMcpIndex];
    clonedContainers[existingMcpIndex] = {
      ...existing,
      ...mcpContainer,
      environment: (mcpContainer.environment as Array<{ name: string; value: string }>),
      portMappings: [{ containerPort: 8004, protocol: "tcp" }],
    };
  } else {
    clonedContainers.splice(3, 0, mcpContainer);
  }

  for (const container of clonedContainers) {
    const containerName = String(container.name ?? "");
    if (containerName === "gateway-service" || containerName === "execution-service") {
      container.environment = upsertEnvironment(
        container.environment as Array<{ name?: string; value?: string }> | undefined,
        "MCP_TOOL_SERVICE_URL",
        mcpToolServiceUrl,
      );
      container.dependsOn = ensureDependsOn(
        container.dependsOn as Array<{ containerName?: string; condition?: string }> | undefined,
        "mcp-tool-service",
        "START",
      );
    }
    if (containerName === "gateway-service") {
      container.environment = upsertEnvironment(
        container.environment as Array<{ name?: string; value?: string }> | undefined,
        "AGENT_GATEWAY_AUTH_TOKEN",
        configuredGatewayToken,
      );
    }
  }

  const register = await ecs.send(
    new RegisterTaskDefinitionCommand({
      family: taskDefinition.family,
      taskRoleArn: taskDefinition.taskRoleArn,
      executionRoleArn: taskDefinition.executionRoleArn,
      networkMode: taskDefinition.networkMode,
      requiresCompatibilities: taskDefinition.requiresCompatibilities,
      cpu: taskDefinition.cpu,
      memory: taskDefinition.memory,
      pidMode: taskDefinition.pidMode,
      ipcMode: taskDefinition.ipcMode,
      proxyConfiguration: taskDefinition.proxyConfiguration,
      placementConstraints: taskDefinition.placementConstraints,
      volumes: taskDefinition.volumes,
      runtimePlatform: taskDefinition.runtimePlatform,
      ephemeralStorage: taskDefinition.ephemeralStorage,
      inferenceAccelerators: taskDefinition.inferenceAccelerators,
      containerDefinitions: clonedContainers as never,
    }),
  );

  const newTaskDefinitionArn = String(register.taskDefinition?.taskDefinitionArn ?? "").trim();
  if (!newTaskDefinitionArn) {
    throw new Error("ECS did not return a new task definition ARN.");
  }

  await ecs.send(
    new UpdateServiceCommand({
      cluster: parsedRuntime.cluster,
      service: parsedRuntime.serviceName,
      taskDefinition: newTaskDefinitionArn,
      forceNewDeployment: true,
    }),
  );

  const stable = await waitForServiceStable(ecs, parsedRuntime.cluster, parsedRuntime.serviceName);

  console.log(
    JSON.stringify(
      {
        ok: true,
        region,
        cluster: parsedRuntime.cluster,
        serviceName: parsedRuntime.serviceName,
        previousTaskDefinitionArn: taskDefinitionArn,
        taskDefinitionArn: newTaskDefinitionArn,
        mcpImage,
        mcpToolServiceUrl,
        ottoAuthBaseUrl,
        refreshMs,
        gatewayTokenSourcedFrom: readTrimmedEnv("OTTOAGENT_MCP_TOKEN") ? "OTTOAGENT_MCP_TOKEN" : "gateway-service:AGENT_GATEWAY_AUTH_TOKEN",
        stable,
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
