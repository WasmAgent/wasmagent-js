import { describe, expect, it } from "bun:test";
import { AEPEmitter } from "./emitter.js";
import { resolveRepoCommit } from "./resolve-repo-commit.js";
import { createLocalSignerFromSeed } from "./signer.js";
import { LocalTimestamper } from "./timestamperLocal.js";
import { AEPRecordSchema } from "./types.js";
import { isStateChangingTool, STATE_CHANGING_PATTERNS } from "./utils.js";
import { verifyAEPChain, verifyAEPRecord } from "./verify.js";

// Deterministic seed for tests (32 bytes as hex)
const TEST_SEED = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const TEST_KEY_ID = "test-key-01";

describe("AEPEmitter", () => {
  it("builds a valid AEPRecord with one action, one capability decision, one verifier result", () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({ run_id: "run-test-001", signer });

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

    expect(record.schema_version).toBe("aep/v0.3");
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

  it("uses provided timestamp_ms for historical data seeding (#19)", () => {
    const emitter = new AEPEmitter({ run_id: "run-historical" });
    const historicalTs = 1_600_000_000_000; // a past timestamp
    emitter.addAction({
      tool_name: "seed_data",
      state_changing: true,
      timestamp_ms: historicalTs,
    });
    const record = emitter.build();
    const action = record.actions[0];
    expect(action).toBeDefined();
    expect(action?.timestamp_ms).toBe(historicalTs);
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

  it("threads run-provenance fields from constructor into the built record", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-provenance-001",
      model_id: "test-model",
      repo_commit: "1234567890abcdef1234567890abcdef12345678",
      runtime_version: "wasmagent-js@1.2.3",
      policy_bundle_digest: "a".repeat(64),
      tool_manifest_digest: "b".repeat(64),
      signer,
    });

    emitter.addAction({ tool_name: "noop", state_changing: false });

    const built = emitter.build(1_700_000_000_000);
    expect(built.repo_commit).toBe("1234567890abcdef1234567890abcdef12345678");
    expect(built.runtime_version).toBe("wasmagent-js@1.2.3");
    expect(built.policy_bundle_digest).toBe("a".repeat(64));
    expect(built.tool_manifest_digest).toBe("b".repeat(64));

    const emitted = await emitter.emit(1_700_000_000_000);
    expect(emitted.repo_commit).toBe("1234567890abcdef1234567890abcdef12345678");
    expect(emitted.runtime_version).toBe("wasmagent-js@1.2.3");
    expect(emitted.policy_bundle_digest).toBe("a".repeat(64));
    expect(emitted.tool_manifest_digest).toBe("b".repeat(64));

    const publicKey = await signer.getPublicKey();
    const tampered = { ...emitted, repo_commit: "deadbeef" };
    const valid = await verifyAEPRecord(tampered, publicKey);
    expect(valid).toBe(false);
  });

  it("supports user_id and subject_id via constructor (#20)", () => {
    const emitter = new AEPEmitter({
      run_id: "run-user-001",
      user_id: "user-alice",
      subject_id: "subject-project-x",
    });
    emitter.addAction({ tool_name: "noop", state_changing: false });
    const record = emitter.build(1_700_000_000_000);
    expect(record.user_id).toBe("user-alice");
    expect(record.subject_id).toBe("subject-project-x");
  });

  it("supports user_id and subject_id via setter methods (#20)", () => {
    const emitter = new AEPEmitter({ run_id: "run-user-002" });
    emitter.setUserId("user-bob");
    emitter.setSubjectId("subject-audit-trail");
    emitter.addAction({ tool_name: "noop", state_changing: false });
    const record = emitter.build(1_700_000_000_000);
    expect(record.user_id).toBe("user-bob");
    expect(record.subject_id).toBe("subject-audit-trail");
  });

  it("user_id and subject_id are optional and backwards compatible (#20)", () => {
    const emitter = new AEPEmitter({ run_id: "run-user-003" });
    emitter.addAction({ tool_name: "noop", state_changing: false });
    const record = emitter.build(1_700_000_000_000);
    expect(record.user_id).toBeUndefined();
    expect(record.subject_id).toBeUndefined();
  });

  it("supports permission_gate on action events (#21)", () => {
    const emitter = new AEPEmitter({ run_id: "run-gate-001" });
    emitter.addAction({
      tool_name: "deploy",
      state_changing: true,
      permission_gate: {
        decision: "approved",
        gate: "production-deploy-gate",
        reason: "auto-approved by policy for staging",
      },
    });
    const record = emitter.build(1_700_000_000_000);
    const action = record.actions[0];
    expect(action?.permission_gate).toBeDefined();
    expect(action?.permission_gate?.decision).toBe("approved");
    expect(action?.permission_gate?.gate).toBe("production-deploy-gate");
    expect(action?.permission_gate?.reason).toBe("auto-approved by policy for staging");
  });

  it("permission_gate supports denied decision (#21)", () => {
    const emitter = new AEPEmitter({ run_id: "run-gate-002" });
    emitter.addAction({
      tool_name: "delete_db",
      state_changing: true,
      permission_gate: {
        decision: "denied",
        gate: "destructive-ops-gate",
      },
    });
    const record = emitter.build(1_700_000_000_000);
    const action = record.actions[0];
    expect(action?.permission_gate?.decision).toBe("denied");
    expect(action?.permission_gate?.reason).toBeUndefined();
  });

  it("permission_gate supports auto_approved decision (#21)", () => {
    const emitter = new AEPEmitter({ run_id: "run-gate-003" });
    emitter.addAction({
      tool_name: "read_file",
      state_changing: false,
      permission_gate: {
        decision: "auto_approved",
        gate: "read-only-gate",
      },
    });
    const record = emitter.build(1_700_000_000_000);
    const action = record.actions[0];
    expect(action?.permission_gate?.decision).toBe("auto_approved");
  });
});

