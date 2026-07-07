import { describe, expect, it } from "bun:test";
import type { CapabilityManifest } from "@wasmagent/core";
import { compileToRecordingPolicy, type RiskContext } from "./recordingPolicy.js";

const MANIFEST: CapabilityManifest = {
  allowedHosts: ["api.example.com"],
  allowedReadPaths: ["/workspace"],
  allowedWritePaths: ["/workspace"],
  extraCapabilities: [],
  cpuMs: 5000,
};

function ctx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    wasVetted: false,
    hasConsentAnomaly: false,
    taintChainLength: 0,
    sideEffectClass: "read",
    ...overrides,
  };
}

describe("compileToRecordingPolicy (#28)", () => {
  it("returns full when wasVetted is true", () => {
    const policy = compileToRecordingPolicy(MANIFEST, ctx({ wasVetted: true }));
    expect(policy.mode).toBe("full");
    expect(policy.reason).toBe("tool flagged by vetting");
  });

  it("returns full when hasConsentAnomaly is true", () => {
    const policy = compileToRecordingPolicy(MANIFEST, ctx({ hasConsentAnomaly: true }));
    expect(policy.mode).toBe("full");
    expect(policy.reason).toBe("consent anomaly recorded");
  });

  it("returns full when taintChainLength > 0 AND sideEffectClass is not read", () => {
    const policy = compileToRecordingPolicy(
      MANIFEST,
      ctx({ taintChainLength: 2, sideEffectClass: "mutate-local" }),
    );
    expect(policy.mode).toBe("full");
    expect(policy.reason).toBe("tainted input reaching state-changing call");
  });

  it("returns full when sideEffectClass is 'unknown' (highest severity invariant)", () => {
    const policy = compileToRecordingPolicy(MANIFEST, ctx({ sideEffectClass: "unknown" }));
    expect(policy.mode).toBe("full");
    expect(policy.reason).toBe("unknown side-effect class");
  });

  it("returns full for mutate-external", () => {
    const policy = compileToRecordingPolicy(MANIFEST, ctx({ sideEffectClass: "mutate-external" }));
    expect(policy.mode).toBe("full");
    expect(policy.reason).toBe("external mutation");
  });

  it("returns full for network-egress", () => {
    const policy = compileToRecordingPolicy(MANIFEST, ctx({ sideEffectClass: "network-egress" }));
    expect(policy.mode).toBe("full");
    expect(policy.reason).toBe("external mutation");
  });

  it("returns delta for mutate-local with no anomaly", () => {
    const policy = compileToRecordingPolicy(MANIFEST, ctx({ sideEffectClass: "mutate-local" }));
    expect(policy.mode).toBe("delta");
    expect(policy.reason).toBe("local mutation, low risk");
  });

  it("returns validation for read-only with no anomaly", () => {
    const policy = compileToRecordingPolicy(MANIFEST, ctx({ sideEffectClass: "read" }));
    expect(policy.mode).toBe("validation");
    expect(policy.reason).toBe("read-only, no anomaly");
  });

  it("unknown side-effect class is highest severity even with taintChainLength=0", () => {
    // The unknown == highest severity invariant must hold regardless of other signals
    const policy = compileToRecordingPolicy(
      MANIFEST,
      ctx({ sideEffectClass: "unknown", taintChainLength: 0, wasVetted: false }),
    );
    expect(policy.mode).toBe("full");
  });

  it("wasVetted takes priority over all other conditions", () => {
    // Even a read-only tool flagged by vetting gets full recording
    const policy = compileToRecordingPolicy(
      MANIFEST,
      ctx({ wasVetted: true, sideEffectClass: "read", taintChainLength: 0 }),
    );
    expect(policy.mode).toBe("full");
    expect(policy.reason).toBe("tool flagged by vetting");
  });
});
