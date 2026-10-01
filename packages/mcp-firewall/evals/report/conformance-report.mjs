/**
 * MCP Firewall Conformance & Adversarial Report — builder + truth-model.
 *
 * Pure module: `buildConformanceReport(inputs)` assembles the report STRICTLY
 * from measured artifacts (protocol matrix, escape metrics, corpus files,
 * information-flow / commit-time results, perf measurements). Every positive
 * number must come from a file. The truth model (`validateTruthModel`)
 * rejects reports that would claim more than the artifacts support:
 *   TR-01  external evaluation may only be "not_run" until a real run exists
 *   TR-02  no row may claim MCP "conformant" status (vocabulary does not have it)
 *   TR-03  adversarial zero-escape claims must match the escape-metrics artifact
 *   TR-04  capture completeness may never be asserted
 *   TR-05  the declared phase must match package-metadata.json
 */

import { createHash } from "node:crypto";

export function sha256File(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireSource(label, value) {
  if (value === undefined || value === null) {
    throw new Error(`conformance report: missing measured source: ${label}`);
  }
  return value;
}

const CLAIM_CEILING = [
  "Project-owned evaluation at a single tested commit — NOT independent certification.",
  "Semantic detection is defence-in-depth, not the root of trust; detector bypass does not imply an unsafe effect, and detection completeness is not claimed.",
  "The firewall is not an OS/kernel sandbox: physical capability enforcement belongs to the runtime/sandbox layer.",
  "DNS rebinding / post-resolution enforcement belongs to runtime network enforcement, not to this package.",
  "Canonical-path/symlink enforcement belongs to the runtime/sandbox layer; firewall path classification is lexical.",
  "Unsupported MCP surfaces (resources/*, prompts/*, notifications/cancelled, server-side SSE) remain unsupported.",
  "F2 zero-escape results apply ONLY to the frozen declared corpus and mutator set at the tested commit.",
  "No claim of exhaustive adversarial completeness; the adaptive/external red-team evaluation has not been run.",
  "The information-flow fixtures demonstrate per-call authority and structural boundaries; IF-07a is a documented limitation (value transformation defeats value-shape detection), not a containment pass.",
];

export function buildConformanceReport(inputs) {
  const {
    repository,
    testedSha,
    generatedAtUtc,
    packageVersion,
    metadata,
    baseline,
    corpusFiles, // { name -> bytes } for the five splits
    escapeMetrics,
    escapeProvenance, // "live-run" | "frozen-baseline"
    protocolMatrix,
    failClosedMatrix,
    informationFlow,
    commitTime,
    perf, // optional — absent when measurements have not been produced in this checkout
  } = inputs;

  // ── TR-05: phase identity must come from metadata ──────────────────────────
  const phase = requireSource("package-metadata phase", metadata?.phase);
  const adversarialStatus = requireSource(
    "metadata adversarial_evaluation",
    metadata?.adversarial_evaluation
  );
  // Metadata carries the non-claims in phase_note prose; the machine contract
  // is: an explicit true/ran value requires a real run record, absence means
  // not_run (the documented default).
  if (metadata?.redteam_run === true) {
    throw new Error(
      "TR-01 violated: metadata declares redteam_run=true; an adaptive red-team claim requires a real run record"
    );
  }
  const externalEval = metadata?.external_evaluation ?? "not_run";
  if (externalEval !== "not_run") {
    throw new Error(
      "TR-01 violated: external_evaluation must be not_run until a real external run exists"
    );
  }
  const redteamRun = metadata?.redteam_run === true ? "run" : "not_run";

  // ── TR-02: protocol status vocabulary ──────────────────────────────────────
  const matrixRows = [];
  for (const [section, rows] of Object.entries(protocolMatrix.sections)) {
    for (const row of rows) {
      if (row.status === "conformant" || row.status === "pass") {
        throw new Error(
          `TR-02 violated: row ${row.id} uses a status outside the declared vocabulary`
        );
      }
      matrixRows.push({ section, id: row.id, name: row.name, status: row.status });
    }
  }
  const protocolStatusCounts = matrixRows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  // ── TR-03: adversarial numbers from the metrics artifact ───────────────────
  const textTotal = requireSource(
    "escape metrics text_scenarios",
    escapeMetrics.scenario_counts?.text_scenarios
  );
  const structuralTotal = requireSource(
    "escape metrics structural_scenarios",
    escapeMetrics.scenario_counts?.structural_scenarios
  );
  const combinedTotal = requireSource(
    "escape metrics combined_scenarios",
    escapeMetrics.scenario_counts?.combined_scenarios
  );
  if (
    escapeMetrics.text_mutation_escape_rate !== 0 &&
    phase === "F2" &&
    adversarialStatus === "f2_gates_passed"
  ) {
    throw new Error(
      "TR-03 violated: F2 promotion requires zero escape rates; metrics artifact disagrees"
    );
  }
  if (
    escapeMetrics.structural_mutation_escape_rate !== 0 ||
    escapeMetrics.combined_escape_rate !== 0
  ) {
    if (phase === "F2" && adversarialStatus === "f2_gates_passed") {
      throw new Error(
        "TR-03 violated: F2 promotion requires zero structural/combined escape rates"
      );
    }
  }

  const corpus = Object.fromEntries(
    Object.entries(corpusFiles).map(([name, bytes]) => [
      name,
      {
        sha256: sha256File(bytes),
        samples: bytes
          .toString("utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0).length,
      },
    ])
  );

  const failClosedOutcomeCounts = failClosedMatrix.rows.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  const report = {
    schema: "wasmagent-mcp-firewall-conformance-report/v1",
    identity: {
      repository,
      tested_sha: testedSha,
      package_version: packageVersion,
      generated_at_utc: generatedAtUtc,
      checkpoint: "docs/security/mcp-firewall-hardening-checkpoint.md",
      corpus,
      baseline_identity: {
        file: "packages/mcp-firewall/evals/baseline/mcp-firewall-baseline-v1.json",
        sha256: sha256File(requireSource("baseline bytes", inputs.baselineBytes)),
        mutation_detection_rate: baseline.metrics?.mutation_detection_rate,
        splits: baseline.splits,
        source_sha: baseline.source_sha,
      },
      metadata: {
        phase,
        adversarial_evaluation: adversarialStatus,
        maturity: metadata.maturity,
        redteam_run: redteamRun === "run",
        external_evaluation: externalEval,
      },
    },
    protocol_matrix: {
      authority: "packages/mcp-firewall/evals/protocol/mcp-protocol-matrix.json",
      tested_sha: protocolMatrix.tested_sha,
      status_counts: protocolStatusCounts,
      rows: matrixRows,
      conformance_gaps: protocolMatrix.conformance_gaps,
    },
    adversarial_evidence: {
      authority: "packages/mcp-firewall/evals/results/structural-escape-metrics.json",
      provenance:
        escapeProvenance === "frozen-baseline"
          ? "frozen-baseline (results file absent in this checkout; numbers from the committed baseline f2_metrics)"
          : "live-run (regenerated by the structural escape gate test)",
      text_mutation: {
        scenarios: textTotal,
        escapes: escapeMetrics.escapes.filter((e) => e.kind === "text").length,
        escape_rate: escapeMetrics.text_mutation_escape_rate,
      },
      structural_mutation: {
        scenarios: structuralTotal,
        escapes: escapeMetrics.escapes.length,
        escape_rate: escapeMetrics.structural_mutation_escape_rate,
      },
      combined_cross_product: {
        scenarios: combinedTotal,
        escape_rate: escapeMetrics.combined_escape_rate,
      },
      holdout_samples: corpus.holdout?.samples,
      redteam_corpus_samples: corpus.redteam?.samples,
      external_corpus_samples: corpus.external?.samples,
      adaptive_redteam_run: redteamRun,
      external_evaluation: externalEval,
    },
    fail_closed_matrix: {
      authority: "packages/mcp-firewall/evals/fail-closed/fail-closed-matrix.json",
      tested_sha: failClosedMatrix.tested_sha,
      outcome_counts: failClosedOutcomeCounts,
      rows: failClosedMatrix.rows.map((r) => ({
        id: r.id,
        condition: r.condition,
        outcome: r.outcome,
      })),
      critical_invariant: failClosedMatrix.critical_invariant,
    },
    information_flow_cases: {
      authority: "packages/mcp-firewall/evals/evidence/information-flow-results.json",
      tested_sha: informationFlow.tested_sha,
      cases: informationFlow.cases.map((c) => ({
        id: c.id,
        description: c.description,
        detection: c.detection,
        taint: c.taint,
        policy: c.policy,
        effect: c.effect,
      })),
      documented_limitations: informationFlow.cases
        .filter((c) => c.effect.includes("documented limitation"))
        .map((c) => c.id),
    },
    commit_time_authority_cases: {
      authority: "packages/mcp-firewall/evals/evidence/commit-time-authority-results.json",
      tested_sha: commitTime.tested_sha,
      cases: commitTime.cases.map((c) => ({
        id: c.id,
        dimension: c.dimension,
        plan_decision: c.plan_decision,
        change: c.change,
        commit_decision: c.commit_decision,
      })),
      model:
        "recompute-at-commit; no durable plan object with expected-state-transition preconditions is implemented",
    },
    performance: perf
      ? {
          authority: "packages/mcp-firewall/evals/results/perf-measurements.json",
          note: perf.note,
          environment: perf.environment,
          measurements_us: Object.fromEntries(
            Object.entries(perf.measurements).map(([k, v]) => [k, { p50: v.p50_us, p95: v.p95_us }])
          ),
          claim_ceiling:
            "informational only; no regression budget frozen; no throughput claims at any scale",
        }
      : {
          authority: null,
          note: "not measured in this environment (perf harness is run manually; see evals/bench/measure-perf.ts)",
          environment: null,
          measurements_us: null,
          claim_ceiling:
            "informational only; no regression budget frozen; no throughput claims at any scale",
        },
    claim_ceiling: CLAIM_CEILING,
    external_evaluation: "not_run",
    independent_verification: "not_established",
    capture_completeness:
      "NOT_ESTABLISHED — capture completeness is never provable from signed records alone",
  };

  validateTruthModel(report);
  return report;
}

export function validateTruthModel(report) {
  const violations = [];
  if (report.external_evaluation !== "not_run") {
    violations.push(
      "TR-01: external_evaluation must stay not_run until a real external/adaptive run exists"
    );
  }
  for (const r of report.protocol_matrix.rows) {
    if (r.status === "conformant" || r.status === "pass") {
      violations.push(
        `TR-02: protocol row ${r.id} claims a conformance status outside the vocabulary`
      );
    }
  }
  if (
    report.adversarial_evidence.adaptive_redteam_run !== "not_run" &&
    !report.adversarial_evidence.run_record
  ) {
    violations.push("TR-01: adaptive red-team claimed without a run record");
  }
  if (
    report.independent_verification !== "not_established" &&
    report.independent_verification !== "external"
  ) {
    violations.push(
      "TR-01: independent_verification can only be not_established or point at external evidence"
    );
  }
  if (!/NOT_ESTABLISHED/.test(report.capture_completeness)) {
    violations.push("TR-04: capture completeness may never be asserted");
  }
  for (const text of report.claim_ceiling) {
    if (typeof text !== "string" || text.length < 10)
      violations.push("claim ceiling entries must be non-empty statements");
  }
  if (report.identity.metadata.phase === "F2") {
    const { text_mutation, structural_mutation, combined_cross_product } =
      report.adversarial_evidence;
    if (
      text_mutation.escape_rate !== 0 ||
      structural_mutation.escape_rate !== 0 ||
      combined_cross_product.escape_rate !== 0
    ) {
      violations.push("TR-03: an F2-phase report cannot carry non-zero escape rates");
    }
  }
  if (violations.length > 0) {
    throw new Error(`truth-model violations:\n- ${violations.join("\n- ")}`);
  }
  return true;
}

const STATUS_ORDER = [
  "verified",
  "partially-verified",
  "implemented-not-conformance-tested",
  "not-implemented",
  "not-evaluated",
  "not-applicable",
];

export function renderReportMarkdown(report) {
  const L = [];
  L.push("# MCP Firewall Conformance & Adversarial Report");
  L.push("");
  L.push(
    `> GENERATED from measured artifacts by \`packages/mcp-firewall/evals/report/generate-conformance-report.mjs\`. The frozen JSON twin (\`packages/mcp-firewall/evals/report/mcp-firewall-conformance-report.json\`) is the machine authority. Do not edit by hand.`
  );
  L.push("");
  L.push("## 1. Identity");
  L.push("");
  L.push(`- Repository: \`${report.identity.repository}\` at \`${report.identity.tested_sha}\``);
  L.push(
    `- Package: @wasmagent/mcp-firewall ${report.identity.package_version} — phase \`${report.identity.metadata.phase}\`, adversarial \`${report.identity.metadata.adversarial_evaluation}\`, maturity \`${report.identity.metadata.maturity}\``
  );
  L.push(`- Generated: ${report.identity.generated_at_utc}`);
  L.push(`- Evidence anchor: \`${report.identity.checkpoint}\``);
  L.push(
    `- Baseline: \`mcp-firewall-baseline-v1.json\` (sha256 \`${report.identity.baseline_identity.sha256.slice(0, 16)}…\`, mutation detection rate ${report.identity.baseline_identity.mutation_detection_rate})`
  );
  L.push("");
  L.push("### Corpus hashes");
  L.push("");
  L.push("| split | samples | sha256 |");
  L.push("| --- | --- | --- |");
  for (const [name, c] of Object.entries(report.identity.corpus)) {
    L.push(`| ${name} | ${c.samples} | \`${c.sha256}\` |`);
  }
  L.push("");
  L.push("## 2. Protocol matrix (summary)");
  L.push("");
  L.push(
    `Authority: \`${report.protocol_matrix.authority}\` — ${report.protocol_matrix.rows.length} rows.`
  );
  L.push("");
  L.push("| status | rows |");
  L.push("| --- | --- |");
  for (const s of STATUS_ORDER) {
    if (report.protocol_matrix.status_counts[s])
      L.push(`| ${s} | ${report.protocol_matrix.status_counts[s]} |`);
  }
  L.push("");
  const gapRows = report.protocol_matrix.rows.filter(
    (r) => r.status !== "verified" && r.status !== "not-applicable"
  );
  if (gapRows.length > 0) {
    L.push("Non-verified, non-trivial rows:");
    L.push("");
    for (const r of gapRows) L.push(`- **${r.id}** (${r.status}) — ${r.name}`);
    L.push("");
  }
  for (const g of report.protocol_matrix.conformance_gaps ?? []) {
    L.push(`- Known gap **${g.id}**: ${g.description} — disposition: ${g.disposition}`);
  }
  L.push("");
  L.push("## 3. Adversarial evidence (F2, frozen corpus/mutator set)");
  L.push("");
  const ae = report.adversarial_evidence;
  L.push(
    `- Text mutation: **${ae.text_mutation.escapes}/${ae.text_mutation.scenarios}** escapes (rate ${ae.text_mutation.escape_rate})`
  );
  L.push(
    `- Structural mutation: **${ae.structural_mutation.escapes}/${ae.structural_mutation.scenarios}** escapes (rate ${ae.structural_mutation.escape_rate})`
  );
  L.push(
    `- Combined cross-product: **rate ${ae.combined_cross_product.escape_rate}** over ${ae.combined_cross_product.scenarios} scenarios through the default hardened \`MCPGateway\``
  );
  L.push(
    `- Holdout samples: ${ae.holdout_samples}; red-team corpus: ${ae.redteam_corpus_samples} (reserved); external corpus: ${ae.external_corpus_samples} (reserved)`
  );
  L.push(
    `- Adaptive red-team run: **${ae.adaptive_redteam_run}**; external evaluation: **${ae.external_evaluation}**`
  );
  L.push("");
  L.push("## 4. Fail-closed matrix (summary)");
  L.push("");
  L.push(
    `Authority: \`${report.fail_closed_matrix.authority}\`. Critical invariant: ${report.fail_closed_matrix.critical_invariant}`
  );
  L.push("");
  L.push("| outcome | rows |");
  L.push("| --- | --- |");
  for (const [o, n] of Object.entries(report.fail_closed_matrix.outcome_counts))
    L.push(`| ${o} | ${n} |`);
  L.push("");
  L.push("## 5. Information-flow cases (post-call / cross-tool)");
  L.push("");
  L.push("| id | detection | taint | policy | effect |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const c of report.information_flow_cases.cases) {
    L.push(
      `| ${c.id} | ${String(c.detection).replaceAll("|", "\\|")} | ${String(c.taint).replaceAll("|", "\\|")} | ${c.policy} | ${String(c.effect).replaceAll("|", "\\|")} |`
    );
  }
  if (report.information_flow_cases.documented_limitations.length > 0) {
    L.push("");
    L.push(
      `Documented limitations (reported, not rounded into passes): ${report.information_flow_cases.documented_limitations.join(", ")}.`
    );
  }
  L.push("");
  L.push("## 6. Commit-time authority cases");
  L.push("");
  L.push(`Model: ${report.commit_time_authority_cases.model}.`);
  L.push("");
  L.push("| id | dimension | plan | change | commit |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const c of report.commit_time_authority_cases.cases) {
    L.push(
      `| ${c.id} | ${c.dimension} | ${c.plan_decision} | ${String(c.change).replaceAll("|", "\\|")} | ${String(c.commit_decision).replaceAll("|", "\\|")} |`
    );
  }
  L.push("");
  L.push("## 7. Performance");
  L.push("");
  if (report.performance.measurements_us) {
    L.push(`Authority: \`${report.performance.authority}\` — ${report.performance.note}`);
    L.push("");
    L.push("| primitive | p50 µs | p95 µs |");
    L.push("| --- | --- | --- |");
    for (const [k, v] of Object.entries(report.performance.measurements_us)) {
      L.push(`| ${k} | ${v.p50} | ${v.p95} |`);
    }
  } else {
    L.push(`Not measured in this environment: ${report.performance.note}`);
  }
  L.push("");
  L.push(`Ceiling: ${report.performance.claim_ceiling}.`);
  L.push("");
  L.push("## 8. Claim ceiling");
  L.push("");
  for (const c of report.claim_ceiling) L.push(`- ${c}`);
  L.push("");
  L.push("## 9. External evaluation");
  L.push("");
  L.push(`- external_evaluation: **${report.external_evaluation}**`);
  L.push(`- independent_verification: **${report.independent_verification}**`);
  L.push(`- capture_completeness: **${report.capture_completeness}**`);
  L.push("");
  return L.join("\n");
}
