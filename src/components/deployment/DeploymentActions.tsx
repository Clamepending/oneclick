"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  deploymentId: string;
  status?: "queued" | "starting" | "ready" | "failed" | "stopped" | "deactivated";
  runtimeId?: string | null;
  deployProvider?: string | null;
  compact?: boolean;
  botName?: string | null;
  planTier?: "free" | "paid";
  deploymentFlavor?: "basic" | "advanced" | "do_vm";
  freeSelectable?: boolean;
  freeActiveDeployments?: number;
  freeActiveLimit?: number;
};

export function DeploymentActions({
  deploymentId,
  status,
  runtimeId,
  deployProvider,
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
  const [sshCommandMessage, setSshCommandMessage] = useState("");
  const isReady = status === "ready";

  const canDelete = status !== "deactivated";
  const isSshRuntime = (deployProvider ?? "").trim() === "ssh";

  function buildSshCommand() {
    const raw = runtimeId?.trim();
    if (!raw || !raw.startsWith("ssh:")) return null;
    const body = raw.slice(4);
    const parts = body.split("|");
    const sshTarget = parts[0];
    const containerName = parts[1];
    if (!sshTarget || !containerName) return null;
    const escapedContainer = containerName.replace(/"/g, '\\"');
    return `ssh ${sshTarget} 'docker exec -it "${escapedContainer}" sh'`;
  }

  function buildSshDeepLink() {
    const raw = runtimeId?.trim();
    if (!raw || !raw.startsWith("ssh:")) return null;
    const body = raw.slice(4);
    const parts = body.split("|");
    const sshTarget = parts[0]?.trim();
    if (!sshTarget) return null;
    return `ssh://${sshTarget}`;
  }

  async function handleRedeploy() {
    setError("");
    setIsRedeploying(true);
    try {
      const response = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botName: botName ?? undefined,
          planTier: planTier === "paid" ? "paid" : "free",
          deploymentFlavor: planTier === "paid" ? "basic" : deploymentFlavor,
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

  async function handleCopySshCommand() {
    const command = buildSshCommand();
    if (!command) {
      setSshCommandMessage("SSH command unavailable for this deployment.");
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      setSshCommandMessage("SSH command copied.");
    } catch {
      setSshCommandMessage("Could not copy command. Clipboard permissions may be blocked.");
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="row" style={compact ? { gap: 8 } : undefined}>
        {isSshRuntime ? (
          <>
            {buildSshDeepLink() ? (
              <a
                className="button secondary"
                href={buildSshDeepLink() ?? undefined}
                aria-disabled={isRedeploying || isDeleting || isUpgrading}
                onClick={(event) => {
                  if (isRedeploying || isDeleting || isUpgrading) {
                    event.preventDefault();
                  }
                }}
              >
                Open VM SSH
              </a>
            ) : null}
            <button
              className="button secondary"
              type="button"
              onClick={() => void handleCopySshCommand()}
              disabled={isRedeploying || isDeleting || isUpgrading}
            >
              Copy SSH command
            </button>
          </>
        ) : null}
        {isReady ? (
          <>
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
      {sshCommandMessage ? (
        <p className="muted" style={{ margin: 0 }}>
          {sshCommandMessage}
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
