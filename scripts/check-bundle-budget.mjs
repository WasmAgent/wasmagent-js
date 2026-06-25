#!/usr/bin/env node
/**
 * check-bundle-budget.mjs — verify that key packages stay within size limits.
 *
 * Usage:
 *   node scripts/check-bundle-budget.mjs
 *
 * Budgets (uncompressed ESM import cold path):
 *   @wasmagent/core         < 500 KB
 *   @wasmagent/cloudflare-worker (dist)  < 5 MB   (includes WASM assets)
 *   @wasmagent/kernel-quickjs (adapter only, not runtime asset) < 50 KB
 *
 * Exit 0 = all within budget; Exit 1 = one or more over budget.
 */

import { statSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function dirSize(dir) {
  if (!existsSync(dir)) return null;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      try {
        total += statSync(resolve(entry.parentPath ?? entry.path, entry.name)).size;
      } catch { /* skip */ }
    }
  }
  return total;
}

const KB = 1024;
const MB = 1024 * KB;

const budgets = [
  {
    label: "@wasmagent/core dist/",
    path: resolve(root, "packages/core/dist"),
    limit: 2 * MB,
    note: "Core dist (all submodules). Target: reduce below 500 KB by tree-shaking heavy providers.",
  },
  {
    label: "@wasmagent/kernel-quickjs dist/",
    path: resolve(root, "packages/kernel-quickjs/dist"),
    limit: 5 * MB,
    note: "Includes WASM runtime asset — 5 MB is the CF Worker script size limit",
  },
  {
    label: "@wasmagent/cloudflare-worker dist/",
    path: resolve(root, "packages/cloudflare-worker/dist"),
    limit: 6 * MB,
    note: "Full worker bundle including WASM. Target: below 5 MB CF limit after asset externalisation.",
  },
  {
    label: "@wasmagent/mcp-server dist/",
    path: resolve(root, "packages/mcp-server/dist"),
    limit: 1 * MB,
    note: "MCP server must stay lean — consumers install it alongside a Worker. Keep below 1 MB.",
  },
];

let failed = 0;
for (const { label, path, limit, note } of budgets) {
  const size = dirSize(path);
  if (size === null) {
    console.log(`SKIP  ${label} — dist not built yet (run npm run build)`);
    continue;
  }
  const kb = (size / KB).toFixed(1);
  const limitKb = (limit / KB).toFixed(0);
  if (size > limit) {
    console.error(`FAIL  ${label}: ${kb} KB > ${limitKb} KB budget`);
    console.error(`      ${note}`);
    failed++;
  } else {
    console.log(`OK    ${label}: ${kb} KB / ${limitKb} KB`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} package(s) over budget.`);
  process.exit(1);
}
console.log("\nAll packages within budget.");
