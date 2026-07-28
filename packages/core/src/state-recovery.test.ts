import { describe, expect, it } from "bun:test";
import type { ActionEvidence, AEPRecord } from "@wasmagent/aep";
import { AEPRecordSchema, InMemoryEvidenceStore } from "@wasmagent/aep";
import { restoreFromSnapshot } from "./checkpoint/index.js";
import { MessageAssembler } from "./memory/MessageAssembler.js";
import {
  type ChainVerifier,
  type RecoveredState,
  recoverTask,
  StateRecovery,
} from "./state-recovery.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

/** Build a schema-valid AEPRecord from a partial, applying zod defaults. */
function makeRecord(over: Partial<AEPRecord> & Pick<AEPRecord, "run_id">): AEPRecord {
  return AEPRecordSchema.parse({
    schema_version: "aep/v0.3",
    run_id: over.run_id,
    created_at_ms: 1000,
    actions: [],
    input_refs: [],
    signature: { alg: "ed25519", key_id: "none", sig: "UNSIGNED_PLACEHOLDER" },
    ...over,
  });
}

function makeAction(over: Partial<ActionEvidence> = {}): ActionEvidence {
  return {
    action_id: "a-1",
    tool_name: "read_file",
    state_changing: false,
    timestamp_ms: 1000,
    side_effect_class: "read",
    ...over,
  } as ActionEvidence;
}

/** A linked chain: record[0] has null prev, each later record links to the previous. */
function makeChain(runId: string, perRecord: ActionEvidence[][]): AEPRecord[] {
  const records: AEPRecord[] = [];
  let prevHash: string | null = null;
  perRecord.forEach((actions, i) => {
    const rec = makeRecord({
      run_id: runId,
      created_at_ms: 1000 + i * 100,
      trace_id: "trace-1",
      model_id: "qwen-1.5b",
      actions,
      input_refs: i === 0 ? [{ uri: "task:summarize%20the%20report", taint_labels: [] }] : [],
      prev_record_hash: prevHash,
    });
    records.push(rec);
    // Structural links only need a stable, non-null value for later records.
    prevHash = `hash-of-record-${i}`;
  });
  return records;
}

// ── recoverTask ───────────────────────────────────────────────────────────────

describe("recoverTask", () => {
  it("decodes a task: input_ref", () => {
    const records = [
      makeRecord({
        run_id: "r",
        input_refs: [{ uri: "task:do%20the%20thing", taint_labels: [] }],
      }),
    ];
    expect(recoverTask(records)).toBe("do the thing");
  });

  it("falls back to prompt: scheme", () => {
    const records = [
      makeRecord({ run_id: "r", input_refs: [{ uri: "prompt:hello", taint_labels: [] }] }),
    ];
    expect(recoverTask(records)).toBe("hello");
  });

  it("returns empty string when no task is encoded", () => {
    const records = [makeRecord({ run_id: "r", input_refs: [] })];
    expect(recoverTask(records)).toBe("");
  });
});

// ── recoverFromRecords — reconstruction ───────────────────────────────────────

