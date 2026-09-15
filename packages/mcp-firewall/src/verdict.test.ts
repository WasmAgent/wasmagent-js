import { describe, expect, it } from "bun:test";
import type { InvocationDecision, ToolInvocationDecision } from "./policy.js";
import type { TaintedObservation } from "./taint.js";
import { composeVerdict } from "./verdict.js";
import type { ToolRiskFinding, VettingResult } from "./vetting.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeVetting(blocked: boolean, severity?: "critical" | "high" | "medium"): VettingResult {
  const finding: ToolRiskFinding | undefined = severity
    ? {
        severity,
        category: "tool_poisoning",
        type: "prompt_injection",
        field: "description",
        evidenceExcerpt: "test finding",
        evidenceHash: "abc123def456",
        recommendation: severity === "medium" ? "ask" : "deny",
      }
    : undefined;
  return {
    toolName: "test",
    blocked,
    findings: finding ? [finding] : [],
    recommendation:
      blocked || severity === "critical" || severity === "high"
        ? "deny"
        : severity === "medium"
          ? "ask"
          : "allow",
  };
}

function makeDecision(decision: InvocationDecision, consentRef?: string): ToolInvocationDecision {
  return {
    decision,
    reasons: [],
    requiredCapabilities: [],
    matchedPolicyIds: [],
    ...(consentRef !== undefined ? { userConsentRef: consentRef } : {}),
  };
}

function makeTaint(instructionLike: boolean, adversarialScore = 0): TaintedObservation {
  return {
    sourceTool: "test",
    trust: "untrusted",
    contentType: "text",
    contentHash: "deadbeef",
    sanitizers: [],
    instructionLikeTextDetected: instructionLike,
    adversarialScore,
    taintLabels: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("composeVerdict", () => {
  it("FW-VRD-01: blocked vetting → detection=blocked, final=deny", () => {
    const vetting = makeVetting(true, "critical");
    const decision = makeDecision("deny");
    const v = composeVerdict({ vetting, decision, hasConsent: false });
    expect(v.detection).toBe("blocked");
    expect(v.final).toBe("deny");
    expect(v.policy).toBe("deny");
  });

  it("FW-VRD-02: clean vetting, policy=allow → detection=missed, policy=allow, final=allow", () => {
    const vetting = makeVetting(false);
    const decision = makeDecision("allow");
    const v = composeVerdict({ vetting, decision, hasConsent: false });
    expect(v.detection).toBe("missed");
    expect(v.policy).toBe("allow");
    expect(v.final).toBe("allow");
  });

  it("FW-VRD-03: detection missed but policy=deny → containment=contained", () => {
    const vetting = makeVetting(false);
    const decision = makeDecision("deny");
    const v = composeVerdict({ vetting, decision, hasConsent: false });
    expect(v.detection).toBe("missed");
    expect(v.containment).toBe("contained");
  });

  it("FW-VRD-04: detection missed, policy=allow, no taint → containment=escaped", () => {
    const vetting = makeVetting(false);
    const decision = makeDecision("allow");
    const v = composeVerdict({ vetting, decision, hasConsent: false });
    expect(v.detection).toBe("missed");
    expect(v.containment).toBe("escaped");
  });

  it("FW-VRD-05: tainted observation → taint=tainted", () => {
    const taint = makeTaint(true);
    const v = composeVerdict({
      vetting: null,
      decision: makeDecision("allow"),
      taint,
      hasConsent: false,
    });
    expect(v.taint).toBe("tainted");
  });

  it("FW-VRD-05b: high adversarial score → taint=tainted", () => {
    const taint = makeTaint(false, 0.9);
    const v = composeVerdict({
      vetting: null,
      decision: makeDecision("allow"),
      taint,
      hasConsent: false,
    });
    expect(v.taint).toBe("tainted");
  });

  it("FW-VRD-06: valid consent → consent=valid", () => {
    const decision = makeDecision("allow", "consent-hash-abc");
    const v = composeVerdict({ vetting: null, decision, hasConsent: true });
    expect(v.consent).toBe("valid");
  });

  it("FW-VRD-07: null vetting → detection=not_applicable", () => {
    const v = composeVerdict({
      vetting: null,
      decision: makeDecision("allow"),
      hasConsent: false,
    });
    expect(v.detection).toBe("not_applicable");
  });

  it("FW-VRD-08: defense-in-depth success — missed detection contained by policy", () => {
    // The adversary bypassed semantic/keyword detection but policy still denied.
    // This is the key scenario: a semantic bypass does NOT imply unsafe effect.
    const vetting = makeVetting(false); // no findings — detection missed
    const decision = makeDecision("deny"); // policy layer caught it
    const v = composeVerdict({ vetting, decision, hasConsent: false });
    expect(v.detection).toBe("missed");
    expect(v.policy).toBe("deny");
    expect(v.containment).toBe("contained");
    expect(v.final).toBe("deny");
  });

  it("dry_run maps to allow in policy verdict", () => {
    const v = composeVerdict({
      vetting: null,
      decision: makeDecision("dry_run"),
      hasConsent: false,
    });
    expect(v.policy).toBe("allow");
    expect(v.final).toBe("allow");
  });

  it("medium severity vetting → detection=warned", () => {
    const vetting = makeVetting(false, "medium");
    const v = composeVerdict({
      vetting,
      decision: makeDecision("ask_user"),
      hasConsent: false,
    });
    expect(v.detection).toBe("warned");
  });

  it("blocked detection with allow policy → consent=invalid", () => {
    const vetting = makeVetting(true, "critical");
    const v = composeVerdict({
      vetting,
      decision: makeDecision("allow"),
      hasConsent: false,
    });
    // detection=blocked, no consent → invalid
    expect(v.consent).toBe("invalid");
  });

  it("clean taint observation → taint=clean", () => {
    const taint = makeTaint(false, 0.1);
    const v = composeVerdict({
      vetting: null,
      decision: makeDecision("allow"),
      taint,
      hasConsent: false,
    });
    expect(v.taint).toBe("clean");
  });

  it("no taint provided (pre-call) → taint=clean", () => {
    const v = composeVerdict({
      vetting: null,
      decision: makeDecision("allow"),
      hasConsent: false,
    });
    expect(v.taint).toBe("clean");
  });

  it("missed detection + tainted output + ask_user → containment=contained", () => {
    const vetting = makeVetting(false);
    const taint = makeTaint(true);
    const v = composeVerdict({
      vetting,
      decision: makeDecision("ask_user"),
      taint,
      hasConsent: false,
    });
    expect(v.detection).toBe("missed");
    expect(v.taint).toBe("tainted");
    expect(v.containment).toBe("contained");
  });
});
