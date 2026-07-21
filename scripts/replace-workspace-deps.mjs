#!/usr/bin/env node
/**
 * replace-workspace-deps.mjs — rewrite workspace:* dependencies to concrete versions
 * in all non-private packages before publishing to npm.
 *
 * Changeset publish does NOT do this automatically. Without this step, packages
 * arrive on npm with `"@wasmagent/core": "workspace:*"` in their dependencies,
 * which breaks installs in any repo that does not have the wasmagent-js workspace.
 *
 * Usage:
 *   node scripts/replace-workspace-deps.mjs          # rewrite in place
 *   node scripts/replace-workspace-deps.mjs --check  # exit 1 if any workspace:* found
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const packagesDir = join(repoRoot, "packages");
const checkOnly = process.argv.includes("--check");

// Build version map from all packages
const versionMap = new Map();
for (const name of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, name, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.name && pkg.version) versionMap.set(pkg.name, pkg.version);
  } catch {
    /* skip */
  }
}

let violations = 0;
let rewrites = 0;

for (const name of readdirSync(packagesDir).sort()) {
  const pkgDir = join(packagesDir, name);
  if (!statSync(pkgDir).isDirectory()) continue;
  const pkgPath = join(pkgDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    continue;
  }
  if (pkg.private) continue;

  let changed = false;
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    if (!pkg[field]) continue;
    for (const [dep, ver] of Object.entries(pkg[field])) {
      if (typeof ver === "string" && ver.startsWith("workspace:")) {
        const resolved = versionMap.get(dep);
        if (!resolved) {
          console.error(`  ERROR: ${dep} has workspace:* but no version found in packages/`);
          violations++;
          continue;
        }
        const newVer = `^${resolved}`;
        if (checkOnly) {
          console.error(
            `  VIOLATION: ${pkg.name} ${field}.${dep} = "${ver}" (should be "${newVer}")`
          );
          violations++;
        } else {
          pkg[field][dep] = newVer;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`  fixed: ${pkg.name} — workspace:* → concrete versions`);
    rewrites++;
  }
}

if (checkOnly) {
  if (violations > 0) {
    console.error(`\n${violations} workspace:* violation(s) found. Run without --check to fix.`);
    process.exit(1);
  }
  console.log("OK: no workspace:* in public package dependencies.");
} else {
  console.log(`Done: ${rewrites} package(s) rewritten.`);
}
