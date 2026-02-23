"use client";

type EventItem = {
  status: string;
  message: string;
  ts: string;
};

export function ProgressTimeline({ items }: { items: EventItem[] }) {
  if (items.length === 0) {
    return <p className="muted">Waiting for deployment events...</p>;
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {items.map((item) => (
        <div className="card" key={`${item.ts}-${item.status}-${item.message}`}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{item.status.toUpperCase()}</strong>
            <span className="muted">{new Date(item.ts).toLocaleTimeString()}</span>
          </div>
          <p style={{ marginBottom: 0 }}>{item.message}</p>
        </div>
      ))}
    </div>
  );
}
