import { describe, expect, it } from "bun:test";
import {
  EvidenceAdmissionContractSchema,
  EvidenceRowSchema,
  EvidenceRowTypeSchema,
} from "./EvidenceAdmission.js";

describe("EvidenceRowTypeSchema", () => {
  it("accepts all four valid values", () => {
    for (const v of ["admitted", "smoke", "diagnostic", "fixture"] as const) {
      expect(EvidenceRowTypeSchema.parse(v)).toBe(v);
    }
  });
  it("rejects invalid value", () => {
    expect(() => EvidenceRowTypeSchema.parse("INVALID")).toThrow();
  });
});

describe("EvidenceRowSchema", () => {
  it("round-trips a minimal admitted row", () => {
    const row = EvidenceRowSchema.parse({
      rowId: "r1",
      type: "admitted",
      evidenceRef: "sha256:abc123",
      admittedAt: 1_700_000_000_000,
    });
    expect(row.type).toBe("admitted");
    expect(row.admittedAt).toBe(1_700_000_000_000);
  });

  it("round-trips a rejected row with reason", () => {
    const row = EvidenceRowSchema.parse({
      rowId: "r2",
      type: "smoke",
      evidenceRef: "trace://run/42",
      rejectionReason: "runtime_setting=live disqualifies",
    });
    expect(row.rejectionReason).toContain("disqualifies");
  });

  it("rejects row with invalid type", () => {
    expect(() => EvidenceRowSchema.parse({
      rowId: "r3",
      type: "INVALID",
      evidenceRef: "x",
    })).toThrow();
  });
});

describe("EvidenceAdmissionContractSchema", () => {
  const valid = {
    workloadId: "bscode-worker-kv",
    driverName: "claude-sonnet-4-6",
    runtimeSetting: "sandbox",
    schemaVersion: "evidence-admission/v1",
    replayPolicy: "deterministic",
    admissionRules: [
      { ruleId: "build-must-pass", description: "Build exit code must be 0" },
    ],
    redactionPolicy: "none",
  };

  it("round-trips a valid contract (no evaluator fn in wire schema)", () => {
    const c = EvidenceAdmissionContractSchema.parse(valid);
    expect(c.workloadId).toBe("bscode-worker-kv");
    expect(c.admissionRules[0]!.ruleId).toBe("build-must-pass");
  });

  it("rejects invalid runtimeSetting", () => {
    expect(() => EvidenceAdmissionContractSchema.parse({
      ...valid, runtimeSetting: "cloud",
    })).toThrow();
  });
});
