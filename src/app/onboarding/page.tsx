"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { NameStep } from "@/components/onboarding/NameStep";
import { ChannelStep } from "@/components/onboarding/ChannelStep";
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
  const [step, setStep] = useState(1);
  const [botName, setBotName] = useState(() => generateDefaultBotName());
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");
  const [apiKey, setApiKey] = useState("");
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [deploymentFlavor, setDeploymentFlavor] = useState<"simple_agent_free" | "deploy_openclaw_free">(
    "simple_agent_free",
  );
  const [loading, setLoading] = useState(false);
  const [savingStep, setSavingStep] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      await fetch("/api/onboarding/start", { method: "POST" });
    })();
  }, []);

  const title = useMemo(() => `Step ${step} of 3`, [step]);

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

  async function saveStep(nextStep: number) {
    const response = await fetch("/api/onboarding/step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        step: nextStep,
        botName,
        channel: telegramBotToken.trim() ? "telegram" : "none",
        telegramBotToken: telegramBotToken.trim() || null,
        modelProvider: apiKey.trim() ? provider : null,
        modelApiKey: apiKey.trim() || null,
        plan: "free",
        deploymentFlavor,
      }),
    });
    if (!response.ok) {
      const message = await parseErrorMessage(response, "Unable to save progress");
      throw new Error(message);
    }
  }

  async function handleNext() {
    if (savingStep || loading) return;
    setError("");
    setSavingStep(true);
    try {
      await saveStep(step);
      setStep((s) => Math.min(3, s + 1));
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save this step. Please try again.";
      setError(message);
    } finally {
      setSavingStep(false);
    }
  }

  async function handleDeploy() {
    if (loading || savingStep) return;
    setLoading(true);
    setError("");
    try {
      await saveStep(3);
      const response = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deploymentFlavor }),
      });
      const body = await parseDeployResponse(response);
      if (!response.ok || !body.id) {
        throw new Error(body.error ?? body.message ?? "Deployment failed to start");
      }
      router.push(`/deployments/${body.id}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Deployment failed to start";
      setError(message);
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <p className="muted">{title}</p>

      {step === 1 && <NameStep value={botName} onChange={setBotName} />}
      {step === 2 && (
        <ChannelStep
          provider={provider}
          apiKey={apiKey}
          telegramBotToken={telegramBotToken}
          onProviderChange={setProvider}
          onApiKeyChange={setApiKey}
          onTelegramBotTokenChange={setTelegramBotToken}
        />
      )}
      {step === 3 && (
        <PlanStep
          deploymentFlavor={deploymentFlavor}
          onDeploymentFlavorChange={setDeploymentFlavor}
          onDeploy={handleDeploy}
          loading={loading}
        />
      )}

      {error ? (
        <p style={{ color: "#ff8e8e" }}>{error}</p>
      ) : null}

      <div className="row" style={{ marginTop: 12 }}>
        {step > 1 ? (
          <button
            className="button secondary"
            onClick={() => setStep((s) => s - 1)}
            type="button"
            disabled={savingStep || loading}
          >
            Back
          </button>
        ) : null}
        {step < 3 ? (
          <button className="button" onClick={handleNext} type="button" disabled={savingStep || loading}>
            {savingStep ? "Saving..." : "Next"}
          </button>
        ) : null}
      </div>
    </main>
  );
}
