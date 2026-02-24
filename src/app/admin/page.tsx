"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ContainerItem = {
  name: string;
  image: string;
  status: string;
  ports: string;
  size?: string;
  cpuPercent?: string;
  memUsage?: string;
  memPercent?: string;
  ownerUserId?: string | null;
  ownerBotName?: string | null;
  ownerDeploymentId?: string | null;
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
  hostPoolConfigured?: boolean;
  deployProvider?: string;
  hosts: HostItem[];
  recentDeployments?: Array<{
    id: string;
    user_id: string;
    bot_name: string | null;
    status: string;
    deploy_provider: string | null;
    runtime_id: string | null;
    ready_url: string | null;
    error: string | null;
    created_at: string;
    updated_at: string;
  }>;
  subsidyUsage?: {
    totalRequests: number;
    requests24h: number;
    requests1h: number;
    rateLimited1h: number;
    uniqueDeployments24h: number;
    topDeployments24h: Array<{ deploymentId: string; botName: string | null; requestCount: number }>;
    topUsers24h: Array<{
      userId: string;
      requestCount: number;
      requests1h: number;
      rateLimited1h: number;
    }>;
  };
  error?: string;
};

type ContainerGroup = {
  key: string;
  title: string;
  containers: ContainerItem[];
  sortOrder: number;
};

