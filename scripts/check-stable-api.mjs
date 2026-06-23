#!/usr/bin/env node
/**
 * check-stable-api.mjs — extract [stable]-tagged exports from core/src/index.ts
 * and compare against a checked-in snapshot (docs/api/stable-api-snapshot.txt).
 *
 * Usage:
 *   node scripts/check-stable-api.mjs           # compare mode (CI)
 *   node scripts/check-stable-api.mjs --update  # update snapshot
 *
 * Exit 0 = no diff; Exit 1 = stable API changed without snapshot update.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const indexPath = resolve(root, "packages/core/src/index.ts");
const snapshotPath = resolve(root, "docs/api/stable-api-snapshot.txt");
const update = process.argv.includes("--update");

const src = readFileSync(indexPath, "utf8");

// Extract all export blocks that follow a [stable] comment.
// We collect the identifiers listed in each export { ... } block.
const stableExports = [];
const lines = src.split("\n");
let inStableBlock = false;
let inExportBlock = false;
let depth = 0;

for (const line of lines) {
  if (/\/\/.*\[stable\]/.test(line)) {
    inStableBlock = true;
  }
  if (/\/\/.*\[(beta|experimental)\]/.test(line)) {
    inStableBlock = false;
    inExportBlock = false;
  }
  if (inStableBlock && /^export\s+(type\s+)?\{/.test(line.trim())) {
    inExportBlock = true;
    depth = 0;
  }
  if (inExportBlock) {
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    // Extract identifiers: words not preceded by "type " and not "from"
    const idents = [...line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)]
      .map((m) => m[1])
      .filter((id) => !["export", "type", "from", "as"].includes(id) && !/^[a-z]/.test(id[0]) === false);
    // simpler: grab everything that looks like an exported name
    const named = [...line.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((m) => m[1]);
    stableExports.push(...named);
    if (depth <= 0) {
      inExportBlock = false;
    }
  }
}

const unique = [...new Set(stableExports)].sort();
const snapshot = unique.join("\n") + "\n";

if (update) {
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, snapshot);
  console.log(`Updated stable API snapshot: ${unique.length} identifiers`);
  process.exit(0);
}

if (!existsSync(snapshotPath)) {
  console.error("Snapshot not found. Run with --update to create it.");
  process.exit(1);
}

const existing = readFileSync(snapshotPath, "utf8");
if (existing === snapshot) {
  console.log(`Stable API unchanged (${unique.length} identifiers).`);
  process.exit(0);
}

// Diff
const prev = new Set(existing.trim().split("\n"));
const curr = new Set(unique);
const added = unique.filter((x) => !prev.has(x));
const removed = [...prev].filter((x) => !curr.has(x));

if (added.length > 0) console.log("ADDED (ok):\n " + added.join("\n "));
if (removed.length > 0) {
  console.error("REMOVED from stable API (breaking change!):\n " + removed.join("\n "));
  console.error("\nIf this is intentional, run: node scripts/check-stable-api.mjs --update");
  process.exit(1);
}

// Only additions — update snapshot silently and pass
writeFileSync(snapshotPath, snapshot);
console.log(`Stable API: ${added.length} new identifiers added, snapshot updated.`);
process.exit(0);
