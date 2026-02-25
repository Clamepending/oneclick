import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin/access";
import { deleteContainerOnHost } from "@/lib/admin/vmOverview";
import { ensureSchema, pool } from "@/lib/db";
import { listHosts } from "@/lib/provisioner/hostScheduler";

type DeleteContainerRequest = {
  dockerHost?: unknown;
  containerName?: unknown;
  ownerDeploymentId?: unknown;
};

export async function POST(request: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdminEmail(email)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as DeleteContainerRequest | null;
  const dockerHost = typeof body?.dockerHost === "string" ? body.dockerHost.trim() : "";
  const containerName = typeof body?.containerName === "string" ? body.containerName.trim() : "";
  const ownerDeploymentId =
    typeof body?.ownerDeploymentId === "string" ? body.ownerDeploymentId.trim() : "";

  if (!dockerHost || !containerName) {
    return NextResponse.json(
      { ok: false, error: "dockerHost and containerName are required." },
      { status: 400 },
    );
  }

  const host = listHosts().find((item) => item.dockerHost === dockerHost);
  if (!host) {
    return NextResponse.json({ ok: false, error: "Unknown host." }, { status: 404 });
  }

  try {
    await deleteContainerOnHost(host, containerName);

    if (ownerDeploymentId) {
      await ensureSchema();
      const adminMessage = "Runtime deleted by admin from the admin dashboard.";
      await pool.query(
        `UPDATE deployments
         SET status = 'stopped',
             runtime_id = NULL,
             ready_url = NULL,
             error = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [adminMessage, ownerDeploymentId],
      );
      await pool.query(
        `INSERT INTO deployment_events (deployment_id, status, message)
         VALUES ($1, 'stopped', $2)`,
        [ownerDeploymentId, adminMessage],
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete container";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
