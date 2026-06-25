import { describe, expect, it } from "bun:test";
import { AEPEmitter } from "./emitter.js";

describe("AEPEmitter", () => {
  it("builds a valid AEPRecord with one action, one capability decision, one verifier result", () => {
    const emitter = new AEPEmitter({ run_id: "run-test-001" });

    emitter.addAction({
      tool_name: "write_file",
      state_changing: true,
      evidence_refs: ["sha256:abc123"],
    });

    emitter.addCapabilityDecision({
      capability: "fs:write",
      subject: "agent",
      resource: "/tmp/output.txt",
      decision: "allow",
      reason_code: "policy-default",
    });

    emitter.addVerifierResult({
      verifier_id: "deterministic-v1",
      passed: true,
      score: 1.0,
      claim_ids: ["claim-001"],
    });

    const record = emitter.build(1_700_000_000_000);

    expect(record.schema_version).toBe("aep/v0.1");
    expect(record.actions.length).toBe(1);
    expect(record.capability_decisions.length).toBe(1);
    expect(record.verifier_results.length).toBe(1);
    expect(record.run_id).toBe("run-test-001");
    expect(record.created_at_ms).toBe(1_700_000_000_000);
  });

  it("digestContent returns a 64-char hex string", () => {
    const digest = AEPEmitter.digestContent("hello");
    expect(typeof digest).toBe("string");
    expect(digest.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(digest)).toBe(true);
  });

  it("auto-assigns action_id and timestamp_ms when omitted", () => {
    const emitter = new AEPEmitter({ run_id: "run-auto" });
    emitter.addAction({ tool_name: "read_file", state_changing: false });
    const record = emitter.build();
    const action = record.actions[0];
    expect(action).toBeDefined();
    expect(action?.action_id).toBe("action-0");
    expect(typeof action?.timestamp_ms).toBe("number");
  });

  it("setBudgetLedger records budget consumption in the built AEPRecord", () => {
    const emitter = new AEPEmitter({ run_id: "run-budget-001" });
    emitter.setBudgetLedger({
      token_budget: { limit: 1000, spent: 450 },
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.budget_ledger).toBeDefined();
    expect(record.budget_ledger?.token_budget?.spent).toBe(450);
    expect(record.budget_ledger?.token_budget?.limit).toBe(1000);
  });
});
