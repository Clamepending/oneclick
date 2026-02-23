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
    if (!response.ok) throw new Error("Unable to save progress");
  }

  async function handleNext() {
    setError("");
    try {
      await saveStep(step);
      setStep((s) => Math.min(3, s + 1));
    } catch {
      setError("Could not save this step. Please try again.");
    }
  }

  async function handleDeploy() {
    setLoading(true);
    setError("");
    try {
      await saveStep(3);
      const response = await fetch("/api/deployments", { method: "POST" });
      const body = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !body.id) {
        throw new Error(body.error ?? "Deployment failed to start");
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
