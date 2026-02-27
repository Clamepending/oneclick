const DEFAULT_PATHS = ["/health", "/"];

function normalizeConfiguredPath(path: string | undefined) {
  const trimmed = (path ?? "").trim();
  if (!trimmed) return null;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function getProbePaths() {
  const configured = normalizeConfiguredPath(process.env.OPENCLAW_HEALTH_PATH);
  const ordered = configured ? [configured, ...DEFAULT_PATHS] : [...DEFAULT_PATHS];
  return Array.from(new Set(ordered));
}

function isReachableStatus(status: number) {
  return (status >= 200 && status < 400) || status === 401 || status === 403;
}

export async function probeRuntimeHttp(readyUrl: string, timeoutMs = 3000) {
  const paths = getProbePaths();
  for (const path of paths) {
    try {
      const url = new URL(path, readyUrl);
      const response = await fetch(url.toString(), {
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (isReachableStatus(response.status)) {
        return { ok: true, status: response.status, path };
      }
    } catch {
      // Try the next path.
    }
  }

  return { ok: false, status: null as number | null, path: null as string | null };
}
