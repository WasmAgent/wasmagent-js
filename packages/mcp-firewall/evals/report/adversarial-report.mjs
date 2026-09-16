/**
 * Adversarial report builder + promotion-state validator (pure functions).
 *
 * Split from the CLI so tests can assert truth-model invariants directly
 * (ART-F2-01..05). The CLI (generate-adversarial-report.mjs) gathers inputs,
 * builds, validates, and FAILS the job when the artifact would contradict
 * itself — final-audit C2: F6 must refuse contradictory F2 evidence.
 */

/**
 * Build the v2 report object. All truth-bearing values must be passed in —
 * this function never invents success values.
 *
 * @param {object} inputs
 * @param {object} inputs.pkg            parsed package.json
 * @param {object} inputs.metadata       parsed package-metadata.json
 * @param {object} inputs.corpus         {train_count, dev_count, holdout_count, redteam_count, external_count}
 * @param {object} inputs.metrics        {text_mutation_escape_rate, structural_mutation_escape_rate, combined_escape_rate} — null when unknown
 * @param {object} inputs.identity       {github_sha, event_name, pr_head_sha, base_ref, head_ref, base_sha}
 * @param {string} inputs.generated_at   ISO timestamp
 */
export function buildReport(inputs) {
  const { pkg, metadata, corpus, metrics, identity, generated_at } = inputs;

  const declaredPhase = metadata.phase ?? null;
  const candidatePhase = metadata.candidate_phase ?? null;

  const metricsPass =
    metrics.text_mutation_escape_rate === 0 &&
    metrics.structural_mutation_escape_rate === 0 &&
    metrics.combined_escape_rate === 0;

  // Single promotion state (C2): eligible only when the metadata declares F2
  // with gates passed AND the measured escape rates are all exactly 0.
  const promotionEligible =
    declaredPhase === "F2" && metadata.adversarial_evaluation === "f2_gates_passed" && metricsPass;

  const isPullRequest = identity.event_name === "pull_request";
  // Every non-PR trigger of this workflow (push, schedule, workflow_dispatch)
  // checks out a main-branch head, so GITHUB_SHA is the tested main commit —
  // a schedule-triggered run must not produce a SHA-less artifact.
  const isMainRun = !isPullRequest;

  return {
    format: "wasmagent-mcp-firewall-adversarial-report/v2",
    generated_at,
    // Identity is recorded WITHOUT collapsing head and merge identities:
    // pull_request runs test the synthetic merge commit; the PR head is
    // reported separately (final-audit §3).
    pr_head_sha: identity.pr_head_sha ?? null,
    tested_merge_sha: isPullRequest ? identity.github_sha : null,
    tested_main_sha: isMainRun ? identity.github_sha : null,
    base_ref: identity.base_ref ?? null,
    base_sha: identity.base_sha ?? null,
    head_ref: identity.head_ref ?? null,
    package: pkg.name,
    package_version: pkg.version,
    declared_phase: declaredPhase,
    candidate_phase: candidatePhase,
    adversarial_evaluation: metadata.adversarial_evaluation ?? null,
    promotion: {
      target: candidatePhase ?? declaredPhase,
      state: promotionEligible ? "closed" : "open",
    },
    corpus,
    metrics,
    redteam_run: corpus.redteam_count > 0,
    external_evaluation: corpus.external_count > 0 ? "frozen_external_corpus" : "not_run",
    promotion_eligible: promotionEligible,
  };
}

/**
 * Validate promotion-state truth semantics. Returns {valid, errors[]}.
 * F6 must FAIL (non-zero exit) when validation errors exist.
 */
export function validatePromotionState(report) {
  const errors = [];

  if (report.declared_phase === "F2") {
    if (report.promotion_eligible !== true) {
      errors.push("ART-F2-01: declared_phase=F2 but promotion_eligible is not true");
    }
    for (const key of [
      "text_mutation_escape_rate",
      "structural_mutation_escape_rate",
      "combined_escape_rate",
    ]) {
      const v = report.metrics?.[key];
      if (v === null || v === undefined) {
        errors.push(`ART-F2-02: declared_phase=F2 requires ${key} — got ${JSON.stringify(v)}`);
      } else if (v !== 0) {
        errors.push(`ART-F2-03: declared_phase=F2 requires ${key} === 0 — got ${v}`);
      }
    }
    // C2 / §8: explicit non-claims are ALLOWED at F2 (external evaluation and
    // adaptive red-team are defined as later work).
    if (
      report.external_evaluation !== "not_run" &&
      report.external_evaluation !== "frozen_external_corpus"
    ) {
      errors.push(`unknown external_evaluation value: ${report.external_evaluation}`);
    }
  }

  // Identity binding: the artifact must name what was actually tested.
  if (!report.tested_merge_sha && !report.tested_main_sha) {
    errors.push("artifact records neither tested_merge_sha nor tested_main_sha");
  }

  return { valid: errors.length === 0, errors };
}
