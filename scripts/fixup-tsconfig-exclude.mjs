#!/usr/bin/env node
/**
 * Ensure every package's tsconfig.json excludes *.test.ts so the npm tarball
 * does not ship test files. Idempotent.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const packagesDir = join(repoRoot, "packages");

const TEST_GLOBS = ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"];

let changes = 0;
for (const name of readdirSync(packagesDir)) {
  const dir = join(packagesDir, name);
  if (!statSync(dir).isDirectory()) continue;
  const tsconfigPath = join(dir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) continue;

  const raw = readFileSync(tsconfigPath, "utf8");
  // tsconfig may have comments — strip line comments before parsing
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
  const cfg = JSON.parse(stripped);

  const exclude = new Set(cfg.exclude ?? []);
  exclude.add("dist");
  exclude.add("node_modules");
  for (const g of TEST_GLOBS) exclude.add(g);

  const newExclude = [...exclude].sort();
  const before = JSON.stringify(cfg.exclude);
  const after = JSON.stringify(newExclude);
  if (before === after) continue;

  cfg.exclude = newExclude;
  writeFileSync(tsconfigPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  changes++;
  console.log(`  • ${name}`);
}
console.log(`✓ updated ${changes} tsconfig(s)`);
