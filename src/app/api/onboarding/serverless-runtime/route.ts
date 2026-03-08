import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { resolveRuntimeMetadataForNewDeployment } from "@/lib/runtime/runtimeVersionRegistry";

type StableRuntimeArtifactRow = {
  artifact_ref: string | null;
};

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function normalizeHttpUrl(raw: string | null | undefined) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function resolveSimpleagentSourceUrl(artifactRef: string | null) {
  const explicitArtifactUrl = normalizeHttpUrl(artifactRef);
  if (explicitArtifactUrl) {
    return explicitArtifactUrl;
  }

  const defaultRepo = "https://github.com/Clamepending/simpleagent";
  const configuredRepo = normalizeHttpUrl(readTrimmedEnv("SIMPLE_AGENT_SOURCE_REPO_URL")) || defaultRepo;
  return configuredRepo.replace(/\/+$/, "");
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    await ensureSchema();
    const runtimeMetadata = await resolveRuntimeMetadataForNewDeployment({
      deploymentFlavor: "simple_agent_free",
    });

    const runtimeArtifact = await pool.query<StableRuntimeArtifactRow>(
      `SELECT artifact_ref
       FROM runtime_versions
       WHERE runtime_kind = $1
         AND status = 'stable'
       ORDER BY COALESCE(promoted_at, created_at) DESC, created_at DESC
       LIMIT 1`,
      [runtimeMetadata.runtimeKind],
    );
    const artifactRef = runtimeArtifact.rows[0]?.artifact_ref ?? null;

    return NextResponse.json(
      {
        ok: true,
        runtimeKind: runtimeMetadata.runtimeKind,
        runtimeVersion: runtimeMetadata.runtimeVersion,
        runtimeReleaseChannel: runtimeMetadata.runtimeReleaseChannel,
        sourceUrl: resolveSimpleagentSourceUrl(artifactRef),
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve serverless runtime metadata";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