describe("AEP Ed25519 signature chain", () => {
  it("emit + verify round-trip passes", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-sig-001",
      model_id: "test-model",
      signer,
    });

    emitter.addAction({
      tool_name: "bash",
      state_changing: false,
    });

    const record = await emitter.emit(1_700_000_000_000);

    expect(record.signature).toBeDefined();
    expect(record.signature.alg).toBe("ed25519");
    expect(record.signature.key_id).toBe(TEST_KEY_ID);
    expect(typeof record.signature.sig).toBe("string");
    expect(record.signature.sig.length).toBeGreaterThan(0);

    const publicKey = await signer.getPublicKey();
    const valid = await verifyAEPRecord(record, publicKey);
    expect(valid).toBe(true);
  });

  it("verify returns false after tampering with any field", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-tamper-001",
      signer,
    });

    const record = await emitter.emit(1_700_000_000_000);
    const publicKey = await signer.getPublicKey();

    // Tamper: change run_id
    const tampered = { ...record, run_id: "injected-run" };
    const valid = await verifyAEPRecord(tampered, publicKey);
    expect(valid).toBe(false);
  });

  it("verify returns false after tampering with created_at_ms", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-tamper-002",
      signer,
    });

    const record = await emitter.emit(1_700_000_000_000);
    const publicKey = await signer.getPublicKey();

    const tampered = { ...record, created_at_ms: 9_999_999_999_999 };
    const valid = await verifyAEPRecord(tampered, publicKey);
    expect(valid).toBe(false);
  });

  it("verify returns false when using a different public key", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const wrongSeed = "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe";
    const wrongSigner = createLocalSignerFromSeed(wrongSeed, "wrong-key");

    const emitter = new AEPEmitter({ run_id: "run-wrongkey-001", signer });
    const record = await emitter.emit(1_700_000_000_000);

    const wrongPublicKey = await wrongSigner.getPublicKey();
    const valid = await verifyAEPRecord(record, wrongPublicKey);
    expect(valid).toBe(false);
  });

  it("emit throws when no signer is configured", async () => {
    const emitter = new AEPEmitter({ run_id: "run-nosigner" });
    await expect(emitter.emit()).rejects.toThrow("AEPEmitter.emit() requires a signer");
  });
});

describe("AEPRecord schema validation", () => {
  it("schema parse fails when signature is missing", () => {
    const recordWithoutSig = {
      schema_version: "aep/v0.3",
      run_id: "run-nosig",
      created_at_ms: 1_700_000_000_000,
      input_refs: [],
      output_refs: [],
      capability_decisions: [],
      actions: [],
      verifier_results: [],
    };

    const result = AEPRecordSchema.safeParse(recordWithoutSig);
    expect(result.success).toBe(false);
  });

  it("schema parse fails when signature.alg is not 'ed25519'", () => {
    const recordBadAlg = {
      schema_version: "aep/v0.3",
      run_id: "run-badalg",
      created_at_ms: 1_700_000_000_000,
      input_refs: [],
      output_refs: [],
      capability_decisions: [],
      actions: [],
      verifier_results: [],
      signature: { alg: "rsa-pss", key_id: "k1", sig: "abc123" },
    };

    const result = AEPRecordSchema.safeParse(recordBadAlg);
    expect(result.success).toBe(false);
  });

  it("schema parse succeeds with a valid signature block", () => {
    const recordValid = {
      schema_version: "aep/v0.3",
      run_id: "run-valid",
      created_at_ms: 1_700_000_000_000,
      input_refs: [],
      output_refs: [],
      capability_decisions: [],
      actions: [],
      verifier_results: [],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };

    const result = AEPRecordSchema.safeParse(recordValid);
    expect(result.success).toBe(true);
  });

  it("schema parse succeeds with user_id and subject_id (#20)", () => {
    const recordWithIds = {
      schema_version: "aep/v0.3",
      run_id: "run-ids",
      user_id: "user-123",
      subject_id: "subject-456",
      created_at_ms: 1_700_000_000_000,
      input_refs: [],
      output_refs: [],
      capability_decisions: [],
      actions: [],
      verifier_results: [],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };

    const result = AEPRecordSchema.safeParse(recordWithIds);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.user_id).toBe("user-123");
      expect(result.data.subject_id).toBe("subject-456");
    }
  });

  it("schema parse succeeds with permission_gate on actions (#21)", () => {
    const recordWithGate = {
      schema_version: "aep/v0.3",
      run_id: "run-gate",
      created_at_ms: 1_700_000_000_000,
      input_refs: [],
      output_refs: [],
      capability_decisions: [],
      actions: [
        {
          action_id: "action-0",
          tool_name: "deploy",
          state_changing: true,
          timestamp_ms: 1_700_000_000_000,
          evidence_refs: [],
          permission_gate: {
            decision: "approved",
            gate: "deploy-gate",
            reason: "approved by admin",
          },
        },
      ],
      verifier_results: [],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };

    const result = AEPRecordSchema.safeParse(recordWithGate);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actions[0]?.permission_gate?.decision).toBe("approved");
    }
  });

  it("v0.2 records still parse under v0.3 schema (backwards compat)", () => {
    const v02Record = {
      schema_version: "aep/v0.2",
      run_id: "run-v02-compat",
      created_at_ms: 1_700_000_000_000,
      input_refs: [],
      output_refs: [],
      capability_decisions: [],
      actions: [
        {
          action_id: "action-0",
          tool_name: "read_file",
          state_changing: false,
          timestamp_ms: 1_700_000_000_000,
          evidence_refs: [],
        },
      ],
      verifier_results: [],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };

    const result = AEPRecordSchema.safeParse(v02Record);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema_version).toBe("aep/v0.2");
      // Defaults should apply
      expect(result.data.actions[0]?.recording_mode).toBe("validation");
      expect(result.data.actions[0]?.side_effect_class).toBe("unknown");
    }
  });
});

