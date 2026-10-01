#!/usr/bin/env node
/**
 * Render docs/security/mcp-protocol-conformance view from the authoritative
 * JSON matrix (evals/protocol/mcp-protocol-matrix.json).
 *
 * The JSON file is the authority; this file is a deterministic, generated
 * readable view. `bun run render:protocol-matrix` regenerates it; the
 * protocol-matrix consistency test fails when the committed view is stale.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = join(here, "mcp-protocol-matrix.json");
const DOC_PATH = join(here, "../../../../docs/security/mcp-firewall-protocol-conformance.md");

const SECTION_TITLES = {
  protocol_revisions: "Protocol revisions",
  transport_framing: "Transport / framing",
  methods: "MCP methods / surfaces",
  firewall_inspection: "Firewall inspection direction",
};

function esc(s) {
  return String(s ?? "").replaceAll("|", "\\|");
}

export function renderMatrix(matrix) {
  const lines = [];
  lines.push("# MCP Protocol Conformance — support matrix view");
  lines.push("");
  lines.push(
    `> GENERATED from \`packages/mcp-firewall/evals/protocol/mcp-protocol-matrix.json\` — that JSON file is the authority. Do not edit this view by hand; run \`node packages/mcp-firewall/evals/protocol/render-protocol-matrix.mjs\` after editing the matrix.`
  );
  lines.push("");
  lines.push(`- Repository: \`${matrix.repository}\``);
  lines.push(`- Tested commit: \`${matrix.tested_sha}\``);
  lines.push(
    `- @wasmagent/mcp-firewall: \`${matrix.identity.mcp_firewall_version}\`, @wasmagent/mcp-server: \`${matrix.identity.mcp_server_version}\``
  );
  lines.push(`- Evidence anchor: \`${matrix.identity.checkpoint}\``);
  lines.push("");
  lines.push("## Status vocabulary (no generic green/red)");
  lines.push("");
  for (const s of matrix.status_vocabulary) {
    lines.push(`- **${s}** — ${matrix.status_definitions[s] ?? ""}`);
  }
  lines.push("");
  for (const [key, title] of Object.entries(SECTION_TITLES)) {
    const rows = matrix.sections[key] ?? [];
    lines.push(`## ${title}`);
    lines.push("");
    lines.push("| id | surface | status | evidence | owner | claim ceiling |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const r of rows) {
      lines.push(
        `| ${r.id} | ${esc(r.name)} | ${r.status} | ${esc(r.test_or_evidence)} | ${esc(r.owner_package)} | ${esc(r.claim_ceiling)} |`
      );
    }
    const withNotes = rows.filter((r) => r.notes && r.notes.length > 0);
    if (withNotes.length > 0) {
      lines.push("");
      for (const r of withNotes) {
        lines.push(`- **${r.id}** notes: ${r.notes}`);
      }
    }
    lines.push("");
  }
  if ((matrix.conformance_gaps ?? []).length > 0) {
    lines.push("## Known conformance gaps (explicit, not hidden)");
    lines.push("");
    for (const g of matrix.conformance_gaps) {
      lines.push(
        `- **${g.id}** (${g.rows.join(", ")}): ${g.description} — disposition: ${g.disposition}`
      );
    }
    lines.push("");
  }
  lines.push("## Claim ceiling");
  lines.push("");
  for (const c of matrix.claim_ceiling_global) {
    lines.push(`- ${c}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function loadMatrix() {
  return JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
}

function main() {
  const matrix = loadMatrix();
  const md = renderMatrix(matrix);
  writeFileSync(DOC_PATH, `${md}\n`);
  process.stdout.write(`wrote ${DOC_PATH}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
