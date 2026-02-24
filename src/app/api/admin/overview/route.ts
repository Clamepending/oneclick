import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin/access";
import { fetchHostOverview } from "@/lib/admin/vmOverview";
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

  const hosts = listHosts();
  if (hosts.length === 0) {
    return NextResponse.json({ ok: false, error: "HOST_POOL_JSON is missing or invalid." }, { status: 500 });
  }

  const overview = await Promise.all(hosts.map((host) => fetchHostOverview(host)));
  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    hosts: overview,
  });
}