describe("createLocalSignerFromSeed", () => {
  it("throws on invalid hex seed", () => {
    expect(() => createLocalSignerFromSeed("not-hex", "k1")).toThrow(
      "seedHex must be a 64-character hexadecimal string"
    );
  });

  it("throws on seed that is too short", () => {
    expect(() => createLocalSignerFromSeed("deadbeef", "k1")).toThrow(
      "seedHex must be a 64-character hexadecimal string"
    );
  });

  it("produces consistent signatures for the same seed", async () => {
    const signer1 = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const signer2 = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const bytes = new TextEncoder().encode("test message");
    const sig1 = await signer1.sign(bytes);
    const sig2 = await signer2.sign(bytes);
    expect(sig1).toBe(sig2);
  });
});

describe("isStateChangingTool (#23)", () => {
  it("returns true for tools with state-changing names", () => {
    expect(isStateChangingTool({ name: "write_file" })).toBe(true);
    expect(isStateChangingTool({ name: "create_user" })).toBe(true);
    expect(isStateChangingTool({ name: "delete_record" })).toBe(true);
    expect(isStateChangingTool({ name: "deploy_app" })).toBe(true);
    expect(isStateChangingTool({ name: "execute_command" })).toBe(true);
  });

  it("returns true when description contains state-changing keywords", () => {
    expect(isStateChangingTool({ name: "foo", description: "Publish the artifact" })).toBe(true);
    expect(isStateChangingTool({ name: "bar", description: "Will send an email" })).toBe(true);
  });

  it("returns false for read-only tools", () => {
    expect(isStateChangingTool({ name: "read_file" })).toBe(false);
    expect(isStateChangingTool({ name: "get_status" })).toBe(false);
    expect(isStateChangingTool({ name: "list_items" })).toBe(false);
    expect(isStateChangingTool({ name: "search", description: "Searches documents" })).toBe(false);
    expect(isStateChangingTool({ name: "run_invoice_match" })).toBe(false);
    expect(isStateChangingTool({ name: "run_compliance_checks" })).toBe(false);
    expect(isStateChangingTool({ name: "post_process" })).toBe(false);
    expect(isStateChangingTool({ name: "run_report" })).toBe(false);
  });

  it("returns true for tools with 'save' in the name", () => {
    expect(isStateChangingTool({ name: "save_pr_draft" })).toBe(true);
    expect(isStateChangingTool({ name: "save_file" })).toBe(true);
  });

  it("exports STATE_CHANGING_PATTERNS array", () => {
    expect(Array.isArray(STATE_CHANGING_PATTERNS)).toBe(true);
    expect(STATE_CHANGING_PATTERNS.length).toBeGreaterThan(0);
    expect(STATE_CHANGING_PATTERNS[0]).toBeInstanceOf(RegExp);
  });
});

describe("session_id / turn_index (#22)", () => {
  it("passes run_context with session_id and turn_index through to the record", () => {
    const emitter = new AEPEmitter({
      run_id: "run-session-001",
      run_context: {
        agent_id: "agent-1",
        session_id: "session-abc",
        turn_index: 3,
      },
    });
    emitter.addAction({ tool_name: "noop", state_changing: false });
    const record = emitter.build(1_700_000_000_000);
    expect(record.run_context).toBeDefined();
    expect(record.run_context?.session_id).toBe("session-abc");
    expect(record.run_context?.turn_index).toBe(3);
  });

  it("schema validates run_context with session fields", () => {
    const raw = {
      schema_version: "aep/v0.3",
      run_id: "run-session-schema",
      created_at_ms: 1_700_000_000_000,
      input_refs: [],
      output_refs: [],
      capability_decisions: [],
      actions: [],
      verifier_results: [],
      run_context: {
        session_id: "sess-123",
        turn_index: 0,
        delegation_chain: [],
      },
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };
    const result = AEPRecordSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.run_context?.session_id).toBe("sess-123");
      expect(result.data.run_context?.turn_index).toBe(0);
    }
  });
});