describe("StateRecovery.recoverFromRecords", () => {
  it("reconstructs an ordered tool-call timeline from a multi-record chain", () => {
    const chain = makeChain("run-1", [
      [makeAction({ action_id: "a-1", tool_name: "read_file", timestamp_ms: 1100 })],
      [
        makeAction({ action_id: "a-2", tool_name: "write_file", timestamp_ms: 1200 }),
        makeAction({ action_id: "a-3", tool_name: "read_file", timestamp_ms: 1250 }),
      ],
      [makeAction({ action_id: "a-4", tool_name: "run_tests", timestamp_ms: 1300 })],
    ]);

    const state = new StateRecovery().recoverFromRecords(chain, "run-1");

    expect(state.runId).toBe("run-1");
    expect(state.recordCount).toBe(3);
    expect(state.actionCount).toBe(4);
    expect(state.steps).toHaveLength(4);
    // Steps are rebuilt in evidence order with incrementing stepIndex.
    expect(state.steps.map((s) => (s as { toolCallId: string }).toolCallId)).toEqual([
      "a-1",
      "a-2",
      "a-3",
      "a-4",
    ]);
    expect(state.steps.map((s) => (s as { stepIndex: number }).stepIndex)).toEqual([1, 2, 3, 4]);
    // Tools are de-duplicated and sorted.
    expect(state.tools).toEqual(["read_file", "run_tests", "write_file"]);
    expect(state.model).toBe("qwen-1.5b");
    expect(state.traceId).toBe("trace-1");
    // Task recovered from the first record's task: input_ref.
    expect(state.task).toBe("summarize the report");
    // Time range spans the records.
    expect(state.timeRangeMs).toEqual({ start: 1000, end: 1200 });
    expect(state.chainIntegrity.valid).toBe(true);
  });

  it("flags error steps from outcome and non-zero exit_code", () => {
    const chain = makeChain("run-1", [
      [
        makeAction({ action_id: "ok", tool_name: "t", outcome: "success" }),
        makeAction({ action_id: "boom", tool_name: "t", outcome: "error" }),
        makeAction({ action_id: "crash", tool_name: "t", exit_code: 2 }),
      ],
    ]);
    const state = new StateRecovery().recoverFromRecords(chain, "run-1");
    const errors = state.steps.map((s) => (s as { isError: boolean }).isError);
    expect(errors).toEqual([false, true, true]);
  });

  it("honors explicit task and model overrides", () => {
    const chain = makeChain("run-1", [[makeAction({ action_id: "a-1", tool_name: "t" })]]);
    const state = new StateRecovery().recoverFromRecords(chain, "run-1", {
      task: "explicit task",
      model: "gpt-x",
    });
    expect(state.task).toBe("explicit task");
    expect(state.model).toBe("gpt-x");
  });

  it("filters out records belonging to other runs and other trace ids", () => {
    const records = [
      ...makeChain("run-1", [[makeAction({ action_id: "a-1", tool_name: "t" })]]),
      ...makeChain("run-other", [[makeAction({ action_id: "a-x", tool_name: "t" })]]),
    ];
    const state = new StateRecovery().recoverFromRecords(records, "run-1");
    expect(state.recordCount).toBe(1);
    expect(state.actionCount).toBe(1);

    // traceId filter: build a run where some records carry a different trace.
    const mixedTrace = makeChain("run-2", [
      [makeAction({ action_id: "m-1", tool_name: "t" })],
      [makeAction({ action_id: "m-2", tool_name: "t" })],
    ]);
    (mixedTrace[1] as { trace_id: string }).trace_id = "other-trace";
    const filtered = new StateRecovery().recoverFromRecords(mixedTrace, "run-2", {
      traceId: "trace-1",
    });
    expect(filtered.actionCount).toBe(1);
    expect(filtered.steps.map((s) => (s as { toolCallId: string }).toolCallId)).toEqual(["m-1"]);
  });
});

// ── causality ─────────────────────────────────────────────────────────────────

describe("StateRecovery causality", () => {
  it("preserves the full parent/chain causality graph", () => {
    const chain = makeChain("run-1", [
      [
        makeAction({
          action_id: "root",
          tool_name: "plan",
          causal_chain_id: "chain-A",
          timestamp_ms: 1100,
        }),
        makeAction({
          action_id: "child",
          tool_name: "act",
          parent_action_id: "root",
          causal_chain_id: "chain-A",
          timestamp_ms: 1150,
        }),
        makeAction({
          action_id: "sibling",
          tool_name: "act",
          parent_action_id: "root",
          causal_chain_id: "chain-B",
          timestamp_ms: 1200,
        }),
      ],
    ]);
    const state = new StateRecovery().recoverFromRecords(chain, "run-1");
    expect(state.causalChain).toHaveLength(3);
    expect(state.causalChain).toContainEqual({
      actionId: "child",
      toolName: "act",
      parentActionId: "root",
      causalChainId: "chain-A",
      timestampMs: 1150,
      recordIndex: 0,
    });
    expect(state.causalChain).toContainEqual({
      actionId: "sibling",
      toolName: "act",
      parentActionId: "root",
      causalChainId: "chain-B",
      timestampMs: 1200,
      recordIndex: 0,
    });
    // Each causal link's actionId matches a reconstructed step's toolCallId.
    const callIds = new Set(state.steps.map((s) => (s as { toolCallId: string }).toolCallId));
    for (const link of state.causalChain) expect(callIds.has(link.actionId)).toBe(true);
  });

  it("omits optional causality fields when absent (exactOptionalPropertyTypes)", () => {
    const chain = makeChain("run-1", [[makeAction({ action_id: "lonely", tool_name: "t" })]]);
    const state = new StateRecovery().recoverFromRecords(chain, "run-1");
    const link = state.causalChain[0];
    expect(link).toBeDefined();
    expect(link).not.toHaveProperty("parentActionId");
    expect(link).not.toHaveProperty("causalChainId");
  });
});

// ── chain integrity ───────────────────────────────────────────────────────────

