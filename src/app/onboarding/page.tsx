"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { NameStep } from "@/components/onboarding/NameStep";
import { ChannelStep } from "@/components/onboarding/ChannelStep";
import { PlanStep } from "@/components/onboarding/PlanStep";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [botName, setBotName] = useState("My Assistant");
  const [channel, setChannel] = useState<"none" | "telegram">("none");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/onboarding/start", { method: "POST" });
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
        channel,
        plan: "free",
      }),
    });
    if (!response.ok) {
      const message = await parseErrorMessage(response, "Unable to save progress");
      throw new Error(message);
    }
  }

  async function handleNext() {
    setError("");
    try {
      await saveStep(step);
      setStep((s) => Math.min(3, s + 1));
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save this step. Please try again.";
      setError(message);
    }
  }

  async function handleDeploy() {
    setLoading(true);
    setError("");
    try {
      await saveStep(3);
      const response = await fetch("/api/deployments", { method: "POST" });
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
      {step === 2 && <ChannelStep value={channel} onChange={setChannel} />}
      {step === 3 && <PlanStep onDeploy={handleDeploy} loading={loading} />}

      {error ? (
        <p style={{ color: "#ff8e8e" }}>{error}</p>
      ) : null}

      <div className="row" style={{ marginTop: 12 }}>
        {step > 1 ? (
          <button className="button secondary" onClick={() => setStep((s) => s - 1)} type="button">
            Back
          </button>
        ) : null}
        {step < 3 ? (
          <button className="button" onClick={handleNext} type="button">
            Next
          </button>
        ) : null}
      </div>
    </main>
  );
}
