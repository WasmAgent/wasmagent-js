#!/usr/bin/env node
/**
 * check-stable-api.mjs — extract stable exports from core/src/index.ts
 * and compare against a checked-in snapshot.
 *
 * Usage:
 *   node scripts/check-stable-api.mjs           # compare mode (CI)
 *   node scripts/check-stable-api.mjs --update  # update snapshot
 *
 * Exit 0 = unchanged; Exit 1 = breaking removal detected.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const indexPath = resolve(root, "packages/core/src/index.ts");
const snapshotPath = resolve(root, "docs/api/stable-api-snapshot.json");
const update = process.argv.includes("--update");

const src = readFileSync(indexPath, "utf8");
const lines = src.split("\n");

// --- Tier detection ---
// Track the current stability tier from section comments like:
//   // Agents [stable]
//   // Enhancement runners [beta]
//   // Evals [beta]
// A line with [stable] sets tier=stable, [beta]/[experimental] sets tier=other.
// Tier persists until changed by a new tier comment.

let tier = "unknown";
const stableExports = new Set();

let inExportBlock = false;
let isTypeExport = false;
let braceDepth = 0;
let blockTier = "unknown";

for (const line of lines) {
  // Detect tier-switching comments
  if (/\/\/.*\[stable\]/.test(line)) {
    tier = "stable";
    continue;
  }
  if (/\/\/.*\[(beta|experimental)\]/.test(line)) {
    tier = "other";
    continue;
  }

  // Start of export block
  if (!inExportBlock && /^\s*export\s+(type\s+)?\{/.test(line)) {
    inExportBlock = true;
    isTypeExport = /^\s*export\s+type\s+\{/.test(line);
    blockTier = tier;
    braceDepth = 0;
  }

  if (inExportBlock) {
    braceDepth += (line.match(/\{/g) ?? []).length;
    braceDepth -= (line.match(/\}/g) ?? []).length;

    // Extract all identifiers inside the block (words followed by optional " as alias" or comma/newline)
    // Match: identifier possibly followed by " as alias"
    const matches = line.matchAll(
      /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b(?:\s+as\s+\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b)?/g
    );
    for (const m of matches) {
      const ident = m[2] ?? m[1]; // use alias if present
      // Skip keywords and structural tokens
      if (["export", "type", "from", "as", "default"].includes(ident)) continue;
      if (blockTier === "stable") {
        stableExports.add(ident);
      }
    }

    if (braceDepth <= 0) {
      inExportBlock = false;
      // Remove "from" and the module path string that got captured
      // Clean up: remove non-identifier tokens that slipped through
    }
  }
}

// Post-filter: remove string-like artifacts (paths contain slashes or dots caught as segments)
const filtered = [...stableExports]
  .filter((id) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(id))
  .filter((id) => !["from", "export", "type", "as", "default", "js"].includes(id))
  .sort();

const currentSnapshot = { count: filtered.length, exports: filtered };

if (update) {
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(currentSnapshot, null, 2) + "\n");
  console.log(`Updated stable API snapshot: ${filtered.length} identifiers`);
  process.exit(0);
}

if (!existsSync(snapshotPath)) {
  console.error("Snapshot not found. Run: node scripts/check-stable-api.mjs --update");
  process.exit(1);
}

const saved = JSON.parse(readFileSync(snapshotPath, "utf8"));
const prev = new Set(saved.exports);
const curr = new Set(filtered);

const added = filtered.filter((x) => !prev.has(x));
const removed = [...prev].filter((x) => !curr.has(x));

if (added.length > 0) console.log(`Stable API additions (${added.length}): ${added.join(", ")}`);
if (removed.length > 0) {
  console.error(`BREAKING: ${removed.length} stable exports removed: ${removed.join(", ")}`);
  console.error("If intentional, run: node scripts/check-stable-api.mjs --update");
  process.exit(1);
}

if (added.length > 0) {
  writeFileSync(snapshotPath, JSON.stringify(currentSnapshot, null, 2) + "\n");
  console.log("Snapshot updated with new additions.");
}
console.log(`Stable API unchanged (${filtered.length} identifiers).`);
process.exit(0);
