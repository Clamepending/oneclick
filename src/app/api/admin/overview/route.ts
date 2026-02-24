import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin/access";
import { fetchSubsidyUsageOverview } from "@/lib/admin/subsidyUsage";
import { fetchHostOverview } from "@/lib/admin/vmOverview";
import { ensureSchema, pool } from "@/lib/db";
import { listHosts } from "@/lib/provisioner/hostScheduler";

function deploymentPrefixFromContainerName(containerName: string) {
  const match = containerName.trim().match(/-([0-9a-f]{8}-[0-9a-f])$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export async function GET() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdminEmail(email)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  await ensureSchema();
  const hosts = listHosts();

  const [overview, subsidyUsage, recentDeployments] = await Promise.all([
    hosts.length > 0 ? Promise.all(hosts.map((host) => fetchHostOverview(host))) : Promise.resolve([]),
    fetchSubsidyUsageOverview(),
    pool.query<{
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
    }>(
      `SELECT
         id, user_id, bot_name, status, deploy_provider, runtime_id, ready_url, error, created_at, updated_at
       FROM deployments
       ORDER BY updated_at DESC
       LIMIT 50`,
    ),
  ]);

  const containerNames = Array.from(
    new Set(
      overview
        .flatMap((hostOverview) => hostOverview.containers.map((container) => container.name.trim()))
        .filter(Boolean),
    ),
  );

  const ownershipByContainer = new Map<
    string,
    { deploymentId: string; userId: string; botName: string | null }
  >();
  const unresolvedContainerNames = new Set(containerNames);
  if (containerNames.length) {
    const ownershipRows = await pool.query<{
      id: string;
      user_id: string;
      bot_name: string | null;
      container_name: string;
    }>(
      `SELECT
         id,
         user_id,
         bot_name,
         split_part(runtime_id, '|', 2) AS container_name
       FROM deployments
       WHERE runtime_id IS NOT NULL
         AND split_part(runtime_id, '|', 2) = ANY($1::text[])
       ORDER BY updated_at DESC`,
      [containerNames],
    );

    for (const row of ownershipRows.rows) {
      if (!row.container_name || ownershipByContainer.has(row.container_name)) continue;
      ownershipByContainer.set(row.container_name, {
        deploymentId: row.id,
        userId: row.user_id,
        botName: row.bot_name,
      });
      unresolvedContainerNames.delete(row.container_name);
    }

    const deploymentPrefixes = Array.from(unresolvedContainerNames)
      .map((containerName) => deploymentPrefixFromContainerName(containerName))
      .filter((prefix): prefix is string => Boolean(prefix));

    if (deploymentPrefixes.length) {
      const fallbackRows = await pool.query<{
        id: string;
        user_id: string;
        bot_name: string | null;
      }>(
        `SELECT id, user_id, bot_name
         FROM deployments
         WHERE lower(left(id, 10)) = ANY($1::text[])
         ORDER BY updated_at DESC`,
        [deploymentPrefixes],
      );

      const fallbackByPrefix = new Map<
        string,
        { deploymentId: string; userId: string; botName: string | null }
      >();
      for (const row of fallbackRows.rows) {
        const prefix = row.id.slice(0, 10).toLowerCase();
        if (fallbackByPrefix.has(prefix)) continue;
        fallbackByPrefix.set(prefix, {
          deploymentId: row.id,
          userId: row.user_id,
          botName: row.bot_name,
        });
      }

      for (const containerName of unresolvedContainerNames) {
        const prefix = deploymentPrefixFromContainerName(containerName);
        if (!prefix) continue;
        const fallbackOwner = fallbackByPrefix.get(prefix);
        if (!fallbackOwner) continue;
        ownershipByContainer.set(containerName, fallbackOwner);
      }
    }
  }

  const hostsWithOwnership = overview.map((hostOverview) => ({
    ...hostOverview,
    containers: hostOverview.containers.map((container) => {
      const owner = ownershipByContainer.get(container.name);
      return {
        ...container,
        ownerUserId: owner?.userId ?? null,
        ownerBotName: owner?.botName ?? null,
        ownerDeploymentId: owner?.deploymentId ?? null,
      };
    }),
  }));

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    hostPoolConfigured: hosts.length > 0,
    deployProvider: (process.env.DEPLOY_PROVIDER ?? "").trim() || "mock",
    hosts: hostsWithOwnership,
    subsidyUsage,
    recentDeployments: recentDeployments.rows,
  });
}
