#!/usr/bin/env node
/**
 * Generate the public MCP Firewall Conformance & Adversarial Report from
 * measured artifacts. Exits 1 on any truth-model violation.
 *
 * Inputs (all read from the repository — nothing hand-typed):
 *   - package.json + package-metadata.json
 *   - baseline + corpus files (hashes computed here)
 *   - evals/results/structural-escape-metrics.json
 *   - evals/protocol/mcp-protocol-matrix.json
 *   - evals/fail-closed/fail-closed-matrix.json
 *   - evals/evidence/information-flow-results.json
 *   - evals/evidence/commit-time-authority-results.json
 *   - evals/results/perf-measurements.json
 *
 * Env: GITHUB_SHA or WASMAGENT_TESTED_SHA overrides the tested commit
 * (otherwise `git rev-parse HEAD`).
 *
 * Outputs:
 *   - packages/mcp-firewall/evals/report/mcp-firewall-conformance-report.json
 *   - docs/security/MCP_FIREWALL_CONFORMANCE_ADVERSARIAL_REPORT.md
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConformanceReport, renderReportMarkdown } from "./conformance-report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "../..");
const repoRoot = join(pkgDir, "../..");

const read = (p) => readFileSync(join(repoRoot, p));

function testedSha() {
  return (
    process.env.GITHUB_SHA ??
    process.env.WASMAGENT_TESTED_SHA ??
    execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim()
  );
}

const pkg = JSON.parse(read("packages/mcp-firewall/package.json"));
const metadata = JSON.parse(read("packages/mcp-firewall/package-metadata.json"));
const baseline = JSON.parse(
  read("packages/mcp-firewall/evals/baseline/mcp-firewall-baseline-v1.json")
);
const protocolMatrix = JSON.parse(
  read("packages/mcp-firewall/evals/protocol/mcp-protocol-matrix.json")
);
const failClosedMatrix = JSON.parse(
  read("packages/mcp-firewall/evals/fail-closed/fail-closed-matrix.json")
);
const informationFlow = JSON.parse(
  read("packages/mcp-firewall/evals/evidence/information-flow-results.json")
);
const commitTime = JSON.parse(
  read("packages/mcp-firewall/evals/evidence/commit-time-authority-results.json")
);

// Escape metrics: prefer the live run artifact; a fresh checkout (CI) falls
// back to the frozen committed baseline f2_metrics, with explicit provenance.
const metricsPath = "packages/mcp-firewall/evals/results/structural-escape-metrics.json";
let escapeMetrics;
let escapeProvenance;
if (existsSync(join(repoRoot, metricsPath))) {
  escapeMetrics = JSON.parse(read(metricsPath));
  escapeProvenance = "live-run";
} else {
  const f2 = baseline.f2_metrics;
  escapeMetrics = {
    format: "wasmagent-mcp-firewall-escape-metrics/v1 (derived)",
    scenario_counts: {
      text_scenarios: f2.text_scenarios,
      structural_scenarios: f2.structural_scenarios,
      combined_scenarios: f2.combined_scenarios,
    },
    text_mutation_escape_rate: f2.text_mutation_escape_rate,
    structural_mutation_escape_rate: f2.structural_mutation_escape_rate,
    combined_escape_rate: f2.combined_escape_rate,
    escapes: [],
  };
  escapeProvenance = "frozen-baseline";
}

// Perf is produced by the manual harness — optional everywhere.
const perfPath = "packages/mcp-firewall/evals/results/perf-measurements.json";
const perf = existsSync(join(repoRoot, perfPath)) ? JSON.parse(read(perfPath)) : null;

const corpusFiles = {
  train: read("packages/mcp-firewall/evals/corpus/train.jsonl"),
  dev: read("packages/mcp-firewall/evals/corpus/dev.jsonl"),
  holdout: read("packages/mcp-firewall/evals/corpus/holdout.jsonl"),
  redteam: read("packages/mcp-firewall/evals/corpus/redteam.jsonl"),
  external: read("packages/mcp-firewall/evals/corpus/external.jsonl"),
};

const report = buildConformanceReport({
  repository: "WasmAgent/wasmagent-js",
  testedSha: testedSha(),
  generatedAtUtc: new Date().toISOString(),
  packageVersion: pkg.version,
  metadata,
  baseline,
  baselineBytes: read("packages/mcp-firewall/evals/baseline/mcp-firewall-baseline-v1.json"),
  corpusFiles,
  escapeMetrics,
  escapeProvenance,
  protocolMatrix,
  failClosedMatrix,
  informationFlow,
  commitTime,
  perf,
});

const jsonPath = join(pkgDir, "evals/report/mcp-firewall-conformance-report.json");
const mdPath = join(repoRoot, "docs/security/MCP_FIREWALL_CONFORMANCE_ADVERSARIAL_REPORT.md");

if (process.argv.includes("--check")) {
  // Validation-only mode for CI: re-derive the report and verify the frozen
  // JSON twin still passes the truth model. Never rewrites files.
  const frozen = JSON.parse(readFileSync(jsonPath, "utf8"));
  const { validateTruthModel } = await import("./conformance-report.mjs");
  validateTruthModel(frozen);
  process.stdout.write("conformance report: truth model OK (check mode, nothing written)\n");
  process.exit(0);
}

writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(mdPath, `${renderReportMarkdown(report)}\n`);
process.stdout.write(`wrote ${jsonPath}\nwrote ${mdPath}\n`);
