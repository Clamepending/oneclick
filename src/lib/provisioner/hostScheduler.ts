export type Host = {
  name: string;
  dockerHost: string;
  publicBaseUrl?: string;
};

function getHostPool(): Host[] {
  const raw = process.env.HOST_POOL_JSON;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as Host[];
    return parsed.filter((h) => h.name && h.dockerHost);
  } catch {
    return [];
  }
}

export function getHostByName(name: string): Host | null {
  const pool = getHostPool();
  return pool.find((host) => host.name === name) ?? null;
}

export async function selectHost(activeByHost: Map<string, number>): Promise<Host> {
  const pool = getHostPool();
  if (pool.length === 0) {
    throw new Error("HOST_POOL_JSON is missing or invalid.");
  }

  const maxContainers = Number(process.env.HOST_MAX_CONTAINERS ?? "50");

  const sorted = pool
    .map((host) => ({
      ...host,
      active: activeByHost.get(host.name) ?? 0,
    }))
    .filter((host) => host.active < maxContainers)
    .sort((a, b) => a.active - b.active);

  if (sorted.length === 0) {
    throw new Error("No capacity available in host pool.");
  }

  return sorted[0];
}
