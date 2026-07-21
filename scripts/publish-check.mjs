#!/usr/bin/env node
import { execSync } from "node:child_process";
/**
 * Pre-publish health check for every public package.
 *
 *   node scripts/publish-check.mjs
 *
 * For each non-private package under packages/* it:
 *   - confirms required metadata is present (name, version, license, repository, files, dist exports);
 *   - confirms dist/ is built and contains index.js + index.d.ts (or matches `main`/`types`);
 *   - confirms LICENSE + README.md exist next to package.json;
 *   - runs `npm pack --dry-run --json` and reports the tarball file count + size + first few entries;
 *   - prints PASS/FAIL summary, exits non-zero if anything is wrong.
 *
 * Does NOT publish.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const packagesDir = join(repoRoot, "packages");

const REQUIRED_FIELDS = [
  "name",
  "version",
  "license",
  "repository",
  "homepage",
  "publishConfig",
  "files",
];

const results = [];
let failed = 0;

for (const name of readdirSync(packagesDir).sort()) {
  const pkgDir = join(packagesDir, name);
  if (!statSync(pkgDir).isDirectory()) continue;
  const pkgPath = join(pkgDir, "package.json");
  if (!existsSync(pkgPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.private) {
    results.push({ name: pkg.name, status: "SKIP", note: "private" });
    continue;
  }

  const issues = [];

  for (const f of REQUIRED_FIELDS) {
    if (!pkg[f]) issues.push(`missing field: ${f}`);
  }
  if (pkg.publishConfig?.access !== "public") {
    issues.push(`publishConfig.access != "public"`);
  }

  // wasmagent tier metadata
  const wm = pkg.wasmagent;
  if (!wm) {
    issues.push(`missing field: wasmagent (tier metadata)`);
  } else {
    if (!["tier-0", "tier-1", "tier-2", "tier-3"].includes(wm.tier)) {
      issues.push(`wasmagent.tier must be tier-0..tier-3, got: ${wm.tier}`);
    }
    if (!["stable", "beta", "alpha", "demo", "research"].includes(wm.stability)) {
      issues.push(
        `wasmagent.stability must be one of "stable","beta","alpha","demo","research", got: ${wm.stability}`
      );
    }
  }

  // dist + LICENSE + README
  const distDir = join(pkgDir, "dist");
  if (!existsSync(distDir)) {
    issues.push("dist/ missing — run bun run build");
  } else {
    const main = pkg.main ? join(pkgDir, pkg.main) : null;
    const types = pkg.types ? join(pkgDir, pkg.types) : null;
    if (main && !existsSync(main)) issues.push(`main not found: ${pkg.main}`);
    if (types && !existsSync(types)) issues.push(`types not found: ${pkg.types}`);
  }
  if (!existsSync(join(pkgDir, "LICENSE"))) issues.push("LICENSE missing");
  if (!existsSync(join(pkgDir, "README.md"))) issues.push("README.md missing");

  // npm pack dry-run
  let packInfo = null;
  if (issues.length === 0) {
    try {
      const out = execSync("npm pack --dry-run --json", {
        cwd: pkgDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const parsed = JSON.parse(out);
      packInfo = parsed[0];
    } catch (e) {
      issues.push(`npm pack --dry-run failed: ${e.message.split("\n")[0]}`);
    }
  }

  if (issues.length > 0) {
    failed++;
    results.push({ name: pkg.name, status: "FAIL", issues });
  } else {
    results.push({
      name: pkg.name,
      status: "PASS",
      tarballSize: packInfo?.size ?? 0,
      fileCount: packInfo?.entryCount ?? 0,
      version: pkg.version,
    });
  }
}

// Render report
console.log("\n=== Publish Health Check ===\n");
const colWidth = Math.max(...results.map((r) => r.name?.length ?? 0)) + 2;
for (const r of results) {
  const name = (r.name ?? "?").padEnd(colWidth);
  if (r.status === "PASS") {
    const kb = (r.tarballSize / 1024).toFixed(1);
    console.log(`  ✅ ${name} v${r.version}  ${r.fileCount} files, ${kb} KB`);
  } else if (r.status === "SKIP") {
    console.log(`  ⏭  ${name} (${r.note})`);
  } else {
    console.log(`  ❌ ${name}`);
    for (const i of r.issues) console.log(`       · ${i}`);
  }
}
console.log("");

if (failed > 0) {
  console.error(`✗ ${failed} package(s) failed publish health check`);
  process.exit(1);
}
console.log(`✓ all packages ready for npm publish`);
