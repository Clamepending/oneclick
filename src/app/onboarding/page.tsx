"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { NameStep } from "@/components/onboarding/NameStep";
import { PlanStep } from "@/components/onboarding/PlanStep";

function generateDefaultBotName() {
  const adjectives = ["Swift", "Bright", "Nova", "Clever", "Calm", "Bold", "Blue", "Sunny"];
  const nouns = ["Fox", "Otter", "Panda", "Raven", "Lynx", "Falcon", "Whale", "Koala"];
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = String(Math.floor(Math.random() * 900 + 100));
  return `${adjective}${noun}${suffix}`;
}

export default function OnboardingPage() {
  const router = useRouter();
  const [botName, setBotName] = useState(() => generateDefaultBotName());
  const [deploymentFlavor, setDeploymentFlavor] = useState<"simple_agent_free" | "deploy_openclaw_free">(
    "simple_agent_free",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      await fetch("/api/onboarding/start", { method: "POST" });
    })();
  }, []);

  async function parseErrorMessage(response: Response, fallback: string) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      return body?.error ?? body?.message ?? fallback;
    }
    const text = (await response.text().catch(() => ""))?.trim();
    return text || fallback;
  }

  async function parseDeployResponse(response: Response) {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = (await response.text().catch(() => ""))?.trim();
      throw new Error(text || "Deployment API returned non-JSON response");
    }
    return (await response.json()) as { id?: string; error?: string; message?: string };
  }

  async function saveOnboarding() {
    const response = await fetch("/api/onboarding/step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        step: 3,
        botName,
        plan: "free",
        deploymentFlavor,
      }),
    });
    if (!response.ok) {
      const message = await parseErrorMessage(response, "Unable to save progress");
      throw new Error(message);
    }
  }

  async function handleDeploy() {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      await saveOnboarding();
      const response = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deploymentFlavor }),
      });
      const body = await parseDeployResponse(response);
      if (!response.ok || !body.id) {
        throw new Error(body.error ?? body.message ?? "Deployment failed to start");
      }
      router.push("/");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Deployment failed to start";
      setError(message);
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1 style={{ marginTop: 0 }}>Start a deployment</h1>
      <div style={{ display: "grid", gap: 12 }}>
        <NameStep value={botName} onChange={setBotName} />
        <PlanStep
          deploymentFlavor={deploymentFlavor}
          onDeploymentFlavorChange={setDeploymentFlavor}
          onDeploy={handleDeploy}
          loading={loading}
        />
      </div>

      {error ? (
        <p style={{ color: "#ff8e8e" }}>{error}</p>
      ) : null}
    </main>
  );
}
