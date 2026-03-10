import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { listServerlessRuntimeTools, setServerlessRuntimeToolPolicy } from "@/lib/runtime/serverlessTools";
import { requireOwnedServerlessDeployment } from "../shared";

const patchSchema = z.object({
  webEnabled: z.boolean().optional(),
  mcpEnabled: z.boolean().optional(),
  shellEnabled: z.boolean().optional(),
  mcpTools: z.record(z.string(), z.boolean()).optional(),
});

function mapCatalogResponse(catalog: Awaited<ReturnType<typeof listServerlessRuntimeTools>>) {
  return {
    ok: true,
    tools: catalog.tools,
    ottoauth: catalog.ottoauth,
    config: {
      webEnabled: catalog.policy.webEnabled,
      mcpEnabled: catalog.policy.mcpEnabled,
      shellEnabled: catalog.policy.shellEnabled,
      mcpTools: catalog.policy.mcpTools,
    },
  };
}

async function resolveAuthorizedDeployment(input: {
  context: { params: Promise<{ id: string }> };
}) {
  const session = await auth();
  const userId = session?.user?.email?.trim();
  if (!userId) {
    return {
      ok: false as const,
      response: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    };
  }

  const { id } = await input.context.params;
  await ensureSchema();

  const access = await requireOwnedServerlessDeployment({ deploymentId: id, userId });
  if (!access.ok) {
    return {
      ok: false as const,
      response: NextResponse.json({ ok: false, error: access.error }, { status: access.status }),
    };
  }

  return {
    ok: true as const,
    deploymentId: id,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authResult = await resolveAuthorizedDeployment({ context });
  if (!authResult.ok) return authResult.response;

  try {
    const catalog = await listServerlessRuntimeTools({ deploymentId: authResult.deploymentId });
    return NextResponse.json(mapCatalogResponse(catalog));
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to load tools." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authResult = await resolveAuthorizedDeployment({ context });
  if (!authResult.ok) return authResult.response;

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  try {
    await setServerlessRuntimeToolPolicy({
      deploymentId: authResult.deploymentId,
      webEnabled: parsed.data.webEnabled,
      mcpEnabled: parsed.data.mcpEnabled,
      shellEnabled: parsed.data.shellEnabled,
      mcpTools: parsed.data.mcpTools,
    });
    const catalog = await listServerlessRuntimeTools({ deploymentId: authResult.deploymentId });
    return NextResponse.json(mapCatalogResponse(catalog));
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to update tools." },
      { status: 500 },
    );
  }
}
