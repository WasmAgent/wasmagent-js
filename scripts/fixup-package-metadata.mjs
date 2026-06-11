#!/usr/bin/env node
/**
 * Add npm-publish metadata to every package under packages/* in a repeatable way.
 *
 * Adds: repository (with directory), homepage, license (where missing),
 *       publishConfig (when public), files (when missing), engines (when missing),
 *       keywords (when missing), bugs.
 *
 * Idempotent: rewrite-safe, preserves existing field order as much as
 * possible by inserting new keys before "scripts" or at the end.
 *
 * Usage:
 *   node scripts/fixup-package-metadata.mjs            # apply
 *   node scripts/fixup-package-metadata.mjs --check    # exit 1 if any package would change
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const packagesDir = join(repoRoot, "packages");

const REPO_URL = "https://github.com/telleroutlook/agentkit-js";

const checkOnly = process.argv.includes("--check");

const pkgs = readdirSync(packagesDir).filter((d) => {
  return statSync(join(packagesDir, d)).isDirectory();
});

let changes = 0;
const report = [];

for (const name of pkgs) {
  const pkgDir = join(packagesDir, name);
  const pkgPath = join(pkgDir, "package.json");
  if (!existsSync(pkgPath)) continue;

  const original = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(original);
  const isPrivate = pkg.private === true;
  const before = JSON.stringify(pkg);

  // license — Apache-2.0 unless already set
  if (!pkg.license) {
    pkg.license = "Apache-2.0";
  }

  // repository
  pkg.repository = {
    type: "git",
    url: `git+${REPO_URL}.git`,
    directory: `packages/${name}`,
  };

  // homepage
  pkg.homepage = `${REPO_URL}/tree/main/packages/${name}#readme`;

  // bugs
  pkg.bugs = { url: `${REPO_URL}/issues` };

  // engines
  if (!pkg.engines) {
    pkg.engines = { node: ">=20.0.0" };
  }

  // keywords (only if missing)
  if (!pkg.keywords) {
    pkg.keywords = ["agentkit", "agent", "ai", "llm"];
  }

  // publishConfig — public for non-private packages
  if (!isPrivate) {
    pkg.publishConfig = { access: "public" };
  }

  // files whitelist for the tarball — only if not already set
  if (!isPrivate && !pkg.files) {
    pkg.files = ["dist", "LICENSE", "README.md"];
  }

  // author
  if (!pkg.author) {
    pkg.author = "agentkit-js contributors";
  }

  const after = JSON.stringify(pkg);
  if (before !== after) {
    changes++;
    report.push(`  • ${name}`);
    if (!checkOnly) {
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    }
  }

  // copy LICENSE into each package (idempotent — always overwrite to root copy)
  if (!isPrivate) {
    const rootLicense = join(repoRoot, "LICENSE");
    const pkgLicense = join(pkgDir, "LICENSE");
    if (existsSync(rootLicense)) {
      // Compare to avoid spurious mtime churn
      const rootText = readFileSync(rootLicense, "utf8");
      const pkgText = existsSync(pkgLicense) ? readFileSync(pkgLicense, "utf8") : "";
      if (rootText !== pkgText && !checkOnly) {
        copyFileSync(rootLicense, pkgLicense);
      }
    }
  }
}

if (checkOnly) {
  if (changes > 0) {
    console.error(`✗ ${changes} package(s) need metadata fixup:`);
    console.error(report.join("\n"));
    process.exit(1);
  }
  console.log("✓ all packages have correct metadata");
} else {
  console.log(`✓ updated ${changes} package(s)`);
  if (report.length) console.log(report.join("\n"));
}