describe("StateRecovery chain integrity", () => {
  it("structural fast path accepts a valid linked chain", () => {
    const chain = makeChain("run-1", [
      [makeAction({ action_id: "a-1", tool_name: "t" })],
      [makeAction({ action_id: "a-2", tool_name: "t" })],
    ]);
    const state = new StateRecovery().recoverFromRecords(chain, "run-1");
    expect(state.chainIntegrity).toEqual({ valid: true });
  });

  it("throws by default when the first record spuriously claims a previous hash", () => {
    const chain = makeChain("run-1", [[makeAction({ action_id: "a-1", tool_name: "t" })]]);
    (chain[0] as { prev_record_hash: string | null }).prev_record_hash = "should-not-be-here";
    expect(() => new StateRecovery().recoverFromRecords(chain, "run-1")).toThrow(/broken/);
  });

  it("reconstructs anyway with throwOnBrokenChain:false and reports the break", () => {
    const chain = makeChain("run-1", [
      [makeAction({ action_id: "a-1", tool_name: "t" })],
      [makeAction({ action_id: "a-2", tool_name: "t" })],
      [makeAction({ action_id: "a-3", tool_name: "t" })],
    ]);
    // Truncate the link on the middle record → broken chain.
    (chain[1] as { prev_record_hash: string | null }).prev_record_hash = null;
    const state = new StateRecovery().recoverFromRecords(chain, "run-1", {
      throwOnBrokenChain: false,
    });
    expect(state.chainIntegrity.valid).toBe(false);
    expect(state.chainIntegrity.brokenAt).toBe(1);
    expect(state.chainIntegrity.reason).toMatch(/truncated/i);
    // Reconstruction still proceeds from the (possibly incomplete) evidence.
    expect(state.actionCount).toBe(3);
  });

  it("delegates to a caller-supplied verifier when provided", () => {
    const chain = makeChain("run-1", [[makeAction({ action_id: "a-1", tool_name: "t" })]]);
    const rejecting: ChainVerifier = () => ({ valid: false, brokenAt: 0 });
    expect(() =>
      new StateRecovery().recoverFromRecords(chain, "run-1", { verifyChain: rejecting })
    ).toThrow(/caller verifier rejected chain/);

    const accepting: ChainVerifier = () => ({ valid: true });
    const state = new StateRecovery().recoverFromRecords(chain, "run-1", {
      verifyChain: accepting,
    });
    expect(state.chainIntegrity).toEqual({ valid: true });
  });

  it("returns an empty, valid state for an unknown run", () => {
    const state = new StateRecovery().recoverFromRecords([], "missing");
    expect(state.recordCount).toBe(0);
    expect(state.actionCount).toBe(0);
    expect(state.steps).toEqual([]);
    expect(state.chainIntegrity.valid).toBe(true);
  });
});

// ── toSnapshot + restoreFromSnapshot bridge ───────────────────────────────────

describe("StateRecovery.toSnapshot", () => {
  it("produces an AgentSnapshot restorable into a MessageAssembler", () => {
    const chain = makeChain("run-1", [
      [makeAction({ action_id: "a-1", tool_name: "read_file" })],
      [makeAction({ action_id: "a-2", tool_name: "write_file" })],
    ]);
    const recovery = new StateRecovery();
    const state: RecoveredState = recovery.recoverFromRecords(chain, "run-1");
    const snapshot = recovery.toSnapshot(state);

    expect(snapshot.traceId).toBe("trace-1");
    expect(snapshot.task).toBe("summarize the report");
    expect(snapshot.stepIndex).toBe(2);
    expect(snapshot.history).toBe(state.steps);

    const assembler = new MessageAssembler({ systemPrompt: "sys", toolsSchema: [] });
    restoreFromSnapshot(snapshot, assembler);
    // restoreFromSnapshot re-seeds the task as a user_message, then replays history.
    expect(assembler.steps).toHaveLength(1 + state.steps.length);
    expect(assembler.steps[0]?.type).toBe("user_message");
    expect(assembler.steps[1]?.type).toBe("tool_use");
  });

  it("attaches an agentConfig when provided", () => {
    const state = new StateRecovery().recoverFromRecords(
      makeChain("run-1", [[makeAction({ action_id: "a-1", tool_name: "t" })]]),
      "run-1"
    );
    const cfg = { model: "m", tools: ["t"], maxSteps: 10 };
    const snapshot = new StateRecovery().toSnapshot(state, cfg);
    expect(snapshot.agentConfig).toEqual(cfg);
  });
});

// ── EvidenceStore integration ─────────────────────────────────────────────────

describe("StateRecovery.recover (EvidenceStore integration)", () => {
  it("reads records from a real @wasmagent/aep InMemoryEvidenceStore", async () => {
    const store = new InMemoryEvidenceStore();
    for (const rec of makeChain("run-live", [
      [makeAction({ action_id: "l-1", tool_name: "read_file", timestamp_ms: 5000 })],
      [makeAction({ action_id: "l-2", tool_name: "grep", timestamp_ms: 5100 })],
    ])) {
      store.append(rec);
    }

    const state = await new StateRecovery().recover(store, "run-live");
    expect(state.recordCount).toBe(2);
    expect(state.actionCount).toBe(2);
    expect(state.tools).toEqual(["grep", "read_file"]);
    expect(state.steps.map((s) => (s as { toolCallId: string }).toolCallId)).toEqual([
      "l-1",
      "l-2",
    ]);
    expect(state.chainIntegrity.valid).toBe(true);
  });
});
