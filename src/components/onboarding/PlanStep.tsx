"use client";

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
};

export function PlanStep({ deploymentFlavor, onDeploymentFlavorChange, onDeploy, loading }: Props) {
  return (
    <div className="card">
      <h2>Deployment mode</h2>
      <p className="muted">Choose which runtime to deploy (both free).</p>
      <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => onDeploymentFlavorChange("simple_agent_free")}
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
          <strong>Simple Agent (Free)</strong>
          <p className="muted" style={{ marginBottom: 8 }}>
            Deploys the `simpleagent` UI/service.
          </p>
        </button>
        <button
          type="button"
          onClick={() => onDeploymentFlavorChange("simple_agent_videomemory_free")}
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
            Deploys `simpleagent` and `videomemory` together on one VM (legacy SSH runtime, not ECS).
          </p>
        </button>
        <button
          type="button"
          onClick={() => onDeploymentFlavorChange("simple_agent_microservices_shared")}
          style={{
            textAlign: "left",
            border: deploymentFlavor === "simple_agent_microservices_shared" ? "1px solid var(--border-strong)" : "1px solid var(--border)",
            borderRadius: 10,
            padding: 16,
            background: deploymentFlavor === "simple_agent_microservices_shared" ? "var(--accent-surface)" : "var(--surface-strong)",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <strong>Simple Agent Microservices (Shared)</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            Fast one-click mode: uses a pre-warmed shared microservices runtime (DB/bootstrap only, no per-bot ECS startup).
          </p>
        </button>
        <button
          type="button"
          onClick={() => onDeploymentFlavorChange("simple_agent_microservices_ecs")}
          style={{
            textAlign: "left",
            border: deploymentFlavor === "simple_agent_microservices_ecs" ? "1px solid var(--border-strong)" : "1px solid var(--border)",
            borderRadius: 10,
            padding: 16,
            background: deploymentFlavor === "simple_agent_microservices_ecs" ? "var(--accent-surface)" : "var(--surface-strong)",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <strong>Simple Agent Microservices (ECS)</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            Deploys frontend + gateway + execution + post-service on ECS with Redis/Postgres sidecars.
          </p>
        </button>
        <button
          type="button"
          onClick={() => onDeploymentFlavorChange("ottoagent_free")}
          style={{
            textAlign: "left",
            border: deploymentFlavor === "ottoagent_free" ? "1px solid var(--border-strong)" : "1px solid var(--border)",
            borderRadius: 10,
            padding: 16,
            background: deploymentFlavor === "ottoagent_free" ? "var(--accent-surface)" : "var(--surface-strong)",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <strong>OttoAgent (Free)</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            Deploys `ottoagent` with `ottoagent-mcp`.
          </p>
        </button>
        <button
          type="button"
          onClick={() => onDeploymentFlavorChange("simple_agent_ottoauth_ecs")}
          style={{
            textAlign: "left",
            border: deploymentFlavor === "simple_agent_ottoauth_ecs" ? "1px solid var(--border-strong)" : "1px solid var(--border)",
            borderRadius: 10,
            padding: 16,
            background: deploymentFlavor === "simple_agent_ottoauth_ecs" ? "var(--accent-surface)" : "var(--surface-strong)",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <strong>Simple Agent + OttoAuth (ECS)</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            Deploys `simpleagent` with the `ottoagent-mcp` sidecar on ECS.
          </p>
        </button>
        <button
          type="button"
          onClick={() => onDeploymentFlavorChange("simple_agent_ottoauth_ecs_canary")}
          style={{
            textAlign: "left",
            border: deploymentFlavor === "simple_agent_ottoauth_ecs_canary" ? "1px solid var(--border-strong)" : "1px solid var(--border)",
            borderRadius: 10,
            padding: 16,
            background: deploymentFlavor === "simple_agent_ottoauth_ecs_canary" ? "var(--accent-surface)" : "var(--surface-strong)",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <strong>Simple Agent + OttoAuth (ECS Canary)</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            Testing flavor for canary ECS deployment strategy.
          </p>
        </button>
        <button
          type="button"
          onClick={() => onDeploymentFlavorChange("deploy_openclaw_free")}
          style={{
            textAlign: "left",
            border: deploymentFlavor === "deploy_openclaw_free" ? "1px solid var(--border-strong)" : "1px solid var(--border)",
            borderRadius: 10,
            padding: 16,
            background: deploymentFlavor === "deploy_openclaw_free" ? "var(--accent-surface)" : "var(--surface-strong)",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <strong>Deploy OpenClaw (Free)</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            Deploys the OpenClaw runtime and Control UI.
          </p>
        </button>
      </div>
      <button className="button" type="button" onClick={onDeploy} disabled={loading}>
        {loading ? "Starting..." : "Start Deployment"}
      </button>
    </div>
  );
}
