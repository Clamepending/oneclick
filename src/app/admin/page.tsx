"use client";

import { useEffect, useMemo, useState } from "react";

type ContainerItem = {
  name: string;
  image: string;
  status: string;
  ports: string;
};

type HostItem = {
  host: {
    name: string;
    dockerHost: string;
    publicBaseUrl?: string;
  };
  stats: {
    uptimeSeconds: number;
    loadAvg: string;
    cpuCores: number;
    memTotalKb: number;
    memAvailableKb: number;
    diskTotalKb: number;
    diskUsedKb: number;
    diskAvailKb: number;
    diskUsePercent: string;
  } | null;
  containers: ContainerItem[];
  error: string | null;
};

type OverviewResponse = {
  ok: boolean;
  generatedAt: string;
  hosts: HostItem[];
  error?: string;
};

function asGbFromKb(kb: number) {
  return (kb / 1024 / 1024).toFixed(2);
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${mins}m`;
}

export default function AdminPage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch("/api/admin/overview", { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as OverviewResponse | null;
        if (!response.ok || !body?.ok) {
          throw new Error(body?.error ?? "Failed to load admin overview");
        }
        if (!cancelled) {
          setData(body);
          setError("");
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unknown admin error");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const totalContainers = useMemo(() => {
    if (!data?.hosts) return 0;
    return data.hosts.reduce((sum, host) => sum + host.containers.length, 0);
  }, [data]);

  return (
    <main className="container">
      <div className="card">
        <h1>Admin dashboard</h1>
        <p className="muted">VM health and runtime containers across your host pool.</p>
        {data?.generatedAt ? <p className="muted">Last refresh: {new Date(data.generatedAt).toLocaleString()}</p> : null}
        <p className="muted">Total running containers: {totalContainers}</p>
        {loading ? <p className="muted">Loading admin metrics...</p> : null}
        {error ? <p style={{ color: "#ff8e8e" }}>{error}</p> : null}
      </div>

      {data?.hosts?.map((item) => (
        <section className="card" key={item.host.name} style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0 }}>{item.host.name}</h2>
          <p className="muted">
            <code>{item.host.dockerHost}</code>
          </p>

          {item.error ? (
            <p style={{ color: "#ff8e8e" }}>{item.error}</p>
          ) : item.stats ? (
            <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
              <p className="muted" style={{ marginBottom: 0 }}>
                Uptime: <code>{formatUptime(item.stats.uptimeSeconds)}</code>
              </p>
              <p className="muted" style={{ marginBottom: 0 }}>
                Load avg: <code>{item.stats.loadAvg}</code> | CPU cores: <code>{item.stats.cpuCores}</code>
              </p>
              <p className="muted" style={{ marginBottom: 0 }}>
                Memory: <code>{asGbFromKb(item.stats.memAvailableKb)} GB free</code> /{" "}
                <code>{asGbFromKb(item.stats.memTotalKb)} GB total</code>
              </p>
              <p className="muted" style={{ marginBottom: 0 }}>
                Disk: <code>{asGbFromKb(item.stats.diskUsedKb)} GB used</code> /{" "}
                <code>{asGbFromKb(item.stats.diskTotalKb)} GB total</code> (<code>{item.stats.diskUsePercent}</code>)
              </p>
            </div>
          ) : null}

          <h3 style={{ marginBottom: 8 }}>Running containers ({item.containers.length})</h3>
          {item.containers.length === 0 ? (
            <p className="muted">No running containers.</p>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {item.containers.map((container) => (
                <div className="card" key={`${item.host.name}-${container.name}`}>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Name: <code>{container.name}</code>
                  </p>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Image: <code>{container.image}</code>
                  </p>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Status: <code>{container.status}</code>
                  </p>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Ports: <code>{container.ports || "none"}</code>
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </main>
  );
}
