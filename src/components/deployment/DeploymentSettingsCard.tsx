"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  deploymentId: string;
  botName?: string | null;
  planTier?: "free" | "paid" | null;
  deploymentFlavor?: "basic" | "advanced" | null;
  hasOpenaiApiKey: boolean;
  hasAnthropicApiKey: boolean;
  hasOpenrouterApiKey: boolean;
  hasTelegramBotToken: boolean;
};

export function DeploymentSettingsCard({
  deploymentId,
  botName,
  planTier,
  deploymentFlavor,
  hasOpenaiApiKey,
  hasAnthropicApiKey,
  hasOpenrouterApiKey,
  hasTelegramBotToken,
}: Props) {
  const router = useRouter();
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingAndRedeploying, setSavingAndRedeploying] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function handleSave(redeployAfterSave = false) {
    if (redeployAfterSave) {
      setSavingAndRedeploying(true);
    } else {
      setSaving(true);
    }
    setMessage("");
    setError("");
    try {
      const payload: Record<string, string> = {};
      if (openaiApiKey.trim()) payload.openaiApiKey = openaiApiKey.trim();
      if (anthropicApiKey.trim()) payload.anthropicApiKey = anthropicApiKey.trim();
      if (openrouterApiKey.trim()) payload.openrouterApiKey = openrouterApiKey.trim();
      if (telegramBotToken.trim()) payload.telegramBotToken = telegramBotToken.trim();
      if (!Object.keys(payload).length) {
        throw new Error("Enter at least one setting to save.");
      }

      const response = await fetch(`/api/deployments/${deploymentId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            deploymentId?: string;
            redeployed?: boolean;
            liveApply?: { attempted?: boolean; applied?: boolean; reason?: string };
          }
        | null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error ?? "Failed to save deployment settings.");
      }

      let redeployId: string | null = null;
      if (redeployAfterSave) {
        const redeployResponse = await fetch("/api/deployments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            botName: botName ?? undefined,
            planTier: planTier === "paid" ? "paid" : "free",
            deploymentFlavor: planTier === "paid" ? "basic" : deploymentFlavor === "advanced" ? "advanced" : "basic",
          }),
        });
        const redeployBody = (await redeployResponse.json().catch(() => null)) as
          | { id?: string; error?: string }
          | null;
        if (!redeployResponse.ok || !redeployBody?.id) {
          throw new Error(redeployBody?.error ?? "Saved settings, but failed to redeploy.");
        }
        redeployId = redeployBody.id;
      }

      setOpenaiApiKey("");
      setAnthropicApiKey("");
      setOpenrouterApiKey("");
      setTelegramBotToken("");
      if (redeployId) {
        setMessage("Saved and started redeploy. Opening the new deployment...");
        router.push(`/deployments/${redeployId}`);
        router.refresh();
        return;
      }
      if (body?.liveApply?.attempted && body.liveApply.applied) {
        setMessage("Saved and applied to the running OpenClaw runtime.");
      } else if (body?.liveApply?.attempted) {
        const reason = body.liveApply.reason ? ` (${body.liveApply.reason})` : "";
        setMessage(`Saved. Live apply did not succeed${reason}, so new values are used on next redeploy.`);
      } else {
        setMessage("Saved. New values are used on next redeploy.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save deployment settings.");
    } finally {
      setSaving(false);
      setSavingAndRedeploying(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 14,
        border: "1px solid #243041",
        borderRadius: 12,
        padding: 14,
        background: "#0f1521",
        display: "grid",
        gap: 10,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18 }}>Runtime settings</h2>
      <p className="muted" style={{ margin: 0 }}>
        Values are hidden. If already set, leave blank to keep current values. Redeploy applies changes immediately.
      </p>
      <label className="muted">
        OpenAI API key {hasOpenaiApiKey ? "(already set)" : "(not set)"}
        <input
          className="input"
          type="password"
          value={openaiApiKey}
          onChange={(event) => setOpenaiApiKey(event.target.value)}
          placeholder={hasOpenaiApiKey ? "Already set (hidden)" : "sk-..."}
          autoComplete="off"
          style={{ marginTop: 6 }}
        />
      </label>
      <label className="muted">
        Anthropic API key {hasAnthropicApiKey ? "(already set)" : "(not set)"}
        <input
          className="input"
          type="password"
          value={anthropicApiKey}
          onChange={(event) => setAnthropicApiKey(event.target.value)}
          placeholder={hasAnthropicApiKey ? "Already set (hidden)" : "sk-ant-..."}
          autoComplete="off"
          style={{ marginTop: 6 }}
        />
      </label>
      <label className="muted">
        OpenRouter API key {hasOpenrouterApiKey ? "(already set)" : "(not set)"}
        <input
          className="input"
          type="password"
          value={openrouterApiKey}
          onChange={(event) => setOpenrouterApiKey(event.target.value)}
          placeholder={hasOpenrouterApiKey ? "Already set (hidden)" : "sk-or-..."}
          autoComplete="off"
          style={{ marginTop: 6 }}
        />
      </label>
      <label className="muted">
        Telegram bot token {hasTelegramBotToken ? "(already set)" : "(not set)"}
        <input
          className="input"
          type="password"
          value={telegramBotToken}
          onChange={(event) => setTelegramBotToken(event.target.value)}
          placeholder={hasTelegramBotToken ? "Already set (hidden)" : "123456789:AA..."}
          autoComplete="off"
          style={{ marginTop: 6 }}
        />
      </label>
      <div className="row">
        <button
          className="button"
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || savingAndRedeploying}
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          className="button secondary"
          type="button"
          onClick={() => void handleSave(true)}
          disabled={saving || savingAndRedeploying}
        >
          {savingAndRedeploying ? "Redeploying..." : "Redeploy"}
        </button>
      </div>
      {message ? (
        <p className="muted" style={{ margin: 0 }}>
          {message}
        </p>
      ) : null}
      {error ? (
        <p style={{ color: "#ff8e8e", margin: 0 }} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
