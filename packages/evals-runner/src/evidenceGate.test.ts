import { describe, expect, it } from "bun:test";
import type { EvidenceAdmissionContract, EvidenceRow } from "./evidenceGate.js";
import { admitRows, gateReport } from "./evidenceGate.js";

const ALWAYS_PASS_CONTRACT: EvidenceAdmissionContract = {
  workloadId: "test-workload",
  driverName: "test-driver",
  runtimeSetting: "sandbox",
  schemaVersion: "evidence-admission/v1",
  replayPolicy: "deterministic",
  admissionRules: [],
  redactionPolicy: "none",
};

const DENY_RULE_CONTRACT: EvidenceAdmissionContract = {
  ...ALWAYS_PASS_CONTRACT,
  admissionRules: [
    {
      ruleId: "must-have-admitted-at",
      description: "Admitted rows must have admittedAt set",
      evaluator: (row) => !!(row as EvidenceRow).admittedAt,
    },
  ],
};

function row(id: string, type: EvidenceRow["type"], admittedAt?: number): EvidenceRow {
  return { rowId: id, type, evidenceRef: `sha256:${id}`, admittedAt };
}

describe("admitRows — no rules", () => {
  it("counts admitted rows correctly", () => {
    const rows = [row("r1", "admitted", 1000), row("r2", "admitted", 2000), row("r3", "smoke")];
    const result = admitRows(ALWAYS_PASS_CONTRACT, rows);
    expect(result.admitted).toBe(2);
    expect(result.smoke).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.totalRows).toBe(3);
  });

  it("smoke/diagnostic/fixture rows are never upgraded", () => {
    const rows = [row("r1", "smoke"), row("r2", "diagnostic"), row("r3", "fixture")];
    const result = admitRows(ALWAYS_PASS_CONTRACT, rows);
    expect(result.admitted).toBe(0);
    expect(result.smoke).toBe(1);
    expect(result.diagnostic).toBe(1);
    expect(result.fixture).toBe(1);
  });
});

describe("admitRows — with deny rule", () => {
  it("downgrades admitted row that fails rule", () => {
    const rows = [
      row("r1", "admitted"), // no admittedAt — should fail rule
      row("r2", "admitted", 1000), // has admittedAt — should pass
    ];
    const result = admitRows(DENY_RULE_CONTRACT, rows);
    expect(result.admitted).toBe(1);
    expect(result.rejected).toBe(1);
  });

  it("downgraded decision has ruleId and reason", () => {
    const rows = [row("r1", "admitted")];
    const result = admitRows(DENY_RULE_CONTRACT, rows);
    const d = result.decisions.find((x) => x.rowId === "r1")!;
    expect(d.finalType).toBe("smoke");
    expect(d.downgradeRuleId).toBe("must-have-admitted-at");
    expect(d.downgradeReason).toContain("admittedAt");
  });

  it("passing row is not downgraded", () => {
    const rows = [row("r1", "admitted", 999)];
    const result = admitRows(DENY_RULE_CONTRACT, rows);
    const d = result.decisions[0]!;
    expect(d.finalType).toBe("admitted");
    expect(d.downgradeRuleId).toBeUndefined();
  });
});

describe("gateReport", () => {
  it("renders markdown with summary table", () => {
    const rows = [row("r1", "admitted", 1000), row("r2", "smoke")];
    const result = admitRows(ALWAYS_PASS_CONTRACT, rows);
    const md = gateReport(result);
    expect(md).toContain("# Evidence Gate Report");
    expect(md).toContain("admitted");
    expect(md).toContain("smoke");
    expect(md).toContain("Admission rate:");
  });

  it("adds watermark when admission rate is low", () => {
    const rows = [row("r1", "smoke"), row("r2", "smoke"), row("r3", "smoke")];
    const result = admitRows(ALWAYS_PASS_CONTRACT, rows);
    const md = gateReport(result);
    expect(md).toContain("LOW ADMISSION RATE");
  });

  it("lists downgraded rows section when rejections exist", () => {
    const rows = [row("r1", "admitted")]; // no admittedAt → fails rule
    const result = admitRows(DENY_RULE_CONTRACT, rows);
    const md = gateReport(result);
    expect(md).toContain("Downgraded rows");
    expect(md).toContain("must-have-admitted-at");
  });

  it("does not show downgraded section when no rejections", () => {
    const rows = [row("r1", "admitted", 100)];
    const result = admitRows(DENY_RULE_CONTRACT, rows);
    const md = gateReport(result);
    expect(md).not.toContain("Downgraded rows");
  });

  it("100% admission with no rows shows 0.0%", () => {
    const result = admitRows(ALWAYS_PASS_CONTRACT, []);
    const md = gateReport(result);
    expect(md).toContain("0.0%");
  });
});
