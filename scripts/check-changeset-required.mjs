#!/usr/bin/env node
/**
 * check-changeset-required.mjs
 *
 * Fails CI when a commit touches publishable source under
 * packages/<name>/src/ but does not include any .changeset/*.md
 * entry naming a corresponding @wasmagent/<name> package.
 *
 * Without this guard, a PR that changes published-package source can
 * land on main and the Release workflow will silently no-op (no
 * changeset → no version bump → no npm publish). The diff between
 * "I merged my fix" and "users got the fix" then becomes invisible
 * until someone notices their @wasmagent/* version on npm hasn't
 * moved.
 *
 * What counts as "touched":
 *   - Any file under packages/<name>/src/ where <name> resolves to
 *     a package whose package.json is not marked "private": true and
 *     not in .changeset/config.json#ignore.
 *
 * Pure-test changes (*.test.ts, *.spec.ts) are excluded — a test-only
 * change does not need a release.
 *
 * Pure-docs changes (packages/<name>/README.md) ARE flagged, because
 * the README ships with the npm package — readers see whatever is in
 * the published tarball, not whatever is in main.
 *
 * Bypass: set the commit message body to include `[skip changeset]`
 * (case-insensitive). Use sparingly — coordination-only patch bumps
 * still need a changeset to actually publish.
 *
 * Usage:
 *   node scripts/check-changeset-required.mjs                  # check git HEAD vs origin/main
 *   node scripts/check-changeset-required.mjs --base=<sha>     # explicit base
 *   node scripts/check-changeset-required.mjs --files=a.ts,b.ts # bypass git, pass files
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// ── 1. Parse args ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name) {
  const m = args.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : null;
}

const explicitBase = flag("base");
const explicitFiles = flag("files");

// ── 2. Resolve the set of changed files ────────────────────────────────

function gitFiles(base, head = "HEAD") {
  try {
    return execSync(`git diff --name-only ${base}...${head}`, {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch (err) {
    console.error(`git diff failed: ${err.message}`);
    return null;
  }
}

let changedFiles;

if (explicitFiles) {
  changedFiles = explicitFiles.split(",").filter(Boolean);
} else {
  const base = explicitBase || process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF || "main"}`
    : "origin/main";

  // On CI for a PR, GITHUB_BASE_REF is set. On push to main, fall back
  // to the previous commit so we still flag direct pushes that skipped
  // a changeset.
  let resolved = base;
  if (process.env.GITHUB_EVENT_NAME === "push" && !explicitBase) {
    resolved = "HEAD~1";
  }

  changedFiles = gitFiles(resolved);
  if (changedFiles === null) {
    console.log("Cannot resolve git base; skipping changeset check.");
    process.exit(0);
  }
}

// ── 3. Discover publishable packages ───────────────────────────────────

const packagesDir = join(ROOT, "packages");
const publishable = new Map(); // name -> { dir }

for (const dir of readdirSync(packagesDir)) {
  const pkgJsonPath = join(packagesDir, dir, "package.json");
  if (!existsSync(pkgJsonPath)) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch {
    continue;
  }
  if (pkg.private === true) continue;
  if (!pkg.name) continue;
  publishable.set(pkg.name, { dir });
}

// Honour .changeset/config.json ignore list.
const cfgPath = join(ROOT, ".changeset", "config.json");
if (existsSync(cfgPath)) {
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  for (const name of cfg.ignore || []) {
    publishable.delete(name);
  }
}

// ── 4. Find which publishable packages were touched ────────────────────

const touchedPkgs = new Set();
for (const file of changedFiles) {
  const m = file.match(/^packages\/([^/]+)\/(.+)$/);
  if (!m) continue;
  const [, pkgDir, rest] = m;

  // Find the npm name for this directory.
  let pkgName = null;
  for (const [name, info] of publishable) {
    if (info.dir === pkgDir) {
      pkgName = name;
      break;
    }
  }
  if (!pkgName) continue;

  // Filter out test-only and build-artifact paths.
  if (/\.(test|spec)\.[a-z]+$/.test(rest)) continue;
  if (rest.startsWith("dist/") || rest.startsWith(".turbo/")) continue;
  if (rest === "CHANGELOG.md") continue;
  if (rest === "package.json") continue; // version bumps land via changeset itself
  if (rest === "tsconfig.json") continue;

  touchedPkgs.add(pkgName);
}

if (touchedPkgs.size === 0) {
  console.log("✓ No publishable-package source changes detected.");
  process.exit(0);
}

// ── 5. Honour [skip changeset] bypass ─────────────────────────────────

try {
  const lastMsg = execSync("git log -1 --pretty=%B", {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (/\[skip changeset\]/i.test(lastMsg)) {
    console.log("✓ [skip changeset] bypass present in commit message.");
    process.exit(0);
  }
} catch {
  /* ignore */
}

// ── 5b. Skip for Dependabot PRs ─────────────────────────────────────

const prAuthor = process.env.GITHUB_ACTOR ?? "";
if (prAuthor === "dependabot[bot]") {
  console.log("✓ Dependabot PR — changeset not required.");
  process.exit(0);
}

// ── 6. Read .changeset/*.md and confirm at least one names a touched pkg

const changesetDir = join(ROOT, ".changeset");
const namedInChangesets = new Set();

if (existsSync(changesetDir)) {
  for (const f of readdirSync(changesetDir)) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const body = readFileSync(join(changesetDir, f), "utf8");
    const fm = body.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^"(@wasmagent\/[\w-]+)":\s*\w+/);
      if (m) namedInChangesets.add(m[1]);
    }
  }
}

const missing = [...touchedPkgs].filter((p) => !namedInChangesets.has(p));

if (missing.length === 0) {
  console.log(`✓ Changeset present for: ${[...touchedPkgs].join(", ")}`);
  process.exit(0);
}

console.error("✗ Missing changeset for the following packages:");
for (const p of missing) console.error(`    • ${p}`);
console.error("");
console.error("  Why this matters: changes to published-package source");
console.error("  that have no corresponding .changeset/*.md will not");
console.error("  trigger a version bump. The Release workflow will run,");
console.error("  see no changesets, and silently no-op — users on npm");
console.error("  will not receive your fix.");
console.error("");
console.error("  Fix:");
console.error("    bunx changeset      # author one interactively, or");
console.error("    add a file at .changeset/<name>.md whose front-matter");
console.error("    lists the missing package(s) with patch / minor / major.");
console.error("");
console.error("  Bypass for emergencies only:");
console.error("    include '[skip changeset]' in the commit message body.");
process.exit(1);
