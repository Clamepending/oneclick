#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const candidateInputPaths = [
  process.env.SIMPLEAGENT_APP_PY_PATH ? path.resolve(process.env.SIMPLEAGENT_APP_PY_PATH) : null,
  path.resolve(repoRoot, "..", "oneclickstack", "simpleagent", "app.py"),
  path.resolve(repoRoot, "..", "simpleagent", "app.py"),
  path.resolve(repoRoot, "..", "..", "oneclickstack", "simpleagent", "app.py"),
].filter(Boolean);

async function firstExistingPath(paths) {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

const inputPath = await firstExistingPath(candidateInputPaths);
const outputPath = path.resolve(repoRoot, "src", "lib", "runtime", "simpleagent-ui-template.html");

async function main() {
  if (!inputPath) {
    console.error("[sync-simpleagent-ui] Could not locate simpleagent/app.py.");
    console.error(
      `[sync-simpleagent-ui] Tried:\\n${candidateInputPaths.map((item) => `- ${item}`).join("\\n")}`,
    );
    process.exit(1);
  }
  const source = await fs.readFile(inputPath, "utf8");

  const match = source.match(
    /@app\.route\("\/", methods=\["GET"\]\)\n\s*def index\(\):\n\s*return """([\s\S]*?)"""\n\n\s*def _queue_policy_snapshot/,
  );
  if (!match?.[1]) {
    console.error("[sync-simpleagent-ui] Failed to locate root HTML template block in app.py");
    process.exit(1);
  }

  const html = match[1];
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html, "utf8");
  console.log(`[sync-simpleagent-ui] Source: ${inputPath}`);
  console.log(`[sync-simpleagent-ui] Wrote ${outputPath} (${html.length} chars)`);
}

await main();
