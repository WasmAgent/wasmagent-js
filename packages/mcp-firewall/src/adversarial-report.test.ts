/**
 * ART-F2-01..05 — F6 artifact promotion-state truth semantics (final-audit C2).
 *
 * The artifact can never be the place where an F2 truth claim first appears,
 * and it must FAIL validation when it would contradict itself:
 * an F2 declaration requires promotion_eligible=true and all three escape
 * rates measured at exactly 0. Explicit non-claims (external evaluation not
 * run, no adaptive red-team run) remain ALLOWED at F2.
 */

import { describe, expect, it } from "bun:test";
import { buildReport, validatePromotionState } from "../evals/report/adversarial-report.mjs";

function baseInputs(
  overrides: {
    metadata?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
    identity?: Record<string, unknown>;
  } = {}
): Parameters<typeof buildReport>[0] {
  return {
    pkg: { name: "@wasmagent/mcp-firewall", version: "2.1.2" },
    metadata: {
      phase: "F1",
      candidate_phase: "F2",
      adversarial_evaluation: "f2_candidate",
      ...overrides.metadata,
    },
    corpus: {
      train_count: 38,
      dev_count: 11,
      holdout_count: 11,
      redteam_count: 0,
      external_count: 0,
    },
    metrics: {
      text_mutation_escape_rate: 0,
      structural_mutation_escape_rate: 0,
      combined_escape_rate: 0,
      ...overrides.metrics,
    },
    identity: {
      github_sha: "2ba6ecdc408c7a4d658870570fdec073f919a63f",
      event_name: "pull_request",
      pr_head_sha: "ce0c862e07cb94730c6f71a0b1c4398b65470bae",
      base_ref: "main",
      head_ref: "feat/mcp-firewall-f2-hardening",
      base_sha: "9b2e6ec652db73e7612001b083d319b92dca05e5",
      ...overrides.identity,
    },
    generated_at: "2026-09-15T00:00:00.000Z",
  };
}

describe("ART-F2: artifact promotion-state truth semantics (C2)", () => {
  it("ART-F2-01: phase=F2 + promotion_eligible=false → validation FAILS", () => {
    const report = buildReport(
      baseInputs({
        metadata: { phase: "F2", adversarial_evaluation: "f2_gates_passed" },
        metrics: {
          text_mutation_escape_rate: 0.1,
          structural_mutation_escape_rate: null,
          combined_escape_rate: null,
        },
      })
    );
    const v = validatePromotionState(report);
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.startsWith("ART-F2-01"))).toBe(true);
  });

  it("ART-F2-01b: F2 metadata without gates_passed is not promotion_eligible", () => {
    const report = buildReport(
      baseInputs({
        metadata: { phase: "F2", adversarial_evaluation: "f2_candidate" },
      })
    );
    expect(report.promotion_eligible).toBe(false);
    const v = validatePromotionState(report);
    expect(v.valid).toBe(false);
  });

  it("ART-F2-02: phase=F2 + null escape metric → validation FAILS", () => {
    const report = buildReport(
      baseInputs({
        metadata: { phase: "F2", adversarial_evaluation: "f2_gates_passed" },
        metrics: {
          text_mutation_escape_rate: 0,
          structural_mutation_escape_rate: null,
          combined_escape_rate: 0,
        },
      })
    );
    const v = validatePromotionState(report);
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.startsWith("ART-F2-02"))).toBe(true);
  });

  it("ART-F2-03: phase=F2 + non-zero escape rate → validation FAILS", () => {
    const report = buildReport(
      baseInputs({
        metadata: { phase: "F2", adversarial_evaluation: "f2_gates_passed" },
        metrics: {
          text_mutation_escape_rate: 0,
          structural_mutation_escape_rate: 0.009,
          combined_escape_rate: 0,
        },
      })
    );
    const v = validatePromotionState(report);
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.startsWith("ART-F2-03"))).toBe(true);
  });

  it("ART-F2-04: phase=F2 + external_evaluation=not_run → allowed", () => {
    const report = buildReport(
      baseInputs({
        metadata: { phase: "F2", adversarial_evaluation: "f2_gates_passed" },
      })
    );
    expect(report.external_evaluation).toBe("not_run");
    const v = validatePromotionState(report);
    expect(v.valid).toBe(true);
  });

  it("ART-F2-05: phase=F2 + redteam_run=false → allowed (F2 excludes adaptive red-team)", () => {
    const report = buildReport(
      baseInputs({
        metadata: { phase: "F2", adversarial_evaluation: "f2_gates_passed" },
      })
    );
    expect(report.redteam_run).toBe(false);
    const v = validatePromotionState(report);
    expect(v.valid).toBe(true);
  });

  it("identity: PR head SHA and tested merge SHA are recorded separately", () => {
    const report = buildReport(baseInputs({}));
    expect(report.pr_head_sha).toBe("ce0c862e07cb94730c6f71a0b1c4398b65470bae");
    expect(report.tested_merge_sha).toBe("2ba6ecdc408c7a4d658870570fdec073f919a63f");
    expect(report.tested_main_sha).toBeNull();
    expect(report.base_sha).toBe("9b2e6ec652db73e7612001b083d319b92dca05e5");
  });

  it("identity: push runs record tested_main_sha, not a merge SHA", () => {
    const report = buildReport(
      baseInputs({
        identity: { event_name: "push", pr_head_sha: null, head_ref: null },
      })
    );
    expect(report.tested_main_sha).toBe("2ba6ecdc408c7a4d658870570fdec073f919a63f");
    expect(report.tested_merge_sha).toBeNull();
  });

  it("identity: an artifact naming no tested SHA fails validation", () => {
    const report = buildReport(
      baseInputs({ identity: { event_name: "workflow_dispatch", github_sha: null } })
    );
    const v = validatePromotionState(report);
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.includes("neither tested_merge_sha nor tested_main_sha"))).toBe(
      true
    );
  });

  it("promotion state: candidate phase reports state=open", () => {
    const report = buildReport(baseInputs({}));
    expect(report.promotion).toEqual({ target: "F2", state: "open" });
    expect(report.promotion_eligible).toBe(false);
  });

  it("promotion state: closed F2 reports state=closed", () => {
    const report = buildReport(
      baseInputs({
        metadata: { phase: "F2", adversarial_evaluation: "f2_gates_passed" },
      })
    );
    expect(report.promotion).toEqual({ target: "F2", state: "closed" });
    expect(report.promotion_eligible).toBe(true);
  });
});
