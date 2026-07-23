#!/usr/bin/env node
/**
 * check-version-coherence.mjs
 *
 * Validates version consistency across the monorepo:
 *
 *   1. The four core packages must all share the same version:
 *      @wasmagent/{core, aep, mcp-firewall, compliance}
 *
 *   2. Every dependency that references a @wasmagent/* package must either
 *      use "workspace:*"  OR  specify a semver range satisfied by the
 *      local package's current version.
 *
 * Usage:
 *   node scripts/check-version-coherence.mjs          # CI check
 *   node scripts/check-version-coherence.mjs --verbose # show all checked deps
 *
 * Exit codes: 0 = pass, 1 = violations found.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const packagesDir = join(repoRoot, "packages");
const verbose = process.argv.includes("--verbose");

// ── 1. Build local version map ─────────────────────────────────────────────

const localVersions = new Map(); // pkgName → version

for (const dir of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.name && pkg.version) localVersions.set(pkg.name, pkg.version);
  } catch {
    // skip unreadable / non-JSON
  }
}

// ── 3. Semver-range coherence for all @wasmagent/* deps ───────────────────

/**
 * Minimal semver parser — handles the subset used in this monorepo:
 *   "workspace:*"
 *   "^X.Y.Z"
 *   "~X.Y.Z"
 *   "X.Y.Z"  (exact)
 *   ">=X.Y.Z"
 *   "*"
 *
 * Returns true if `range` is satisfied by `localVersion`.
 */
function semverSatisfied(range, localVersion) {
  if (range === "workspace:*" || range === "*") return true;

  // Parse localVersion into [major, minor, patch, prerelease]
  const localMatch = localVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!localMatch) return false; // non-standard version — skip
  const [, lMaj, lMin, lPat, lPre] = localMatch;
  const local = [Number(lMaj), Number(lMin), Number(lPat), lPre ?? null];

  // Helper: compare two parsed version tuples as numbers
  const cmp = ([aMaj, aMin, aPat], [bMaj, bMin, bPat]) => {
    if (aMaj !== bMaj) return aMaj - bMaj;
    if (aMin !== bMin) return aMin - bMin;
    return aPat - bPat;
  };

  // Parse range
  const exactMatch = range.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (exactMatch) {
    // exact version
    return range === localVersion;
  }

  const caretMatch = range.match(/^\^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (caretMatch) {
    const [, rMaj, rMin, rPat] = caretMatch;
    const req = [Number(rMaj), Number(rMin), Number(rPat)];
    const loc = [local[0], local[1], local[2]];
    // ^1.2.3 matches >=1.2.3 <2.0.0
    if (Number(rMaj) === 0) {
      if (Number(rMin) === 0) {
        // ^0.0.x → only exact patch match
        return loc[0] === 0 && loc[1] === 0 && loc[2] === req[2];
      }
      // ^0.y.z → >=0.y.z <0.(y+1).0
      return (
        loc[0] === 0 && loc[1] === Number(rMin) && cmp(loc, req) >= 0 && loc[1] < Number(rMin) + 1
      );
    }
    // ^x.y.z (x>0) → >=x.y.z <(x+1).0.0
    return local[0] === Number(rMaj) && cmp(loc, req) >= 0;
  }

  const tildeMatch = range.match(/^~(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (tildeMatch) {
    const [, rMaj, rMin, rPat] = tildeMatch;
    const req = [Number(rMaj), Number(rMin), Number(rPat)];
    const loc = [local[0], local[1], local[2]];
    // ~1.2.3 → >=1.2.3 <1.3.0
    return loc[0] === Number(rMaj) && loc[1] === Number(rMin) && cmp(loc, req) >= 0;
  }

  const gteMatch = range.match(/^>=(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (gteMatch) {
    const [, rMaj, rMin, rPat] = gteMatch;
    const req = [Number(rMaj), Number(rMin), Number(rPat)];
    const loc = [local[0], local[1], local[2]];
    return cmp(loc, req) >= 0;
  }

  // Unknown range format — treat as unverifiable (not a violation)
  if (verbose) console.log(`  [skip] unrecognised range format: ${range}`);
  return true;
}

const depViolations = [];
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

for (const dir of readdirSync(packagesDir).sort()) {
  const pkgPath = join(packagesDir, dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    continue;
  }

  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [depName, depRange] of Object.entries(deps)) {
      if (!depName.startsWith("@wasmagent/")) continue;
      const localVer = localVersions.get(depName);
      if (!localVer) continue; // external or missing — skip

      const ok = semverSatisfied(depRange, localVer);
      if (verbose) {
        const mark = ok ? "✓" : "✗";
        console.log(
          `  ${mark} ${pkg.name} ${field}.${depName}: "${depRange}" vs local ${localVer}`
        );
      }
      if (!ok) {
        depViolations.push(
          `${pkg.name ?? dir} → ${depName}: ` +
            `"${depRange}" does not satisfy local version ${localVer}`
        );
      }
    }
  }
}

// ── 4. Report ─────────────────────────────────────────────────────────────

const allViolations = [...depViolations];

if (allViolations.length === 0) {
  console.log(
    `Version coherence check PASSED.\n` +
      `  All @wasmagent/* dependency ranges: satisfied by local versions`
  );
  process.exit(0);
}

console.error(`Version coherence check FAILED — ${allViolations.length} violation(s):\n`);
for (const v of allViolations) {
  console.error(`  • ${v}`);
}
process.exit(1);
