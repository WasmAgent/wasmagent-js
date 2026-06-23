#!/usr/bin/env node
/**
 * check-branding.mjs — ensure no @agentkit-js/* imports or agentkit-js brand
 * strings have crept back into tracked source files.
 *
 * Usage:
 *   node scripts/check-branding.mjs         # CI check (exit 1 on violations)
 *   node scripts/check-branding.mjs --list  # print violations and exit 1
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Files/path prefixes that are explicitly allowed to mention these strings.
const ALLOWED_EXACT = new Set([
  "bun.lock",
  "docs/migration-from-agentkit.md",
  // This script itself contains the patterns as regex literals — self-referential.
  "scripts/check-branding.mjs",
  // Integration test that guards against the old import — mentions by design.
  "tests/integration/agent-pipeline.test.ts",
]);

// Path prefixes — any file under these paths is allowed.
const ALLOWED_PREFIXES = [
  // Historical changelogs capture old package names verbatim.
  "CHANGELOG.md",
  "packages/",   // per-package CHANGELOG.md files (matched via suffix below)
  "tests/integration/CHANGELOG.md",
];

function isAllowed(file) {
  if (ALLOWED_EXACT.has(file)) return true;
  if (file.endsWith("/CHANGELOG.md") || file === "CHANGELOG.md") return true;
  // Training data JSONL — historical traces may reference old names.
  if (file.startsWith("datasets/") && file.endsWith(".jsonl")) return true;
  return false;
}

// Patterns that must not appear in any non-allowlisted tracked file.
const PATTERNS = [
  { re: /@agentkit-js\//g, label: "@agentkit-js/ import" },
  { re: /\bagentkit-js\b/gi, label: "agentkit-js brand string" },
];

const files = execSync("git ls-files", { encoding: "utf8", cwd: process.cwd() })
  .trim()
  .split("\n")
  .filter(Boolean);

const violations = [];

for (const file of files) {
  if (isAllowed(file)) continue;
  // Skip binary-ish files and dist output.
  if (file.includes("/dist/")) continue;
  if (file.endsWith(".lock") || file.endsWith(".wasm") || file.endsWith(".png")) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // unreadable (binary, etc.)
  }

  for (const { re, label } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) violations.push(`${file}: ${label}`);
  }
}

if (violations.length === 0) {
  console.log("Branding check passed — no @agentkit-js references found.");
  process.exit(0);
}

console.error(
  `Branding check FAILED: ${violations.length} violation(s).\n` +
    `Replace @agentkit-js/* with @wasmagent/* and add to ALLOWED if intentional.\n`
);
for (const v of violations) console.error("  " + v);
process.exit(1);
