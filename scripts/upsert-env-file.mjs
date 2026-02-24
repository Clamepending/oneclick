#!/usr/bin/env node
import fs from "node:fs";

const [, , targetPath, sourcePath] = process.argv;

if (!targetPath || !sourcePath) {
  console.error("Usage: node scripts/upsert-env-file.mjs <target.env> <source.env>");
  process.exit(1);
}

function parseEnvLines(text) {
  const map = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = rawLine.indexOf("=");
    if (idx <= 0) continue;
    const key = rawLine.slice(0, idx).trim().replace(/^export\s+/, "");
    const value = rawLine.slice(idx + 1);
    if (key) map.set(key, value);
  }
  return map;
}

function shellEscapeValue(raw) {
  if (raw === "") return '""';
  if (/^[A-Za-z0-9_./:@,+-]+$/.test(raw)) return raw;
  return JSON.stringify(raw);
}

const targetText = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
const sourceText = fs.readFileSync(sourcePath, "utf8");
const sourceMap = parseEnvLines(sourceText);
if (sourceMap.size === 0) {
  console.error(`No env entries found in ${sourcePath}`);
  process.exit(1);
}

const targetLines = targetText.split(/\r?\n/);
const seen = new Set();
const nextLines = targetLines.map((line) => {
  const idx = line.indexOf("=");
  if (idx <= 0) return line;
  const key = line.slice(0, idx).trim().replace(/^export\s+/, "");
  if (!sourceMap.has(key)) return line;
  seen.add(key);
  return `${key}=${shellEscapeValue(String(sourceMap.get(key) ?? ""))}`;
});

if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
  nextLines.push("");
}
nextLines.push("# AWS ECS bootstrap (managed by scripts/upsert-env-file.mjs)");
for (const [key, value] of sourceMap.entries()) {
  if (seen.has(key)) continue;
  nextLines.push(`${key}=${shellEscapeValue(String(value))}`);
}
nextLines.push("");

fs.writeFileSync(targetPath, nextLines.join("\n"));
console.log(`Updated ${targetPath} with ${sourceMap.size} keys from ${sourcePath}`);
