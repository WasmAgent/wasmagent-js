import { describe, expect, it, beforeEach } from "bun:test";
import { HealthMetrics } from "./HealthMetrics.js";

describe("HealthMetrics", () => {
  const m = HealthMetrics.getInstance();

  beforeEach(() => { m.reset(); });

  it("returns zero snapshot initially", () => {
    const s = m.getSnapshot();
    expect(s.failures).toBe(0);
    expect(s.timeouts).toBe(0);
    expect(s.policyDenials).toBe(0);
    expect(s.resourceTokensUsed).toBe(0);
    expect(s.latency.count).toBe(0);
    expect(s.latency.avgMs).toBe(0);
  });

  it("records latency correctly", () => {
    m.recordLatency(100);
    m.recordLatency(200);
    const s = m.getSnapshot();
    expect(s.latency.count).toBe(2);
    expect(s.latency.totalMs).toBe(300);
    expect(s.latency.avgMs).toBe(150);
  });

  it("records failures", () => {
    m.recordFailure();
    m.recordFailure();
    expect(m.getSnapshot().failures).toBe(2);
  });

  it("recordTimeout increments both timeouts and failures", () => {
    m.recordTimeout();
    const s = m.getSnapshot();
    expect(s.timeouts).toBe(1);
    expect(s.failures).toBe(1);
  });

  it("records policy denials", () => {
    m.recordPolicyDenial();
    m.recordPolicyDenial();
    expect(m.getSnapshot().policyDenials).toBe(2);
  });

  it("records resource usage", () => {
    m.recordResourceUsage(500);
    m.recordResourceUsage(300);
    expect(m.getSnapshot().resourceTokensUsed).toBe(800);
  });

  it("reset clears all counters", () => {
    m.recordLatency(100);
    m.recordFailure();
    m.recordTimeout();
    m.recordPolicyDenial();
    m.recordResourceUsage(1000);
    m.reset();
    const s = m.getSnapshot();
    expect(s.failures).toBe(0);
    expect(s.timeouts).toBe(0);
    expect(s.policyDenials).toBe(0);
    expect(s.resourceTokensUsed).toBe(0);
    expect(s.latency.count).toBe(0);
  });

  it("singleton returns the same instance", () => {
    expect(HealthMetrics.getInstance()).toBe(HealthMetrics.getInstance());
  });
});
