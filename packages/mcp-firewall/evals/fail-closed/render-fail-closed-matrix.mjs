#!/usr/bin/env node
/**
 * Render docs/security/mcp-firewall-fail-closed.md from the authoritative
 * JSON matrix (evals/fail-closed/fail-closed-matrix.json).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = join(here, "fail-closed-matrix.json");
const DOC_PATH = join(here, "../../../../docs/security/mcp-firewall-fail-closed.md");

function esc(s) {
  return String(s ?? "").replaceAll("|", "\\|");
}

export function renderMatrix(matrix) {
  const lines = [];
  lines.push("# MCP Firewall — fail-closed behavior matrix");
  lines.push("");
  lines.push(
    `> GENERATED from \`packages/mcp-firewall/evals/fail-closed/fail-closed-matrix.json\` — that JSON file is the authority. Regenerate with \`node packages/mcp-firewall/evals/fail-closed/render-fail-closed-matrix.mjs\`.`
  );
  lines.push("");
  lines.push(`- Repository: \`${matrix.repository}\` at \`${matrix.tested_sha}\``);
  lines.push(`- Evidence anchor: \`${matrix.identity.checkpoint}\``);
  lines.push("");
  lines.push(`**Purpose.** ${matrix.purpose}`);
  lines.push("");
  lines.push(`**Critical invariant.** ${matrix.critical_invariant}`);
  lines.push("");
  lines.push("## Outcome vocabulary");
  lines.push("");
  for (const [k, v] of Object.entries(matrix.outcome_vocabulary)) {
    lines.push(`- **${k}** — ${v}`);
  }
  lines.push("");
  lines.push("## Matrix");
  lines.push("");
  lines.push("| id | condition | outcome | behavior | evidence |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of matrix.rows) {
    lines.push(
      `| ${r.id} | ${esc(r.condition)} | ${r.outcome} | ${esc(r.behavior)} | ${esc(r.test_or_evidence)} |`
    );
  }
  lines.push("");
  const withNotes = matrix.rows.filter((r) => r.notes && r.notes.length > 0);
  if (withNotes.length > 0) {
    lines.push("## Row notes");
    lines.push("");
    for (const r of withNotes) lines.push(`- **${r.id}**: ${r.notes}`);
    lines.push("");
  }
  lines.push("## Invariants");
  lines.push("");
  for (const inv of matrix.invariants) {
    lines.push(`- **${inv.id}** — ${inv.statement} (evidence: \`${inv.test_or_evidence}\`)`);
  }
  lines.push("");
  return lines.join("\n");
}

export function loadMatrix() {
  return JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
}

function main() {
  const matrix = loadMatrix();
  writeFileSync(DOC_PATH, `${renderMatrix(matrix)}\n`);
  process.stdout.write(`wrote ${DOC_PATH}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
