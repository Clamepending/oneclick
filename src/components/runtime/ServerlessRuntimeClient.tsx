"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type Props = {
  deploymentId: string;
  botName: string | null;
};

export function ServerlessRuntimeClient({ deploymentId, botName }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  const title = useMemo(() => (botName?.trim() ? botName.trim() : "Serverless Bot"), [botName]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/runtime/${deploymentId}/messages`, { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as
          | { ok?: boolean; error?: string; messages?: ChatMessage[] }
          | null;
        if (!response.ok || !body?.ok || !Array.isArray(body.messages)) {
          throw new Error(body?.error || "Failed to load chat history.");
        }
        if (!cancelled) {
          setMessages(body.messages);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load chat history.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [deploymentId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = draft.trim();
    if (!next || sending) return;
    setSending(true);
    setError("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: next }),
      });
      const body = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            userMessage?: ChatMessage;
            assistantMessage?: ChatMessage;
          }
        | null;
      if (!response.ok || !body?.ok || !body.userMessage || !body.assistantMessage) {
        throw new Error(body?.error || "Failed to send message.");
      }
      setMessages((current) => [...current, body.userMessage as ChatMessage, body.assistantMessage as ChatMessage]);
      setDraft("");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to send message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="container">
      <div className="card" style={{ display: "grid", gap: 12 }}>
        <h1 style={{ marginBottom: 0 }}>{title}</h1>
        <p className="muted" style={{ margin: 0 }}>
          Serverless runtime chat
        </p>

        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--surface-strong)",
            maxHeight: "60vh",
            overflowY: "auto",
            padding: 12,
            display: "grid",
            gap: 10,
          }}
        >
          {loading ? (
            <p className="muted" style={{ margin: 0 }}>
              Loading messages...
            </p>
          ) : messages.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No messages yet. Send one to start.
            </p>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                style={{
                  justifySelf: message.role === "user" ? "end" : "start",
                  maxWidth: "85%",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  background: message.role === "user" ? "var(--accent-surface)" : "var(--surface)",
                  padding: "8px 10px",
                }}
              >
                <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{message.content}</p>
              </div>
            ))
          )}
        </div>

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 8 }}>
          <textarea
            className="input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Type your message..."
            rows={4}
            disabled={sending}
          />
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <p className="muted" style={{ margin: 0 }}>
              {sending ? "Sending..." : "Reply target: a few seconds"}
            </p>
            <button className="button" type="submit" disabled={sending || !draft.trim()}>
              {sending ? "Sending..." : "Send"}
            </button>
          </div>
        </form>
        {error ? (
          <p style={{ color: "#ff8e8e", margin: 0 }} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
