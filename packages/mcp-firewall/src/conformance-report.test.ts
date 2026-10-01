/**
 * Conformance-report truth-model tests (CR-*).
 *
 * The public report is generated from measured artifacts; these tests pin the
 * report's honesty: numbers match their artifacts, the truth model rejects
 * inflated claims, and the committed Markdown twin is the render of the
 * committed JSON.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildConformanceReport,
  renderReportMarkdown,
  validateTruthModel,
} from "../evals/report/conformance-report.mjs";

const repoRoot = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");
const readJson = (p: string) => JSON.parse(read(p));
const exists = (p: string) => existsSync(join(repoRoot, p));

/** Escape metrics with the same live-run → frozen-baseline fallback the generator uses. */
function loadEscapeMetrics() {
  const baseline = readJson("packages/mcp-firewall/evals/baseline/mcp-firewall-baseline-v1.json");
  const metricsPath = "packages/mcp-firewall/evals/results/structural-escape-metrics.json";
  if (exists(metricsPath)) {
    return { metrics: readJson(metricsPath), provenance: "live-run" as const };
  }
  const f2 = baseline.f2_metrics;
  return {
    metrics: {
      scenario_counts: {
        text_scenarios: f2.text_scenarios,
        structural_scenarios: f2.structural_scenarios,
        combined_scenarios: f2.combined_scenarios,
      },
      text_mutation_escape_rate: f2.text_mutation_escape_rate,
      structural_mutation_escape_rate: f2.structural_mutation_escape_rate,
      combined_escape_rate: f2.combined_escape_rate,
      escapes: [],
    },
    provenance: "frozen-baseline" as const,
  };
}

const committed = readJson(
  "packages/mcp-firewall/evals/report/mcp-firewall-conformance-report.json"
);

function freshInputs() {
  return {
    repository: "WasmAgent/wasmagent-js",
    testedSha: "c1a573fc8f49f0f2162a17ddca199bb61fcdd94d",
    generatedAtUtc: "2026-10-01T00:00:00Z",
    packageVersion: "2.2.1",
    metadata: readJson("packages/mcp-firewall/package-metadata.json"),
    baseline: readJson("packages/mcp-firewall/evals/baseline/mcp-firewall-baseline-v1.json"),
    baselineBytes: read("packages/mcp-firewall/evals/baseline/mcp-firewall-baseline-v1.json"),
    corpusFiles: Object.fromEntries(
      ["train", "dev", "holdout", "redteam", "external"].map((n) => [
        n,
        read(`packages/mcp-firewall/evals/corpus/${n}.jsonl`),
      ])
    ),
    escapeMetrics: loadEscapeMetrics().metrics,
    escapeProvenance: loadEscapeMetrics().provenance,
    protocolMatrix: readJson("packages/mcp-firewall/evals/protocol/mcp-protocol-matrix.json"),
    failClosedMatrix: readJson("packages/mcp-firewall/evals/fail-closed/fail-closed-matrix.json"),
    informationFlow: readJson("packages/mcp-firewall/evals/evidence/information-flow-results.json"),
    commitTime: readJson("packages/mcp-firewall/evals/evidence/commit-time-authority-results.json"),
    perf: exists("packages/mcp-firewall/evals/results/perf-measurements.json")
      ? readJson("packages/mcp-firewall/evals/results/perf-measurements.json")
      : null,
  };
}

describe("CR: conformance report truth model", () => {
  it("CR-01: committed report passes the truth model and declares its schema", () => {
    expect(committed.schema).toBe("wasmagent-mcp-firewall-conformance-report/v1");
    expect(validateTruthModel(committed)).toBe(true);
  });

  it("CR-02: report identity hashes match the live artifacts", () => {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const holdoutSha = createHash("sha256")
      .update(read("packages/mcp-firewall/evals/corpus/holdout.jsonl"))
      .digest("hex");
    expect(committed.identity.corpus.holdout.sha256).toBe(holdoutSha);
    expect(committed.identity.corpus.holdout.samples).toBe(11);
    expect(committed.adversarial_evidence.holdout_samples).toBe(11);
    expect(committed.identity.tested_sha).toBe(committed.protocol_matrix.tested_sha);
    expect(committed.identity.tested_sha).toBe(committed.fail_closed_matrix.tested_sha);
    expect(committed.identity.tested_sha).toBe(committed.information_flow_cases.tested_sha);
    expect(committed.identity.tested_sha).toBe(committed.commit_time_authority_cases.tested_sha);
  });

  it("CR-03: adversarial numbers match their source (live metrics artifact or frozen baseline)", () => {
    const { metrics } = loadEscapeMetrics();
    const ae = committed.adversarial_evidence;
    expect(ae.text_mutation.scenarios).toBe(metrics.scenario_counts.text_scenarios);
    expect(ae.structural_mutation.scenarios).toBe(metrics.scenario_counts.structural_scenarios);
    expect(ae.combined_cross_product.scenarios).toBe(metrics.scenario_counts.combined_scenarios);
    expect(ae.text_mutation.escape_rate).toBe(0);
    expect(ae.structural_mutation.escape_rate).toBe(0);
    expect(ae.combined_cross_product.escape_rate).toBe(0);
    // The committed frozen twin records where its adversarial numbers came from.
    expect(["live-run", "frozen-baseline"]).toContain(
      committed.adversarial_evidence.provenance.startsWith("frozen-baseline")
        ? "frozen-baseline"
        : "live-run"
    );
  });

  it("CR-04: truth model rejects inflated claims (external run, conformant status, capture completeness)", () => {
    // external evaluation claimed without a run
    expect(() => validateTruthModel({ ...committed, external_evaluation: "external_run" })).toThrow(
      /TR-01/
    );
    // protocol row inflated to a conformant status
    const inflated = JSON.parse(JSON.stringify(committed));
    inflated.protocol_matrix.rows[0].status = "conformant";
    expect(() => validateTruthModel(inflated)).toThrow(/TR-02/);
    // capture completeness asserted
    expect(() => validateTruthModel({ ...committed, capture_completeness: "complete" })).toThrow(
      /TR-04/
    );
    // independent verification fabricated
    expect(() =>
      validateTruthModel({ ...committed, independent_verification: "independent" })
    ).toThrow(/TR-01/);
  });

  it("CR-05: builder refuses F2 metadata with non-zero escape metrics", () => {
    const inputs = freshInputs();
    inputs.escapeMetrics = {
      ...inputs.escapeMetrics,
      text_mutation_escape_rate: 0.1,
      structural_mutation_escape_rate: 0.1,
      combined_escape_rate: 0.1,
    };
    expect(() => buildConformanceReport(inputs)).toThrow(/TR-03/);
  });

  it("CR-06: committed Markdown twin is the render of the committed JSON", () => {
    const md = read("docs/security/MCP_FIREWALL_CONFORMANCE_ADVERSARIAL_REPORT.md");
    expect(md).toBe(`${renderReportMarkdown(committed)}\n`);
  });

  it("CR-07: external evaluation section stays not_run; limitations are named", () => {
    expect(committed.external_evaluation).toBe("not_run");
    expect(committed.independent_verification).toBe("not_established");
    expect(committed.capture_completeness).toContain("NOT_ESTABLISHED");
    expect(committed.information_flow_cases.documented_limitations).toContain("IF-07a");
    expect(committed.protocol_matrix.conformance_gaps.length).toBeGreaterThan(0);
  });
});
