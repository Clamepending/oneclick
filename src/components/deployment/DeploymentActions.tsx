"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  deploymentId: string;
  status?: "queued" | "starting" | "ready" | "failed" | "stopped" | "deactivated";
  compact?: boolean;
  botName?: string | null;
  planTier?: "free" | "paid";
  deploymentFlavor?: "basic" | "advanced";
  freeSelectable?: boolean;
  freeActiveDeployments?: number;
  freeActiveLimit?: number;
};

export function DeploymentActions({
  deploymentId,
  status,
  compact = false,
  botName,
  planTier = "free",
  deploymentFlavor = "basic",
  freeSelectable = true,
  freeActiveDeployments = 0,
  freeActiveLimit = 1,
}: Props) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [isRedeploying, setIsRedeploying] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const isReady = status === "ready";
  const [redeploySelection, setRedeploySelection] = useState<"free_basic" | "free_advanced" | "paid_basic">(
    planTier === "paid" ? "paid_basic" : !freeSelectable ? "paid_basic" : deploymentFlavor === "advanced" ? "free_advanced" : "free_basic",
  );

  const canDelete = status !== "queued";

  async function handleRedeploy() {
    setError("");
    setIsRedeploying(true);
    try {
      const response = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botName: botName ?? undefined,
          planTier: redeploySelection === "paid_basic" ? "paid" : "free",
          deploymentFlavor: redeploySelection === "free_advanced" ? "advanced" : "basic",
        }),
      });
      const payload = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !payload.id) {
        throw new Error(payload.error || "Failed to redeploy");
      }
      router.push(`/deployments/${payload.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to redeploy");
    } finally {
      setIsRedeploying(false);
    }
  }

  async function handleUpgradeToPaid() {
    setError("");
    setIsUpgrading(true);
    try {
      const response = await fetch(`/api/deployments/${deploymentId}/upgrade`, { method: "POST" });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Failed to upgrade plan");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upgrade plan");
    } finally {
      setIsUpgrading(false);
    }
  }

  async function handleDelete() {
    if (!canDelete) {
      setError("This deployment is still queued and cannot be deleted yet.");
      return;
    }
    const confirmed = window.confirm("Delete this bot deployment? This will destroy its runtime.");
    if (!confirmed) return;

    setError("");
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/deployments/${deploymentId}`, { method: "DELETE" });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Failed to delete deployment");
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete deployment");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="row" style={compact ? { gap: 8 } : undefined}>
        {isReady ? (
          <>
            <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              Plan
              <select
                value={redeploySelection}
                onChange={(event) =>
                  setRedeploySelection(
                    event.target.value === "free_advanced"
                      ? "free_advanced"
                      : event.target.value === "paid_basic"
                        ? "paid_basic"
                        : "free_basic",
                  )
                }
                disabled={isRedeploying || isDeleting || isUpgrading}
                style={{ minHeight: 34 }}
              >
                <option value="free_basic" disabled={!freeSelectable}>
                  Free (Basic) - Fargate 0.25 vCPU / 0.5 GB
                </option>
                <option value="free_advanced" disabled={!freeSelectable}>
                  Free (Advanced) - Fargate 0.25 vCPU / 0.5 GB
                </option>
                <option value="paid_basic">Paid (Basic) $20/mo - Fargate 0.5 vCPU / 1 GB</option>
              </select>
            </label>
            <button
              className="button secondary"
              type="button"
              onClick={() => void handleRedeploy()}
              disabled={isRedeploying || isDeleting || isUpgrading}
            >
              {isRedeploying ? "Redeploying..." : "Redeploy bot"}
            </button>
          </>
        ) : null}
        {planTier === "free" ? (
          <button
            className="button secondary"
            type="button"
            onClick={() => void handleUpgradeToPaid()}
            disabled={isRedeploying || isDeleting || isUpgrading}
          >
            {isUpgrading ? "Upgrading..." : "Upgrade to Paid ($20/mo)"}
          </button>
        ) : null}
        {isReady ? (
          <button
            className="button secondary"
            type="button"
            onClick={() => void handleDelete()}
            disabled={isRedeploying || isDeleting || isUpgrading || !canDelete}
            title={!canDelete ? "Queued deployments cannot be deleted yet" : undefined}
          >
            {isDeleting ? "Deleting..." : "Delete bot"}
          </button>
        ) : null}
      </div>
      {!isReady ? (
        <p className="muted" style={{ margin: 0 }}>
          Redeploy and delete actions appear after the deployment is ready.
        </p>
      ) : null}
      {error ? (
        <p style={{ color: "#ff8e8e", margin: 0 }} role="alert">
          {error}
        </p>
      ) : null}
      {!freeSelectable ? (
        <p className="muted" style={{ margin: 0 }}>
          Free tier unavailable: you already have {freeActiveDeployments}/{freeActiveLimit} active free deployment
          {freeActiveLimit === 1 ? "" : "s"}.
        </p>
      ) : null}
    </div>
  );
}
