import { describe, expect, it } from "bun:test";
import { AEPEmitter } from "./emitter.js";
import { createLocalSignerFromSeed } from "./signer.js";
import { AEPRecordSchema } from "./types.js";
import { isStateChangingTool, STATE_CHANGING_PATTERNS } from "./utils.js";
import { verifyAEPRecord } from "./verify.js";

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

    expect(record.schema_version).toBe("aep/v0.2");
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
    // Regression coverage for the run-provenance traceability fields documented
    // in README §"Compliance fields for run-provenance traceability". The
    // constructor already accepts these four optional fields — this test pins
    // the transport from AEPEmitterOptions → AEPRecord so a future refactor
    // can't silently drop them.
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

    // Both build() and emit() must carry the four fields through.
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

    // And tampering with any of them must invalidate the signature — the
    // README explicitly states these fields are part of the signed payload.
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
      schema_version: "aep/v0.2",
      run_id: "run-nosig",
      created_at_ms: 1_700_000_000_000,
      input_refs: [],
      output_refs: [],
      capability_decisions: [],
      actions: [],
      verifier_results: [],
      // signature intentionally omitted
    };

    const result = AEPRecordSchema.safeParse(recordWithoutSig);
    expect(result.success).toBe(false);
  });

  it("schema parse fails when signature.alg is not 'ed25519'", () => {
    const recordBadAlg = {
      schema_version: "aep/v0.2",
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
      schema_version: "aep/v0.2",
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
      schema_version: "aep/v0.2",
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
      schema_version: "aep/v0.2",
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
      schema_version: "aep/v0.2",
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
