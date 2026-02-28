export type PlanTier = "free" | "paid";
export type DeploymentFlavor =
  | "simple_agent_free"
  | "simple_agent_videomemory_free"
  | "simple_agent_ottoauth_ecs"
  | "deploy_openclaw_free"
  | "ottoagent_free";

export const FREE_TRIAL_DAYS = 30;
export const PAID_MONTHLY_PRICE_CENTS = 2000;

export function normalizePlanTier(value: string | null | undefined): PlanTier {
  return value?.trim().toLowerCase() === "paid" ? "paid" : "free";
}

export function normalizeDeploymentFlavor(value: string | null | undefined): DeploymentFlavor {
  const normalized = value?.trim().toLowerCase() || "";
  if (normalized === "simple_agent_free") return "simple_agent_free";
  if (normalized === "simple_agent_videomemory_free") return "simple_agent_videomemory_free";
  if (normalized === "simple_agent_ottoauth_ecs" || normalized === "simple_agent_ottoauth_ecs_free") {
    return "simple_agent_ottoauth_ecs";
  }
  if (normalized === "deploy_openclaw_free") return "deploy_openclaw_free";
  if (normalized === "ottoagent_free" || normalized === "ottoagent" || normalized === "simple_agent_ottoagent_free") {
    return "ottoagent_free";
  }
  if (normalized === "do_vm" || normalized === "basic" || normalized === "lightsail") {
    return "deploy_openclaw_free";
  }
  return "simple_agent_free";
}

export function planDisplayName(plan: PlanTier) {
  return plan === "paid" ? "Paid" : "Free Trial";
}

export function deploymentModeDisplayName(plan: PlanTier, flavor: DeploymentFlavor) {
  void plan;
  if (flavor === "deploy_openclaw_free") return "Deploy OpenClaw (Free)";
  if (flavor === "simple_agent_videomemory_free") return "Simple Agent + VideoMemory (Free)";
  if (flavor === "simple_agent_ottoauth_ecs") return "Simple Agent + OttoAuth (ECS)";
  if (flavor === "ottoagent_free") return "OttoAgent (Free)";
  return "Simple Agent (Free)";
}

export function planPriceLabel(plan: PlanTier) {
  return plan === "paid" ? "$20/mo" : "$0 for 30 days";
}

export function computeFreeTrialExpiry(from = new Date()) {
  return new Date(from.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

export function isFreeTrialExpired(expiresAt: string | Date | null | undefined, now = new Date()) {
  if (!expiresAt) return false;
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return false;
  return date.getTime() <= now.getTime();
}

function readTrimmed(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

export function getEcsPlanResources(plan: PlanTier) {
  if (plan === "paid") {
    return {
      cpu: readTrimmed("ECS_TASK_CPU_PAID") || "1024",
      memory: readTrimmed("ECS_TASK_MEMORY_PAID") || "3072",
    };
  }
  return {
    cpu: readTrimmed("ECS_TASK_CPU_FREE") || readTrimmed("ECS_TASK_CPU") || "512",
    memory: readTrimmed("ECS_TASK_MEMORY_FREE") || readTrimmed("ECS_TASK_MEMORY") || "2048",
  };
}

export function getPlanStorageGb(plan: PlanTier) {
  if (plan === "paid") {
    return Number(readTrimmed("PLAN_STORAGE_GB_PAID") || "10");
  }
  return Number(readTrimmed("PLAN_STORAGE_GB_FREE") || "1");
}