function asGbFromKb(kb: number) {
  return (kb / 1024 / 1024).toFixed(2);
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function usageColor(percent: number) {
  if (percent >= 90) return "#ff8e8e";
  if (percent >= 75) return "#ffd166";
  return "#7bd88f";
}

function barStyle(percent: number): React.CSSProperties {
  const safePercent = clampPercent(percent);
  return {
    width: `${safePercent.toFixed(0)}%`,
    height: 8,
    borderRadius: 999,
    background: usageColor(safePercent),
    transition: "width 200ms ease",
  };
}

function parseLoad1(loadAvg: string) {
  const raw = loadAvg.split(" ")[0] ?? "0";
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${mins}m`;
}

function imageRepository(image: string) {
  const withoutDigest = image.split("@")[0] ?? image;
  const [repo] = withoutDigest.split(":");
  return repo ?? "";
}

function titleFromRepo(repo: string) {
  if (!repo) return "Unknown";
  const normalized = repo.trim().toLowerCase();
  if (normalized.includes("openclaw")) return "Vanilla OpenClaw";
  if (normalized.includes("oneclick")) return "Vanilla OpenClaw";
  return repo;
}

function groupContainers(containers: ContainerItem[]): ContainerGroup[] {
  const grouped = new Map<string, ContainerGroup>();

  for (const container of containers) {
    const lowerName = container.name.toLowerCase();
    const repo = imageRepository(container.image);
    const lowerRepo = repo.toLowerCase();

    let key = "";
    let title = "";
    let sortOrder = 0;

    if (lowerName.includes("caddy") || lowerRepo === "caddy") {
      key = "caddy";
      title = "Caddy";
      sortOrder = 0;
    } else if (
      lowerRepo.includes("openclaw") ||
      lowerRepo.includes("oneclick") ||
      lowerName.startsWith("oneclick-")
    ) {
      key = "agent:vanilla-openclaw";
      title = "Agent: Vanilla OpenClaw";
      sortOrder = 1;
    } else {
      const inferredType = titleFromRepo(repo);
      key = `agent:${inferredType.toLowerCase()}`;
      title = `Agent: ${inferredType}`;
      sortOrder = 2;
    }

    if (!grouped.has(key)) {
      grouped.set(key, { key, title, containers: [], sortOrder });
    }

    grouped.get(key)?.containers.push(container);
  }

  return Array.from(grouped.values()).sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.title.localeCompare(b.title);
  });
}

export default function AdminPage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeDeleteKey, setActiveDeleteKey] = useState<string | null>(null);

  const loadOverview = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/admin/overview", { cache: "no-store", signal });
    const body = (await response.json().catch(() => null)) as OverviewResponse | null;
    if (!response.ok || !body?.ok) {
      throw new Error(body?.error ?? "Failed to load admin overview");
    }
    return body;
  }, []);

  const refreshOverview = useCallback(async () => {
    const body = await loadOverview();
    setData(body);
    setError("");
  }, [loadOverview]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      try {
        const body = await loadOverview(controller.signal);
        if (!cancelled) {
          setData(body);
          setError("");
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Unknown admin error");
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
      controller.abort();
      clearInterval(timer);
    };
  }, [loadOverview]);

  async function handleDeleteContainer(input: {
    dockerHost: string;
    containerName: string;
    ownerDeploymentId?: string | null;
  }) {
    const confirmed = window.confirm(
      `Delete container "${input.containerName}"? This will force-stop and remove it.`,
    );
    if (!confirmed) return;

    const deleteKey = `${input.dockerHost}|${input.containerName}`;
    setActiveDeleteKey(deleteKey);
    setError("");
    try {
      const response = await fetch("/api/admin/containers/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? "Failed to delete container");
      }
      await refreshOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete container");
    } finally {
      setActiveDeleteKey(null);
    }
  }

  const totalContainers = useMemo(() => {
    if (!data?.hosts) return 0;
    return data.hosts.reduce((sum, host) => sum + host.containers.length, 0);
  }, [data]);

  const readyDeployments = useMemo(() => {
    return (data?.recentDeployments ?? []).filter((item) => item.status === "ready").length;
  }, [data]);

  const failedDeployments = useMemo(() => {
    return (data?.recentDeployments ?? []).filter((item) => item.status === "failed").length;
  }, [data]);

  const isEcsMode = (data?.deployProvider ?? "").trim() === "ecs";

  return (
    <main className="container">
      <div className="card">
        <h1>Admin dashboard</h1>
        <p className="muted">
          Runtime operations overview. Current deploy provider: <code>{data?.deployProvider ?? "unknown"}</code>
          {data?.hostPoolConfigured === false ? " (host pool not configured; ECS-only mode)" : ""}
        </p>
        {data?.generatedAt ? <p className="muted">Last refresh: {new Date(data.generatedAt).toLocaleString()}</p> : null}
        <p className="muted">Total running containers: {totalContainers}</p>
        <p className="muted">
          Recent deployments: <code>{data?.recentDeployments?.length ?? 0}</code> • Ready: <code>{readyDeployments}</code> • Failed:{" "}
          <code>{failedDeployments}</code>
        </p>
        {loading ? <p className="muted">Loading admin metrics...</p> : null}
        {error ? <p style={{ color: "#ff8e8e" }}>{error}</p> : null}
      </div>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ marginTop: 0 }}>Subsidy usage</h2>
        <p className="muted">Request volume served via server-side OpenAI subsidy proxy.</p>
        <div style={{ display: "grid", gap: 6 }}>
          <p className="muted" style={{ marginBottom: 0 }}>
            Total requests: <code>{data?.subsidyUsage?.totalRequests ?? 0}</code>
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Requests (24h): <code>{data?.subsidyUsage?.requests24h ?? 0}</code> | Requests (1h):{" "}
            <code>{data?.subsidyUsage?.requests1h ?? 0}</code>
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Rate-limited (1h): <code>{data?.subsidyUsage?.rateLimited1h ?? 0}</code> | Active deployments (24h):{" "}
            <code>{data?.subsidyUsage?.uniqueDeployments24h ?? 0}</code>
          </p>
        </div>
        <h3 style={{ marginBottom: 8 }}>Top deployments (24h)</h3>
        {data?.subsidyUsage?.topDeployments24h?.length ? (
          <div style={{ display: "grid", gap: 6 }}>
            {data.subsidyUsage.topDeployments24h.map((item) => (
              <p className="muted" style={{ marginBottom: 0 }} key={item.deploymentId}>
                <code>{item.botName?.trim() || "Unnamed bot"}</code> (<code>{item.deploymentId}</code>):{" "}
                <code>{item.requestCount}</code> requests
              </p>
            ))}
          </div>
        ) : (
          <p className="muted">No subsidy usage recorded yet.</p>
        )}
        <h3 style={{ marginBottom: 8, marginTop: 14 }}>Users (24h)</h3>
        {data?.subsidyUsage?.topUsers24h?.length ? (
          <div style={{ display: "grid", gap: 6 }}>
            {data.subsidyUsage.topUsers24h.map((item) => (
              <p className="muted" style={{ marginBottom: 0 }} key={item.userId}>
                <code>{item.userId}</code>: <code>{item.requestCount}</code> requests (1h:{" "}
                <code>{item.requests1h}</code>, 429 1h: <code>{item.rateLimited1h}</code>)
              </p>
            ))}
          </div>
        ) : (
          <p className="muted">No user-level subsidy usage yet.</p>
        )}
      </section>

      {isEcsMode && data?.hostPoolConfigured && (data.hosts?.length ?? 0) > 0 ? (
        <section className="card" style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0 }}>Legacy SSH Host Pool</h2>
          <p className="muted">
            <code>HOST_POOL_JSON</code> is still configured (for example <code>{data.hosts[0]?.host.name}</code>), but the app is currently running in{" "}
            <code>ecs</code> mode. These host cards are hidden to reduce confusion.
          </p>
        </section>
      ) : null}

      {!isEcsMode && data?.hosts?.map((item) => (
        <section className="card" key={item.host.name} style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0 }}>{item.host.name}</h2>
          <p className="muted">
            <code>{item.host.dockerHost}</code>
          </p>

          {item.error ? (
            <p style={{ color: "#ff8e8e" }}>{item.error}</p>
          ) : item.stats ? (
            <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
              {(() => {
                const load1 = parseLoad1(item.stats.loadAvg);
                const cpuPercent = clampPercent((load1 / Math.max(item.stats.cpuCores, 1)) * 100);
                const memUsedKb = Math.max(item.stats.memTotalKb - item.stats.memAvailableKb, 0);
                const memPercent = clampPercent((memUsedKb / Math.max(item.stats.memTotalKb, 1)) * 100);
                const diskPercent = clampPercent(Number(item.stats.diskUsePercent.replace("%", "")));
                return (
                  <div style={{ display: "grid", gap: 8 }}>
                    <div>
                      <p className="muted" style={{ marginBottom: 4 }}>
                        CPU load (1m): <code>{cpuPercent.toFixed(0)}%</code> (<code>{load1.toFixed(2)}</code> /{" "}
                        <code>{item.stats.cpuCores}</code> cores)
                      </p>
                      <div style={{ width: "100%", background: "#1f1f1f", borderRadius: 999, overflow: "hidden" }}>
                        <div style={barStyle(cpuPercent)} />
                      </div>
                    </div>
                    <div>
                      <p className="muted" style={{ marginBottom: 4 }}>
                        Memory used: <code>{memPercent.toFixed(0)}%</code> (<code>{asGbFromKb(memUsedKb)} GB</code> /{" "}
                        <code>{asGbFromKb(item.stats.memTotalKb)} GB</code>)
                      </p>
                      <div style={{ width: "100%", background: "#1f1f1f", borderRadius: 999, overflow: "hidden" }}>
                        <div style={barStyle(memPercent)} />
                      </div>
                    </div>
                    <div>
                      <p className="muted" style={{ marginBottom: 4 }}>
                        Disk used: <code>{diskPercent.toFixed(0)}%</code> (<code>{asGbFromKb(item.stats.diskUsedKb)} GB</code>{" "}
                        / <code>{asGbFromKb(item.stats.diskTotalKb)} GB</code>)
                      </p>
                      <div style={{ width: "100%", background: "#1f1f1f", borderRadius: 999, overflow: "hidden" }}>
                        <div style={barStyle(diskPercent)} />
                      </div>
                    </div>
                  </div>
                );
              })()}
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
            <div style={{ display: "grid", gap: 12 }}>
              {groupContainers(item.containers).map((group) => (
                <section key={`${item.host.name}-${group.key}`}>
                  <h4 style={{ marginBottom: 8 }}>
                    {group.title} ({group.containers.length})
                  </h4>
                  <div style={{ display: "grid", gap: 8 }}>
                    {group.containers.map((container) => (
                      <div className="card" key={`${item.host.name}-${group.key}-${container.name}`}>
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
                        <p className="muted" style={{ marginBottom: 0 }}>
                          Resource usage: CPU <code>{container.cpuPercent?.trim() || "n/a"}</code> | Memory{" "}
                          <code>{container.memUsage?.trim() || "n/a"}</code> (<code>{container.memPercent?.trim() || "n/a"}</code>)
                        </p>
                        <p className="muted" style={{ marginBottom: 0 }}>
                          Writable layer: <code>{container.size?.trim() || "n/a"}</code>
                        </p>
                        <p className="muted" style={{ marginBottom: 0 }}>
                          Owner: <code>{container.ownerUserId?.trim() || "unknown"}</code>
                        </p>
                        <p className="muted" style={{ marginBottom: 0 }}>
                          Bot: <code>{container.ownerBotName?.trim() || "unknown"}</code> • Deployment:{" "}
                          <code>{container.ownerDeploymentId?.trim() || "unknown"}</code>
                        </p>
                        {group.key.startsWith("agent:") ? (
                          <div className="row" style={{ marginTop: 10 }}>
                            <button
                              className="button secondary"
                              type="button"
                              onClick={() =>
                                void handleDeleteContainer({
                                  dockerHost: item.host.dockerHost,
                                  containerName: container.name,
                                  ownerDeploymentId: container.ownerDeploymentId ?? null,
                                })
                              }
                              disabled={activeDeleteKey === `${item.host.dockerHost}|${container.name}`}
                            >
                              {activeDeleteKey === `${item.host.dockerHost}|${container.name}`
                                ? "Deleting..."
                                : "Delete container"}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
      ))}

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ marginTop: 0 }}>Recent deployments</h2>
        <p className="muted">Latest deployment records across all users (works for ECS and SSH modes).</p>
        {!data?.recentDeployments?.length ? (
          <p className="muted">No deployments found yet.</p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {data.recentDeployments.map((item) => {
              const isReplaced = (item.error ?? "").toLowerCase().includes("replaced by newer deployment");
              const canOpen = item.status === "ready" && Boolean(item.ready_url);
              return (
                <div className="card" key={item.id}>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Bot: <code>{item.bot_name?.trim() || "Unnamed bot"}</code> • User: <code>{item.user_id}</code>
                  </p>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Deployment: <code>{item.id}</code>
                  </p>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Status: <code>{item.status}</code> • Provider: <code>{item.deploy_provider?.trim() || "unknown"}</code>
                  </p>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Runtime: <code>{item.runtime_id?.trim() || "none"}</code>
                  </p>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Updated: <code>{new Date(item.updated_at).toLocaleString()}</code>
                  </p>
                  {item.error ? (
                    <p className="muted" style={{ marginBottom: 0, color: isReplaced ? "#ffd166" : "#ff8e8e" }}>
                      Error: <code>{item.error}</code>
                    </p>
                  ) : null}
                  {canOpen ? (
                    <div className="row" style={{ marginTop: 10 }}>
                      <a className="button secondary" href={item.ready_url!} target="_blank" rel="noreferrer">
                        Open runtime
                      </a>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
