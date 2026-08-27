#!/usr/bin/env node
/**
 * check-upstream-pr-status.mjs — validate that the canonical upstream
 * tracking table (docs/distribution/upstream-prs.md) covers every draft
 * document in docs/strategy/upstream-prs/ (#247).
 *
 * Rules:
 *  - every *.md file in docs/strategy/upstream-prs/ must be referenced by
 *    name in a "Draft doc" cell of the canonical table, OR appear in the
 *    `internal-docs` allowlist comment in that file;
 *  - every draft-doc reference must resolve to a real file (no dead rows).
 *
 * Exit 0 = coverage complete. Exit 1 = missing/dead references listed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const draftDir = join(ROOT, "docs", "strategy", "upstream-prs");
const tableFile = join(ROOT, "docs", "distribution", "upstream-prs.md");

const table = readFileSync(tableFile, "utf8");

const allowlistMatch = /<!--\s*internal-docs:\s*([^>]*?)-->/.exec(table);
const allowlisted = new Set(
  allowlistMatch
    ? allowlistMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : []
);

const referenced = new Set();
const rowRegex = /^\s*\|[^|]*\|\s*`?([^|`]*?\.md)`?\s*\|/gm;
for (const match of table.matchAll(rowRegex)) {
  const name = match[1].trim();
  if (name) referenced.add(name);
}

const drafts = readdirSync(draftDir).filter((f) => f.endsWith(".md"));

const missing = drafts.filter((f) => !referenced.has(f) && !allowlisted.has(f));
const dead = [...referenced].filter((f) => !drafts.includes(f));

let failed = false;
if (missing.length > 0) {
  console.error("✗ Draft docs with no row in docs/distribution/upstream-prs.md:");
  for (const f of missing) console.error(`  • docs/strategy/upstream-prs/${f}`);
  failed = true;
}
if (dead.length > 0) {
  console.error("✗ Table references draft docs that do not exist:");
  for (const f of dead) console.error(`  • ${f}`);
  failed = true;
}
if (failed) {
  console.error(
    `\nFix: add a row to docs/distribution/upstream-prs.md (Draft doc column), ` +
      `or add the file to the internal-docs allowlist comment if it is not an upstream submission.`
  );
  process.exit(1);
}
console.log(
  `✓ upstream-pr status coverage complete: ${drafts.length} draft files, ` +
    `${referenced.size} referenced, ${allowlisted.size} allowlisted internal docs.`
);
