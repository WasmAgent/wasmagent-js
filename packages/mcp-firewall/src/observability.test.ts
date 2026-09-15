import { describe, expect, test } from "bun:test";
import {
  FIREWALL_METRIC_NAMES,
  InMemoryMetricsRecorder,
  verdictToMetrics,
} from "./observability.js";
import type { FirewallSecurityVerdict } from "./verdict.js";

function makeVerdict(overrides: Partial<FirewallSecurityVerdict>): FirewallSecurityVerdict {
  return {
    detection: "not_applicable",
    policy: "allow",
    containment: "not_executed",
    consent: "not_required",
    taint: "clean",
    final: "allow",
    ...overrides,
  };
}

describe("observability", () => {
  test("OBS-01: increment increases counter", () => {
    const r = new InMemoryMetricsRecorder();
    r.increment(FIREWALL_METRIC_NAMES.POLICY_DENY_TOTAL);
    r.increment(FIREWALL_METRIC_NAMES.POLICY_DENY_TOTAL);
    expect(r.snapshot()[FIREWALL_METRIC_NAMES.POLICY_DENY_TOTAL]).toBe(2);
  });

  test("OBS-02: snapshot returns 0 for unincremented counters", () => {
    const r = new InMemoryMetricsRecorder();
    const snap = r.snapshot();
    for (const name of Object.values(FIREWALL_METRIC_NAMES)) {
      expect(snap[name]).toBe(0);
    }
  });

  test("OBS-03: verdictToMetrics — detection=blocked → DETECTION_BLOCK_TOTAL", () => {
    const metrics = verdictToMetrics(
      makeVerdict({ detection: "blocked", policy: "deny", final: "deny" })
    );
    expect(metrics).toContain(FIREWALL_METRIC_NAMES.DETECTION_BLOCK_TOTAL);
    expect(metrics).toContain(FIREWALL_METRIC_NAMES.POLICY_DENY_TOTAL);
  });

  test("OBS-04: verdictToMetrics — missed+contained → DETECTOR_MISS_CONTAINED_TOTAL", () => {
    const metrics = verdictToMetrics(
      makeVerdict({ detection: "missed", containment: "contained", policy: "deny", final: "deny" })
    );
    expect(metrics).toContain(FIREWALL_METRIC_NAMES.DETECTOR_MISS_CONTAINED_TOTAL);
    expect(metrics).not.toContain(FIREWALL_METRIC_NAMES.UNSAFE_ESCAPE_TOTAL);
  });

  test("OBS-05: verdictToMetrics — missed+escaped → UNSAFE_ESCAPE_TOTAL", () => {
    const metrics = verdictToMetrics(
      makeVerdict({ detection: "missed", containment: "escaped", policy: "allow", final: "allow" })
    );
    expect(metrics).toContain(FIREWALL_METRIC_NAMES.UNSAFE_ESCAPE_TOTAL);
    expect(metrics).not.toContain(FIREWALL_METRIC_NAMES.DETECTOR_MISS_CONTAINED_TOTAL);
  });

  test("OBS-06: multiple increments accumulate correctly", () => {
    const r = new InMemoryMetricsRecorder();
    for (let i = 0; i < 5; i++) {
      r.increment(FIREWALL_METRIC_NAMES.DETECTION_BLOCK_TOTAL);
    }
    for (let i = 0; i < 3; i++) {
      r.increment(FIREWALL_METRIC_NAMES.POLICY_DENY_TOTAL);
    }
    const snap = r.snapshot();
    expect(snap[FIREWALL_METRIC_NAMES.DETECTION_BLOCK_TOTAL]).toBe(5);
    expect(snap[FIREWALL_METRIC_NAMES.POLICY_DENY_TOTAL]).toBe(3);
    expect(snap[FIREWALL_METRIC_NAMES.RUGPULL_TOTAL]).toBe(0);
  });

  test("OBS-07: verdictToMetrics — tainted → TAINT_BLOCK_TOTAL", () => {
    const metrics = verdictToMetrics(makeVerdict({ taint: "tainted" }));
    expect(metrics).toContain(FIREWALL_METRIC_NAMES.TAINT_BLOCK_TOTAL);
  });

  test("OBS-08: verdictToMetrics — ask_user → CONSENT_ASK_TOTAL", () => {
    const metrics = verdictToMetrics(makeVerdict({ policy: "ask_user", final: "ask_user" }));
    expect(metrics).toContain(FIREWALL_METRIC_NAMES.CONSENT_ASK_TOTAL);
  });
});
