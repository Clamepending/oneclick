import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin/access";
import { fetchSubsidyUsageOverview } from "@/lib/admin/subsidyUsage";
import { fetchHostOverview } from "@/lib/admin/vmOverview";
import { ensureSchema, pool } from "@/lib/db";
import { listHosts } from "@/lib/provisioner/hostScheduler";

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
  if (hosts.length === 0) {
    return NextResponse.json({ ok: false, error: "HOST_POOL_JSON is missing or invalid." }, { status: 500 });
  }

  const [overview, subsidyUsage] = await Promise.all([
    Promise.all(hosts.map((host) => fetchHostOverview(host))),
    fetchSubsidyUsageOverview(),
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
    hosts: hostsWithOwnership,
    subsidyUsage,
  });
}
