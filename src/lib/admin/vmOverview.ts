import { Client } from "ssh2";
import type { Host } from "@/lib/provisioner/hostScheduler";

export type VmContainer = {
  name: string;
  image: string;
  status: string;
  ports: string;
};

export type VmStats = {
  uptimeSeconds: number;
  loadAvg: string;
  cpuCores: number;
  memTotalKb: number;
  memAvailableKb: number;
  diskTotalKb: number;
  diskUsedKb: number;
  diskAvailKb: number;
  diskUsePercent: string;
};

export type HostOverview = {
  host: Host;
  stats: VmStats | null;
  containers: VmContainer[];
  error: string | null;
};

function parseSshTarget(dockerHost: string) {
  if (!dockerHost.startsWith("ssh://")) return null;
  return dockerHost.replace("ssh://", "");
}

function parseUserAndHost(sshTarget: string) {
  const [user, host] = sshTarget.includes("@")
    ? sshTarget.split("@")
    : ["root", sshTarget];
  return { user, host };
}

async function runSshCommandWithOutput(sshTarget: string, command: string) {
  const { user, host } = parseUserAndHost(sshTarget);
  const privateKeyRaw = process.env.DEPLOY_SSH_PRIVATE_KEY?.trim();
  if (!privateKeyRaw) {
    throw new Error("DEPLOY_SSH_PRIVATE_KEY is required.");
  }
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const timeoutMs = Number(process.env.OPENCLAW_SSH_TIMEOUT_MS ?? "120000");

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const conn = new Client();

    const finish = (result?: { stdout: string; stderr: string }, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      conn.end();
      if (error) {
        reject(error);
      } else if (result) {
        resolve(result);
      } else {
        reject(new Error("SSH command exited without result"));
      }
    };

    conn
      .on("ready", () => {
        timer = setTimeout(() => {
          finish(undefined, new Error(`SSH command timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        conn.exec(command, (execErr, stream) => {
          if (execErr) {
            finish(undefined, execErr);
            return;
          }

          let stdout = "";
          let stderr = "";
          stream.on("data", (data: Buffer) => {
            stdout += data.toString("utf8");
          });
          stream.stderr.on("data", (data: Buffer) => {
            stderr += data.toString("utf8");
          });
          stream.on("close", (code: number | null) => {
            if (code === 0) {
              finish({ stdout, stderr });
            } else {
              finish(undefined, new Error(stderr || `SSH command failed with code ${code ?? "unknown"}`));
            }
          });
        });
      })
      .on("error", (error) => finish(undefined, error))
      .connect({
        host,
        username: user,
        privateKey,
        readyTimeout: timeoutMs,
      });
  });
}

function parseStats(raw: string): VmStats {
  const values = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("=")) continue;
    const [key, value] = trimmed.split("=", 2);
    values.set(key, value);
  }

  return {
    uptimeSeconds: Number(values.get("uptime_seconds") ?? "0"),
    loadAvg: values.get("load_avg") ?? "0 0 0",
    cpuCores: Number(values.get("cpu_cores") ?? "0"),
    memTotalKb: Number(values.get("mem_total_kb") ?? "0"),
    memAvailableKb: Number(values.get("mem_available_kb") ?? "0"),
    diskTotalKb: Number(values.get("disk_total_kb") ?? "0"),
    diskUsedKb: Number(values.get("disk_used_kb") ?? "0"),
    diskAvailKb: Number(values.get("disk_avail_kb") ?? "0"),
    diskUsePercent: values.get("disk_use_percent") ?? "0%",
  };
}

function parseContainers(raw: string): VmContainer[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return {
        name: parts[0] ?? "",
        image: parts[1] ?? "",
        status: parts[2] ?? "",
        ports: parts[3] ?? "",
      };
    });
}

export async function fetchHostOverview(host: Host): Promise<HostOverview> {
  const sshTarget = parseSshTarget(host.dockerHost);
  if (!sshTarget) {
    return {
      host,
      stats: null,
      containers: [],
      error: "Host does not use ssh:// dockerHost, cannot fetch VM stats.",
    };
  }

  const statsCmd = [
    "set -e",
    "echo \"uptime_seconds=$(cut -d'.' -f1 /proc/uptime)\"",
    "echo \"load_avg=$(cut -d' ' -f1-3 /proc/loadavg)\"",
    "echo \"cpu_cores=$(nproc)\"",
    "echo \"mem_total_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)\"",
    "echo \"mem_available_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)\"",
    "echo \"disk_total_kb=$(df -Pk / | awk 'NR==2 {print $2}')\"",
    "echo \"disk_used_kb=$(df -Pk / | awk 'NR==2 {print $3}')\"",
    "echo \"disk_avail_kb=$(df -Pk / | awk 'NR==2 {print $4}')\"",
    "echo \"disk_use_percent=$(df -Pk / | awk 'NR==2 {print $5}')\"",
  ].join(" && ");

  const containersCmd =
    "docker ps --format '{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}' || true";

  try {
    const [statsResult, containersResult] = await Promise.all([
      runSshCommandWithOutput(sshTarget, statsCmd),
      runSshCommandWithOutput(sshTarget, containersCmd),
    ]);

    return {
      host,
      stats: parseStats(statsResult.stdout),
      containers: parseContainers(containersResult.stdout),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      host,
      stats: null,
      containers: [],
      error: message,
    };
  }
}
