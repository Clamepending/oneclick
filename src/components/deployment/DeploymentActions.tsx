"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getPlanStorageGb } from "@/lib/plans";

type Props = {
  deploymentId: string;
  status?: "queued" | "starting" | "ready" | "failed" | "stopped" | "deactivated";
  compact?: boolean;
  botName?: string | null;
  planTier?: "free" | "paid";
  deploymentFlavor?: "basic" | "advanced" | "lightsail";
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
  const [isApprovingPairing, setIsApprovingPairing] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [pairingResult, setPairingResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const isReady = status === "ready";
  const freeStorageGb = getPlanStorageGb("free");
  const paidStorageGb = getPlanStorageGb("paid");
  const [redeploySelection, setRedeploySelection] = useState<"free_lightsail" | "free_basic" | "free_advanced" | "paid_basic">(
    planTier === "paid"
      ? "paid_basic"
      : !freeSelectable
        ? "paid_basic"
        : deploymentFlavor === "advanced"
          ? "free_advanced"
          : deploymentFlavor === "lightsail"
            ? "free_lightsail"
            : "free_basic",
  );

  const canDelete = status !== "deactivated";

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
          deploymentFlavor:
            redeploySelection === "free_advanced"
              ? "advanced"
              : redeploySelection === "free_lightsail"
                ? "lightsail"
                : "basic",
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
      setError("This deployment can no longer be deleted.");
      return;
    }
    const confirmed = window.confirm(
      "Delete this bot deployment? If it is still starting, OneClick will stop startup and destroy its runtime.",
    );
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

  async function handleApproveTelegramPairing() {
    const code = pairingCode.trim().toUpperCase();
    if (!code) {
      setPairingResult({ type: "error", message: "Enter a pairing code." });
      return;
    }

    setError("");
    setPairingResult(null);
    setIsApprovingPairing(true);
    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 45_000);
      const response = await fetch(`/api/deployments/${deploymentId}/pairing/telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        signal: controller.signal,
      }).finally(() => window.clearTimeout(timeoutId));
      const payload = (await response.json()) as { ok?: boolean; message?: string; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Failed to approve pairing code");
      }
      setPairingCode("");
      setPairingResult({ type: "success", message: payload.message || "Telegram pairing approved." });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setPairingResult({
          type: "error",
          message: "Approval timed out. Try again with a fresh code.",
        });
        return;
      }
      setPairingResult({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to approve pairing code",
      });
    } finally {
      setIsApprovingPairing(false);
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
                      : event.target.value === "free_lightsail"
                        ? "free_lightsail"
                      : event.target.value === "paid_basic"
                        ? "paid_basic"
                        : "free_basic",
                  )
                }
                disabled={isRedeploying || isDeleting || isUpgrading}
                style={{ minHeight: 34 }}
              >
                <option value="free_lightsail" disabled={!freeSelectable}>
                  Free (Lightsail) - SSH host runtime - {freeStorageGb} GB storage
                </option>
                <option value="free_basic" disabled={!freeSelectable}>
                  Free (Basic) - Fargate 0.25 vCPU / 0.5 GB - {freeStorageGb} GB storage
                </option>
                <option value="free_advanced" disabled={!freeSelectable}>
                  Free (Advanced) - Fargate 0.25 vCPU / 0.5 GB - {freeStorageGb} GB storage
                </option>
                <option value="paid_basic">Paid (Basic) $20/mo - Fargate 0.5 vCPU / 1 GB - {paidStorageGb} GB storage</option>
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
        <button
          className="button secondary"
          type="button"
          onClick={() => void handleDelete()}
          disabled={isRedeploying || isDeleting || isUpgrading || !canDelete}
          title={!canDelete ? "This deployment can no longer be deleted" : undefined}
        >
          {isDeleting ? "Deleting..." : "Delete bot"}
        </button>
      </div>
      {!isReady ? (
        <p className="muted" style={{ margin: 0 }}>
          Redeploy appears after the deployment is ready. Delete is available while queued/starting if you need to stop it.
        </p>
      ) : null}
      {error ? (
        <p style={{ color: "#ff8e8e", margin: 0 }} role="alert">
          {error}
        </p>
      ) : null}
      {isReady ? (
        <div style={{ display: "grid", gap: 6 }}>
          <p className="muted" style={{ margin: 0 }}>
            Telegram pairing: paste a code from Telegram and OneClick will approve it for this runtime.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <input
              type="text"
              value={pairingCode}
              onChange={(event) => setPairingCode(event.target.value.toUpperCase())}
              placeholder="Pairing code (example: D4UQDC2X)"
              inputMode="text"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={24}
              disabled={isApprovingPairing || isRedeploying || isDeleting || isUpgrading}
              style={{ minHeight: 34, minWidth: 220 }}
            />
            <button
              className="button secondary"
              type="button"
              onClick={() => void handleApproveTelegramPairing()}
              disabled={isApprovingPairing || isRedeploying || isDeleting || isUpgrading}
            >
              {isApprovingPairing ? "Approving..." : "Approve Telegram code"}
            </button>
          </div>
          {pairingResult ? (
            <p
              style={{ color: pairingResult.type === "success" ? "#90e6a8" : "#ff8e8e", margin: 0 }}
              role={pairingResult.type === "error" ? "alert" : undefined}
            >
              {pairingResult.message}
            </p>
          ) : null}
        </div>
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
