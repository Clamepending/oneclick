"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  deploymentId: string;
  status?: "queued" | "starting" | "ready" | "failed";
  compact?: boolean;
  botName?: string | null;
};

export function DeploymentActions({ deploymentId, status, compact = false, botName }: Props) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [isRedeploying, setIsRedeploying] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const canDelete = status !== "queued";

  async function handleRedeploy() {
    setError("");
    setIsRedeploying(true);
    try {
      const response = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botName: botName ?? undefined }),
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
        <button
          className="button secondary"
          type="button"
          onClick={() => void handleRedeploy()}
          disabled={isRedeploying || isDeleting}
        >
          {isRedeploying ? "Redeploying..." : "Redeploy bot"}
        </button>
        <button
          className="button secondary"
          type="button"
          onClick={() => void handleDelete()}
          disabled={isRedeploying || isDeleting || !canDelete}
          title={!canDelete ? "Queued deployments cannot be deleted yet" : undefined}
        >
          {isDeleting ? "Deleting..." : "Delete bot"}
        </button>
      </div>
      {error ? (
        <p style={{ color: "#ff8e8e", margin: 0 }} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
