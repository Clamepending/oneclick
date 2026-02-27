export type PlanTier = "free" | "paid";
export type DeploymentFlavor = "do_vm";

export const FREE_TRIAL_DAYS = 30;
export const PAID_MONTHLY_PRICE_CENTS = 2000;

export function normalizePlanTier(value: string | null | undefined): PlanTier {
  return value?.trim().toLowerCase() === "paid" ? "paid" : "free";
}

export function normalizeDeploymentFlavor(value: string | null | undefined): DeploymentFlavor {
  void value;
  return "do_vm";
}

export function planDisplayName(plan: PlanTier) {
  return plan === "paid" ? "Paid" : "Free Trial";
}

export function deploymentModeDisplayName(plan: PlanTier, flavor: DeploymentFlavor) {
  void plan;
  void flavor;
  return "DigitalOcean VM (Standard)";
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
