import { describe, expect, it } from "bun:test";
import type { CapabilityManifest } from "@wasmagent/core";
import {
  type AnomalyAlert,
  AnomalyDetector,
  compileToRecordingPolicy,
  DEFAULT_ANOMALY_THRESHOLDS,
  type RiskContext,
} from "./recordingPolicy.js";

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
      ctx({ taintChainLength: 2, sideEffectClass: "mutate-local" })
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
      ctx({ sideEffectClass: "unknown", taintChainLength: 0, wasVetted: false })
    );
    expect(policy.mode).toBe("full");
  });

  it("wasVetted takes priority over all other conditions", () => {
    // Even a read-only tool flagged by vetting gets full recording
    const policy = compileToRecordingPolicy(
      MANIFEST,
      ctx({ wasVetted: true, sideEffectClass: "read", taintChainLength: 0 })
    );
    expect(policy.mode).toBe("full");
    expect(policy.reason).toBe("tool flagged by vetting");
  });
});

describe("AnomalyDetector (#266)", () => {
  // Baseline of five normal durations/payloads: mean 100, stddev ≈ 7.91.
  const BASELINE = [100, 110, 90, 105, 95];

  function feedBaseline(
    detector: AnomalyDetector,
    toolName = "t",
    field: "durationMs" | "payloadBytes" = "durationMs"
  ): void {
    BASELINE.forEach((v, i) => {
      detector.observe({
        toolName,
        durationMs: field === "durationMs" ? v : 10,
        payloadBytes: field === "payloadBytes" ? v : 10,
        timestampMs: i,
      });
    });
  }

  it("exposes documented default thresholds", () => {
    const detector = new AnomalyDetector();
    expect(detector.config).toEqual(DEFAULT_ANOMALY_THRESHOLDS);
    expect(detector.config.minSamples).toBe(5);
    expect(detector.config.timingZScore).toBe(3);
  });

  it("lets callers override individual thresholds", () => {
    const detector = new AnomalyDetector({ timingZScore: 2, maxCallsPerSecond: 1 });
    expect(detector.config.timingZScore).toBe(2);
    expect(detector.config.maxCallsPerSecond).toBe(1);
    // Untouched thresholds keep their defaults.
    expect(detector.config.payloadZScore).toBe(3);
  });

  it("does not alert while the baseline warms up (minSamples gating)", () => {
    // minSamples=10 but only 5 baseline observations exist → never scores.
    const detector = new AnomalyDetector({ minSamples: 10 });
    feedBaseline(detector);
    const alerts = detector.observe({
      toolName: "t",
      durationMs: 10_000,
      payloadBytes: 10,
      timestampMs: 100,
    });
    expect(alerts).toEqual([]);
  });

  it("flags a timing outlier beyond timingZScore", () => {
    const detector = new AnomalyDetector();
    feedBaseline(detector);
    const alerts = detector.observe({
      toolName: "t",
      durationMs: 1000,
      payloadBytes: 10,
      timestampMs: 100,
    });
    expect(alerts.length).toBe(1);
    const alert = alerts[0];
    expect(alert.dimension).toBe("timing");
    expect(alert.toolName).toBe("t");
    expect(alert.observed).toBe(1000);
    expect(alert.score).toBeGreaterThan(3);
  });

  it("flags a payload-size outlier beyond payloadZScore", () => {
    const detector = new AnomalyDetector();
    feedBaseline(detector, "t", "payloadBytes");
    const alerts = detector.observe({
      toolName: "t",
      durationMs: 10,
      payloadBytes: 5000,
      timestampMs: 100,
    });
    expect(alerts.length).toBe(1);
    expect(alerts[0].dimension).toBe("payload");
    expect(alerts[0].observed).toBe(5000);
    expect(alerts[0].score).toBeGreaterThan(3);
  });

  it("flags a call-rate burst beyond maxCallsPerSecond", () => {
    const detector = new AnomalyDetector({ maxCallsPerSecond: 5, rateWindowMs: 1000 });
    // 5 calls inside the window stay at the ceiling (5/s) — no alert yet.
    for (const ts of [0, 100, 200, 300, 400]) {
      expect(
        detector.observe({ toolName: "t", durationMs: 10, payloadBytes: 10, timestampMs: ts })
      ).toEqual([]);
    }
    // The 6th call inside the same second pushes the rate to 6/s → alert.
    const burst = detector.observe({
      toolName: "t",
      durationMs: 10,
      payloadBytes: 10,
      timestampMs: 500,
    });
    expect(burst.length).toBe(1);
    expect(burst[0].dimension).toBe("call-rate");
    expect(burst[0].observed).toBeGreaterThan(5);
    expect(burst[0].baseline).toBe(5);
  });

  it("a higher maxCallsPerSecond ceiling suppresses the same burst", () => {
    const detector = new AnomalyDetector({ maxCallsPerSecond: 10, rateWindowMs: 1000 });
    let last: AnomalyAlert[] = [];
    for (let ts = 0; ts <= 500; ts += 100) {
      last = detector.observe({ toolName: "t", durationMs: 10, payloadBytes: 10, timestampMs: ts });
    }
    expect(last.some((a) => a.dimension === "call-rate")).toBe(false);
  });

  it("configurable timingZScore controls timing sensitivity", () => {
    // A mild +1.9σ deviation alerts when the threshold is loose (1) …
    const strict = new AnomalyDetector({ timingZScore: 1 });
    feedBaseline(strict);
    const strictAlerts = strict.observe({
      toolName: "t",
      durationMs: 115,
      payloadBytes: 10,
      timestampMs: 100,
    });
    expect(strictAlerts.some((a) => a.dimension === "timing")).toBe(true);

    // … but not at the default 3σ threshold.
    const loose = new AnomalyDetector();
    feedBaseline(loose);
    const looseAlerts = loose.observe({
      toolName: "t",
      durationMs: 115,
      payloadBytes: 10,
      timestampMs: 100,
    });
    expect(looseAlerts.some((a) => a.dimension === "timing")).toBe(false);
  });

  it("tracks each tool independently", () => {
    const detector = new AnomalyDetector();
    feedBaseline(detector, "a");
    // Tool "b" has no baseline — its first (huge) observation is a cold start.
    const cold = detector.observe({
      toolName: "b",
      durationMs: 999_999,
      payloadBytes: 10,
      timestampMs: 1,
    });
    expect(cold).toEqual([]);
    // Tool "a" has a baseline — an outlier alerts only for "a".
    const aAlerts = detector.observe({
      toolName: "a",
      durationMs: 1000,
      payloadBytes: 10,
      timestampMs: 100,
    });
    expect(aAlerts.length).toBe(1);
    expect(aAlerts[0].toolName).toBe("a");
    expect(aAlerts[0].dimension).toBe("timing");
  });

  it("statsFor reports the accumulated baseline and is undefined for unseen tools", () => {
    const detector = new AnomalyDetector();
    feedBaseline(detector);
    const stats = detector.statsFor("t", 100);
    expect(stats).toBeDefined();
    expect(stats?.samples).toBe(5);
    expect(stats?.meanDurationMs).toBeCloseTo(100, 1);
    expect(stats?.stddevDurationMs).toBeGreaterThan(0);
    expect(stats?.meanPayloadBytes).toBe(10);
    expect(detector.statsFor("nope")).toBeUndefined();
  });
});
