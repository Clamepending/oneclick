#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

const envFile = process.argv[2] ?? ".env";
const target = process.argv[3] ?? "production";
const allowedTargets = new Set(["production", "preview", "development"]);

if (!allowedTargets.has(target)) {
  console.error(
    `Invalid target "${target}". Use one of: production, preview, development.`,
  );
  process.exit(1);
}

const filePath = path.resolve(process.cwd(), envFile);
if (!fs.existsSync(filePath)) {
  console.error(`Env file not found: ${filePath}`);
  process.exit(1);
}

const vercelCheck = spawnSync("vercel", ["--version"], { encoding: "utf8" });
if (vercelCheck.status !== 0) {
  console.error(
    "Vercel CLI is required. Install it with: npm i -g vercel",
  );
  process.exit(1);
}

const parsed = dotenv.parse(fs.readFileSync(filePath));
const keys = Object.keys(parsed);
if (keys.length === 0) {
  console.error(`No variables found in ${envFile}`);
  process.exit(1);
}

console.log(`Importing ${keys.length} vars from ${envFile} -> ${target}`);
console.log("Make sure this repo is linked first: vercel link");

for (const key of keys) {
  const value = parsed[key] ?? "";

  // Remove first to make import idempotent.
  spawnSync("vercel", ["env", "rm", key, target, "--yes"], {
    encoding: "utf8",
    stdio: "ignore",
  });

  // Send raw value and let EOF terminate input. Appending "\n" can store an
  // unintended trailing newline in Vercel for single-line secrets/settings.
  const add = spawnSync("vercel", ["env", "add", key, target], {
    input: value,
    encoding: "utf8",
  });

  if (add.status !== 0) {
    console.error(`Failed to import ${key} -> ${target}`);
    process.exit(1);
  }

  console.log(`Imported ${key}`);
}

console.log(`Done. Imported ${keys.length} vars to ${target}.`);
