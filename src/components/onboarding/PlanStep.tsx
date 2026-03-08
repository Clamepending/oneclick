"use client";

import type { KeyboardEvent } from "react";

type Props = {
  deploymentFlavor:
    | "simple_agent_free"
    | "simple_agent_videomemory_free"
    | "simple_agent_microservices_ecs"
    | "simple_agent_microservices_shared"
    | "simple_agent_ottoauth_ecs"
    | "simple_agent_ottoauth_ecs_canary"
    | "deploy_openclaw_free"
    | "ottoagent_free";
  onDeploymentFlavorChange: (
    value:
      | "simple_agent_free"
      | "simple_agent_videomemory_free"
      | "simple_agent_microservices_ecs"
      | "simple_agent_microservices_shared"
      | "simple_agent_ottoauth_ecs"
      | "simple_agent_ottoauth_ecs_canary"
      | "deploy_openclaw_free"
      | "ottoagent_free",
  ) => void;
  onDeploy: () => void;
  loading: boolean;
  serverlessRuntimeVersion?: string;
  serverlessRuntimeSourceUrl?: string;
};

export function PlanStep({
  deploymentFlavor,
  onDeploymentFlavorChange,
  onDeploy,
  loading,
  serverlessRuntimeVersion,
  serverlessRuntimeSourceUrl,
}: Props) {
  const hasServerlessRuntimeVersion = Boolean(serverlessRuntimeVersion?.trim());

  function onOptionKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    value:
      | "simple_agent_free"
      | "simple_agent_videomemory_free"
      | "simple_agent_microservices_ecs"
      | "simple_agent_microservices_shared"
      | "simple_agent_ottoauth_ecs"
      | "simple_agent_ottoauth_ecs_canary"
      | "deploy_openclaw_free"
      | "ottoagent_free",
  ) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onDeploymentFlavorChange(value);
  }

  return (
    <div className="card">
      <h2>Deployment mode</h2>
      <p className="muted">Choose serverless chat or the legacy VideoMemory VM path.</p>
      <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
        <div
          role="button"
          tabIndex={0}
          aria-pressed={deploymentFlavor === "simple_agent_free"}
          onClick={() => onDeploymentFlavorChange("simple_agent_free")}
          onKeyDown={(event) => onOptionKeyDown(event, "simple_agent_free")}
          style={{
            textAlign: "left",
            border: deploymentFlavor === "simple_agent_free" ? "1px solid var(--border-strong)" : "1px solid var(--border)",
            borderRadius: 10,
            padding: 16,
            background: deploymentFlavor === "simple_agent_free" ? "var(--accent-surface)" : "var(--surface-strong)",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <strong>Simple Agent (Serverless)</strong>
          <p className="muted" style={{ marginBottom: 8 }}>
            Lambda-based runtime with no always-on ECS task.
          </p>
          {hasServerlessRuntimeVersion ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Version <code>{serverlessRuntimeVersion?.trim()}</code>
              {serverlessRuntimeSourceUrl?.trim() ? (
                <>
                  {" "}
                  <a
                    href={serverlessRuntimeSourceUrl.trim()}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    View source
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <div
          role="button"
          tabIndex={0}
          aria-pressed={deploymentFlavor === "simple_agent_videomemory_free"}
          onClick={() => onDeploymentFlavorChange("simple_agent_videomemory_free")}
          onKeyDown={(event) => onOptionKeyDown(event, "simple_agent_videomemory_free")}
          style={{
            textAlign: "left",
            border: deploymentFlavor === "simple_agent_videomemory_free" ? "1px solid var(--border-strong)" : "1px solid var(--border)",
            borderRadius: 10,
            padding: 16,
            background: deploymentFlavor === "simple_agent_videomemory_free" ? "var(--accent-surface)" : "var(--surface-strong)",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <strong>Simple Agent + VideoMemory (Free)</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            Deploys `simpleagent` and `videomemory` together on one VM (legacy DigitalOcean SSH runtime).
          </p>
        </div>
      </div>
      <button className="button" type="button" onClick={onDeploy} disabled={loading}>
        {loading ? "Starting..." : "Start Deployment"}
      </button>
    </div>
  );
}