describe("created_at_ms in constructor (#19)", () => {
  it("uses created_at_ms from constructor when build() has no argument", () => {
    const emitter = new AEPEmitter({
      run_id: "run-ts-001",
      created_at_ms: 1_500_000_000_000,
    });
    emitter.addAction({ tool_name: "noop", state_changing: false });
    const record = emitter.build();
    expect(record.created_at_ms).toBe(1_500_000_000_000);
  });

  it("build() parameter overrides constructor created_at_ms", () => {
    const emitter = new AEPEmitter({
      run_id: "run-ts-002",
      created_at_ms: 1_500_000_000_000,
    });
    emitter.addAction({ tool_name: "noop", state_changing: false });
    const record = emitter.build(1_600_000_000_000);
    expect(record.created_at_ms).toBe(1_600_000_000_000);
  });
});

describe("RecordingMode tri-state (#26)", () => {
  it("recording_mode defaults to 'validation' when not specified", () => {
    const emitter = new AEPEmitter({ run_id: "run-rm-001" });
    emitter.addAction({ tool_name: "read_file", state_changing: false });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.recording_mode).toBe("validation");
  });

  it("recording_mode respects emitter-level recordingMode option", () => {
    const emitter = new AEPEmitter({
      run_id: "run-rm-002",
      recordingMode: "full",
    });
    emitter.addAction({ tool_name: "write_file", state_changing: true });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.recording_mode).toBe("full");
  });

  it("per-action recording_mode overrides emitter-level default", () => {
    const emitter = new AEPEmitter({
      run_id: "run-rm-003",
      recordingMode: "validation",
    });
    emitter.addAction({
      tool_name: "deploy",
      state_changing: true,
      recording_mode: "full",
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.recording_mode).toBe("full");
  });

  it("delta_ref is accepted when mode is 'delta'", () => {
    const emitter = new AEPEmitter({ run_id: "run-rm-004" });
    emitter.addAction({
      tool_name: "patch_file",
      state_changing: true,
      recording_mode: "delta",
      delta_ref: "sha256:prev-state-digest",
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.recording_mode).toBe("delta");
    expect(record.actions[0]?.delta_ref).toBe("sha256:prev-state-digest");
  });

  it("delta_ref is optional and can be omitted", () => {
    const emitter = new AEPEmitter({ run_id: "run-rm-005" });
    emitter.addAction({ tool_name: "noop", state_changing: false });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.delta_ref).toBeUndefined();
  });

  it("v0.2 records without recording_mode parse with default 'validation' (backwards compat)", () => {
    const raw = {
      schema_version: "aep/v0.2",
      run_id: "run-compat",
      created_at_ms: 1_700_000_000_000,
      input_refs: [],
      output_refs: [],
      capability_decisions: [],
      actions: [
        {
          action_id: "action-0",
          tool_name: "read_file",
          state_changing: false,
          timestamp_ms: 1_700_000_000_000,
          evidence_refs: [],
          // no recording_mode field — should default
        },
      ],
      verifier_results: [],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };
    const result = AEPRecordSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actions[0]?.recording_mode).toBe("validation");
    }
  });
});

describe("AEP v0.3 — side_effect_class (#7 Gap 1)", () => {
  it("side_effect_class defaults to 'unknown' when not specified", () => {
    const emitter = new AEPEmitter({ run_id: "run-sec-001" });
    emitter.addAction({ tool_name: "read_file", state_changing: false });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.side_effect_class).toBe("unknown");
  });

  it("side_effect_class respects emitter-level sideEffectClass option", () => {
    const emitter = new AEPEmitter({
      run_id: "run-sec-002",
      sideEffectClass: "read",
    });
    emitter.addAction({ tool_name: "read_file", state_changing: false });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.side_effect_class).toBe("read");
  });

  it("per-action side_effect_class overrides emitter-level default", () => {
    const emitter = new AEPEmitter({
      run_id: "run-sec-003",
      sideEffectClass: "read",
    });
    emitter.addAction({
      tool_name: "deploy",
      state_changing: true,
      side_effect_class: "network-egress",
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.side_effect_class).toBe("network-egress");
  });

  it("run_side_effect_class_max is computed correctly from actions", () => {
    const emitter = new AEPEmitter({ run_id: "run-sec-max-001" });
    emitter.addAction({
      tool_name: "read_file",
      state_changing: false,
      side_effect_class: "read",
    });
    emitter.addAction({
      tool_name: "write_file",
      state_changing: true,
      side_effect_class: "mutate-local",
    });
    emitter.addAction({
      tool_name: "deploy",
      state_changing: true,
      side_effect_class: "mutate-external",
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.run_side_effect_class_max).toBe("mutate-external");
  });

  it("run_side_effect_class_max picks 'unknown' as highest when present", () => {
    const emitter = new AEPEmitter({ run_id: "run-sec-max-002" });
    emitter.addAction({
      tool_name: "read_file",
      state_changing: false,
      side_effect_class: "read",
    });
    emitter.addAction({
      tool_name: "mystery",
      state_changing: true,
      side_effect_class: "unknown",
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.run_side_effect_class_max).toBe("unknown");
  });

  it("run_side_effect_class_max handles single action", () => {
    const emitter = new AEPEmitter({ run_id: "run-sec-max-003" });
    emitter.addAction({
      tool_name: "fetch",
      state_changing: true,
      side_effect_class: "network-egress",
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.run_side_effect_class_max).toBe("network-egress");
  });

  it("run_side_effect_class_max is undefined when no actions", () => {
    const emitter = new AEPEmitter({ run_id: "run-sec-max-004" });
    const record = emitter.build(1_700_000_000_000);
    expect(record.run_side_effect_class_max).toBeUndefined();
  });

  it("state_changing boolean is preserved for backwards compat", () => {
    const emitter = new AEPEmitter({ run_id: "run-sec-compat" });
    emitter.addAction({
      tool_name: "deploy",
      state_changing: true,
      side_effect_class: "mutate-external",
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.state_changing).toBe(true);
    expect(record.actions[0]?.side_effect_class).toBe("mutate-external");
  });
});

describe("AEP v0.3 — state_digest_kind + state_digest_coverage (#7 Gap 2)", () => {
  it("state_digest_kind is optional and accepts valid values", () => {
    const raw = {
      schema_version: "aep/v0.3",
      run_id: "run-sdk-001",
      created_at_ms: 1_700_000_000_000,
      actions: [
        {
          action_id: "action-0",
          tool_name: "git_commit",
          state_changing: true,
          timestamp_ms: 1_700_000_000_000,
          pre_state_digest: "sha256:abc",
          post_state_digest: "sha256:def",
          state_digest_kind: "git-tree",
          state_digest_coverage: { paths: ["/src"], depth: 3 },
        },
      ],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };
    const result = AEPRecordSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actions[0]?.state_digest_kind).toBe("git-tree");
      expect(result.data.actions[0]?.state_digest_coverage).toEqual({
        paths: ["/src"],
        depth: 3,
      });
    }
  });

  it("state_digest_coverage can hold arbitrary shape", () => {
    const emitter = new AEPEmitter({ run_id: "run-sdk-002" });
    emitter.addAction({
      tool_name: "db_migration",
      state_changing: true,
      pre_state_digest: "sha256:before",
      post_state_digest: "sha256:after",
      state_digest_kind: "db-rowset",
      state_digest_coverage: { tables: ["users", "orders"], filter: "active" },
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.state_digest_coverage).toEqual({
      tables: ["users", "orders"],
      filter: "active",
    });
  });
});

describe("AEP v0.3 — argument_drift (#7 Gap 3)", () => {
  it("argument_drift serializes and deserializes correctly", () => {
    const emitter = new AEPEmitter({ run_id: "run-drift-001" });
    emitter.addAction({
      tool_name: "exec_command",
      state_changing: true,
      argument_drift: {
        detected: true,
        approved_args_digest: "sha256:approved",
        observed_args_digest: "sha256:observed",
        resolution: "denied",
      },
    });
    const record = emitter.build(1_700_000_000_000);
    const drift = record.actions[0]?.argument_drift;
    expect(drift).toBeDefined();
    expect(drift?.detected).toBe(true);
    expect(drift?.approved_args_digest).toBe("sha256:approved");
    expect(drift?.observed_args_digest).toBe("sha256:observed");
    expect(drift?.resolution).toBe("denied");
  });

  it("argument_drift with matched resolution", () => {
    const emitter = new AEPEmitter({ run_id: "run-drift-002" });
    emitter.addAction({
      tool_name: "safe_tool",
      state_changing: false,
      argument_drift: {
        detected: false,
        approved_args_digest: "sha256:same",
        observed_args_digest: "sha256:same",
        resolution: "matched",
      },
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.argument_drift?.detected).toBe(false);
    expect(record.actions[0]?.argument_drift?.resolution).toBe("matched");
  });

  it("argument_drift is optional and defaults to undefined", () => {
    const emitter = new AEPEmitter({ run_id: "run-drift-003" });
    emitter.addAction({ tool_name: "noop", state_changing: false });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.argument_drift).toBeUndefined();
  });

  it("argument_drift schema validation rejects invalid resolution", () => {
    const raw = {
      schema_version: "aep/v0.3",
      run_id: "run-drift-bad",
      created_at_ms: 1_700_000_000_000,
      actions: [
        {
          action_id: "action-0",
          tool_name: "tool",
          state_changing: true,
          timestamp_ms: 1_700_000_000_000,
          argument_drift: {
            detected: true,
            approved_args_digest: "sha256:a",
            observed_args_digest: "sha256:b",
            resolution: "invalid_value",
          },
        },
      ],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };
    const result = AEPRecordSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

describe("AEP v0.3 — approval_mode + approval_extension + deny_reason_class (#7 Gap 4)", () => {
  it("approval_mode defaults to 'none' on capability decisions", () => {
    const raw = {
      schema_version: "aep/v0.3",
      run_id: "run-am-001",
      created_at_ms: 1_700_000_000_000,
      capability_decisions: [
        {
          capability: "fs:write",
          subject: "agent",
          resource: "/tmp/out.txt",
          decision: "allow",
        },
      ],
      actions: [],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };
    const result = AEPRecordSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capability_decisions[0]?.approval_mode).toBe("none");
    }
  });

  it("approval_mode accepts all valid enum values", () => {
    const modes = [
      "one-shot-payload",
      "bounded-lease",
      "policy-allow-with-receipt",
      "policy-deny-with-evidence",
      "re-approval-on-drift",
      "none",
    ] as const;
    for (const mode of modes) {
      const raw = {
        schema_version: "aep/v0.3",
        run_id: `run-am-${mode}`,
        created_at_ms: 1_700_000_000_000,
        capability_decisions: [
          {
            capability: "net:egress",
            subject: "agent",
            resource: "https://api.example.com",
            decision: "allow",
            approval_mode: mode,
          },
        ],
        actions: [],
        signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
      };
      const result = AEPRecordSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.capability_decisions[0]?.approval_mode).toBe(mode);
      }
    }
  });

  it("approval_extension is accepted when present", () => {
    const raw = {
      schema_version: "aep/v0.3",
      run_id: "run-ae-001",
      created_at_ms: 1_700_000_000_000,
      capability_decisions: [
        {
          capability: "fs:write",
          subject: "agent",
          resource: "/tmp/out.txt",
          decision: "allow",
          approval_mode: "bounded-lease",
          approval_extension: {
            namespace: "custom-policy",
            mode: "time-bounded",
            evidence_digest: "sha256:ext-evidence",
          },
        },
      ],
      actions: [],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };
    const result = AEPRecordSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      const ext = result.data.capability_decisions[0]?.approval_extension;
      expect(ext?.namespace).toBe("custom-policy");
      expect(ext?.mode).toBe("time-bounded");
      expect(ext?.evidence_digest).toBe("sha256:ext-evidence");
    }
  });

  it("deny_reason_class is optional and accepts valid values", () => {
    const classes = [
      "tool-identity",
      "argument",
      "tainted-input",
      "resource-scope",
      "missing-delegation",
      "policy-rule",
      "other",
    ] as const;
    for (const cls of classes) {
      const raw = {
        schema_version: "aep/v0.3",
        run_id: `run-drc-${cls}`,
        created_at_ms: 1_700_000_000_000,
        capability_decisions: [
          {
            capability: "fs:delete",
            subject: "agent",
            resource: "/",
            decision: "deny",
            deny_reason_class: cls,
          },
        ],
        actions: [],
        signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
      };
      const result = AEPRecordSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.capability_decisions[0]?.deny_reason_class).toBe(cls);
      }
    }
  });

  it("deny_reason_class rejects invalid values", () => {
    const raw = {
      schema_version: "aep/v0.3",
      run_id: "run-drc-bad",
      created_at_ms: 1_700_000_000_000,
      capability_decisions: [
        {
          capability: "fs:delete",
          subject: "agent",
          resource: "/",
          decision: "deny",
          deny_reason_class: "not-a-valid-class",
        },
      ],
      actions: [],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };
    const result = AEPRecordSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

describe("AEP v0.3 — schema_version", () => {
  it("emitter writes schema_version 'aep/v0.3' by default", () => {
    const emitter = new AEPEmitter({ run_id: "run-sv-001" });
    emitter.addAction({ tool_name: "noop", state_changing: false });
    const record = emitter.build(1_700_000_000_000);
    expect(record.schema_version).toBe("aep/v0.3");
  });

  it("schema accepts 'aep/v0.1', 'aep/v0.2', and 'aep/v0.3'", () => {
    for (const ver of ["aep/v0.1", "aep/v0.2", "aep/v0.3"] as const) {
      const raw = {
        schema_version: ver,
        run_id: `run-ver-${ver}`,
        created_at_ms: 1_700_000_000_000,
        signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
      };
      const result = AEPRecordSchema.safeParse(raw);
      expect(result.success).toBe(true);
    }
  });
});

describe("AEPEmitter.withDefaults factory (#47)", () => {
  it("creates emitters with shared defaults", () => {
    const factory = AEPEmitter.withDefaults({
      model_id: "claude-sonnet-4-6",
      model_provider: "anthropic",
      recordingMode: "full",
    });

    const emitter1 = factory.create({ run_id: "run-factory-001" });
    emitter1.addAction({ tool_name: "read_file", state_changing: false });
    const record1 = emitter1.build(1_700_000_000_000);

    expect(record1.model_id).toBe("claude-sonnet-4-6");
    expect(record1.actions[0]?.recording_mode).toBe("full");
    expect(record1.run_id).toBe("run-factory-001");
  });

  it("overrides defaults per-instance", () => {
    const factory = AEPEmitter.withDefaults({
      model_id: "claude-sonnet-4-6",
      model_provider: "anthropic",
    });

    const emitter = factory.create({
      run_id: "run-factory-002",
      model_id: "gpt-4o",
    });
    emitter.addAction({ tool_name: "noop", state_changing: false });
    const record = emitter.build(1_700_000_000_000);

    expect(record.model_id).toBe("gpt-4o");
    expect(record.run_id).toBe("run-factory-002");
  });
});

describe("addCapabilityDecision dedup (#83)", () => {
  it("does not duplicate when addAction and addCapabilityDecision provide the same decision", () => {
    const emitter = new AEPEmitter({ run_id: "run-dedup-001" });
    const cd = {
      capability: "fs:write",
      subject: "agent",
      resource: "/tmp/output.txt",
      decision: "allow" as const,
      reason_code: "policy-default",
    };

    emitter.addAction({
      tool_name: "write_file",
      state_changing: true,
      capability_decision: cd,
    });

    emitter.addCapabilityDecision(cd);

    const record = emitter.build(1_700_000_000_000);
    expect(record.capability_decisions.length).toBe(1);
  });

  it("does not duplicate when addCapabilityDecision is called twice with the same decision", () => {
    const emitter = new AEPEmitter({ run_id: "run-dedup-002" });
    const cd = {
      capability: "net:egress",
      subject: "agent",
      resource: "https://api.example.com",
      decision: "allow" as const,
    };

    emitter.addCapabilityDecision(cd);
    emitter.addCapabilityDecision(cd);

    const record = emitter.build(1_700_000_000_000);
    expect(record.capability_decisions.length).toBe(1);
  });
});

describe("resolveRepoCommit (#48)", () => {
  it("returns env var value when set", async () => {
    const orig = process.env.AEP_REPO_COMMIT;
    process.env.AEP_REPO_COMMIT = "abc123def456";
    try {
      const result = await resolveRepoCommit();
      expect(result).toBe("abc123def456");
    } finally {
      if (orig === undefined) {
        delete process.env.AEP_REPO_COMMIT;
      } else {
        process.env.AEP_REPO_COMMIT = orig;
      }
    }
  });

  it("returns a custom env var when specified", async () => {
    const orig = process.env.MY_COMMIT;
    process.env.MY_COMMIT = "custom-sha";
    try {
      const result = await resolveRepoCommit({ envVar: "MY_COMMIT" });
      expect(result).toBe("custom-sha");
    } finally {
      if (orig === undefined) {
        delete process.env.MY_COMMIT;
      } else {
        process.env.MY_COMMIT = orig;
      }
    }
  });

  it("falls back to git rev-parse HEAD in a git repo", async () => {
    const orig = process.env.AEP_REPO_COMMIT;
    delete process.env.AEP_REPO_COMMIT;
    try {
      const result = await resolveRepoCommit({ cwd: process.cwd() });
      // Should be a 40-char hex SHA in a git repo
      expect(result).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      if (orig !== undefined) {
        process.env.AEP_REPO_COMMIT = orig;
      }
    }
  });

  it("falls back to package.json version when not in a git repo", async () => {
    const orig = process.env.AEP_REPO_COMMIT;
    delete process.env.AEP_REPO_COMMIT;
    try {
      // Use /tmp which is not a git repo but has no package.json either
      const result = await resolveRepoCommit({ cwd: "/tmp", fallbackToVersion: true });
      // Should be "unknown" since /tmp has no package.json
      expect(result).toBe("unknown");
    } finally {
      if (orig !== undefined) {
        process.env.AEP_REPO_COMMIT = orig;
      }
    }
  });

  it("returns 'unknown' when all strategies fail", async () => {
    const orig = process.env.AEP_REPO_COMMIT;
    delete process.env.AEP_REPO_COMMIT;
    try {
      const result = await resolveRepoCommit({
        cwd: "/tmp",
        fallbackToVersion: false,
      });
      expect(result).toBe("unknown");
    } finally {
      if (orig !== undefined) {
        process.env.AEP_REPO_COMMIT = orig;
      }
    }
  });
});

describe("Inter-record hash chain (#40)", () => {
  const TEST_SEED_CHAIN = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const TEST_KEY_ID_CHAIN = "test-chain-key-01";

  it("emit 3 records sequentially — verifyAEPChain returns { valid: true }", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED_CHAIN, TEST_KEY_ID_CHAIN);
    const emitter = new AEPEmitter({ run_id: "run-chain-001", signer });

    emitter.addAction({ tool_name: "read_file", state_changing: false });
    const r1 = await emitter.emit(1_700_000_000_000);

    emitter.addAction({ tool_name: "write_file", state_changing: true });
    const r2 = await emitter.emit(1_700_000_001_000);

    emitter.addAction({ tool_name: "deploy", state_changing: true });
    const r3 = await emitter.emit(1_700_000_002_000);

    // First record should have null prev_record_hash
    expect(r1.prev_record_hash).toBeNull();
    // Subsequent records should have a prev_record_hash
    expect(r2.prev_record_hash).toBeDefined();
    expect(typeof r2.prev_record_hash).toBe("string");
    expect(r3.prev_record_hash).toBeDefined();
    expect(typeof r3.prev_record_hash).toBe("string");

    const result = verifyAEPChain([r1, r2, r3]);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it("delete middle record from sequence — verifyAEPChain returns broken", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED_CHAIN, TEST_KEY_ID_CHAIN);
    const emitter = new AEPEmitter({ run_id: "run-chain-002", signer });

    emitter.addAction({ tool_name: "read_file", state_changing: false });
    const r1 = await emitter.emit(1_700_000_000_000);

    emitter.addAction({ tool_name: "write_file", state_changing: true });
    await emitter.emit(1_700_000_001_000); // r2 — will be deleted

    emitter.addAction({ tool_name: "deploy", state_changing: true });
    const r3 = await emitter.emit(1_700_000_002_000);

    // Skip r2: chain is [r1, r3] — r3's prev_record_hash points to r2, not r1
    const result = verifyAEPChain([r1, r3]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it("existing single-record verifyAEPRecord still works (backward compat)", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED_CHAIN, TEST_KEY_ID_CHAIN);
    const emitter = new AEPEmitter({ run_id: "run-chain-003", signer });

    emitter.addAction({ tool_name: "bash", state_changing: false });
    const record = await emitter.emit(1_700_000_000_000);

    const publicKey = await signer.getPublicKey();
    const valid = await verifyAEPRecord(record, publicKey);
    expect(valid).toBe(true);
  });

  it("records without prev_record_hash pass chain verification", () => {
    // Simulate legacy records that lack prev_record_hash
    const legacyRecords = [
      {
        schema_version: "aep/v0.3" as const,
        run_id: "run-legacy-001",
        created_at_ms: 1_700_000_000_000,
        input_refs: [],
        output_refs: [],
        capability_decisions: [],
        actions: [],
        verifier_results: [],
        signature: { alg: "ed25519" as const, key_id: "k1", sig: "dGVzdA==" },
      },
      {
        schema_version: "aep/v0.3" as const,
        run_id: "run-legacy-002",
        created_at_ms: 1_700_000_001_000,
        input_refs: [],
        output_refs: [],
        capability_decisions: [],
        actions: [],
        verifier_results: [],
        signature: { alg: "ed25519" as const, key_id: "k1", sig: "dGVzdA==" },
        // no prev_record_hash
      },
    ];

    const result = verifyAEPChain(legacyRecords as any);
    expect(result.valid).toBe(true);
  });

  it("prev_record_hash is a 64-char hex string (SHA-256)", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED_CHAIN, TEST_KEY_ID_CHAIN);
    const emitter = new AEPEmitter({ run_id: "run-chain-hex", signer });

    emitter.addAction({ tool_name: "noop", state_changing: false });
    await emitter.emit(1_700_000_000_000);

    emitter.addAction({ tool_name: "noop2", state_changing: false });
    const r2 = await emitter.emit(1_700_000_001_000);

    expect(r2.prev_record_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("AEPTimestamper — LocalTimestamper (#42)", () => {
  it("LocalTimestamper produces a valid TimestampProof", async () => {
    const ts = new LocalTimestamper("test-tsa");
    const bytes = new TextEncoder().encode("test record payload");
    const proof = await ts.timestamp(bytes);

    expect(proof.authority).toBe("test-tsa");
    expect(proof.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof proof.proof).toBe("string");
    expect(proof.proof.length).toBeGreaterThan(0);
    expect(proof.logIndex).toBeUndefined();
  });

  it("LocalTimestamper uses default authorityId when not specified", async () => {
    const ts = new LocalTimestamper();
    expect(ts.authorityId).toBe("local-dev-tsa");
    const bytes = new TextEncoder().encode("data");
    const proof = await ts.timestamp(bytes);
    expect(proof.authority).toBe("local-dev-tsa");
  });

  it("AEPEmitter with timestamper attaches timestamp_proof to emitted records", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const timestamper = new LocalTimestamper("ci-tsa");
    const emitter = new AEPEmitter({
      run_id: "run-ts-001",
      signer,
      timestamper,
    });

    emitter.addAction({ tool_name: "write_file", state_changing: true });
    const record = await emitter.emit(1_700_000_000_000);

    expect(record.timestamp_proof).toBeDefined();
    expect(record.timestamp_proof?.authority).toBe("ci-tsa");
    expect(record.timestamp_proof?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof record.timestamp_proof?.proof).toBe("string");
    expect(record.timestamp_proof?.proof.length).toBeGreaterThan(0);
  });

  it("AEPEmitter without timestamper does not attach timestamp_proof (backwards compat)", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-ts-002",
      signer,
    });

    emitter.addAction({ tool_name: "read_file", state_changing: false });
    const record = await emitter.emit(1_700_000_000_000);

    expect(record.timestamp_proof).toBeUndefined();
  });

  it("timestamp_proof field passes schema validation", () => {
    const raw = {
      schema_version: "aep/v0.3",
      run_id: "run-ts-schema",
      created_at_ms: 1_700_000_000_000,
      actions: [],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
      timestamp_proof: {
        timestamp: "2024-01-15T12:00:00.000Z",
        authority: "rfc3161-tsa",
        proof: "base64encodedproof==",
        logIndex: 42,
      },
    };
    const result = AEPRecordSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timestamp_proof?.authority).toBe("rfc3161-tsa");
      expect(result.data.timestamp_proof?.logIndex).toBe(42);
    }
  });
});
