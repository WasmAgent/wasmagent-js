import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paeEncode, verifyDSSEEnvelope, wrapInTotoStatement } from "./dsse.js";
import { AEPEmitter } from "./emitter.js";
import { FilesystemEvidenceStore, InMemoryEvidenceStore } from "./evidenceStore.js";
import {
  buildEvidenceBundle,
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  parseEvidenceBundle,
  serializeEvidenceBundle,
  verifyEvidenceBundle,
} from "./exportAdapter.js";
import { resolveRepoCommit } from "./resolve-repo-commit.js";
import { createLocalSignerFromSeed } from "./signer.js";
import { LocalTimestamper } from "./timestamperLocal.js";
import type { AEPRecord, SideEffectClass } from "./types.js";
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

    emitter.addAction({ tool_name: "noop", state_changing: false });
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

    emitter.addAction({ tool_name: "noop", state_changing: false });
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
    emitter.addAction({ tool_name: "noop", state_changing: false });
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

describe("AEPEmitter.addAction() — tool outcome capture (#163)", () => {
  it("captures outcome on an action and round-trips it through build()", () => {
    const emitter = new AEPEmitter({ run_id: "run-outcome-001" });
    emitter.addAction({
      tool_name: "bash",
      state_changing: false,
      outcome: "success",
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.tool_name).toBe("bash");
    expect(record.actions[0]?.outcome).toBe("success");
  });

  it("captures exit_code for both success (0) and failure (non-zero)", () => {
    const emitter = new AEPEmitter({ run_id: "run-exit-001" });
    emitter.addAction({
      tool_name: "bash",
      state_changing: false,
      outcome: "success",
      exit_code: 0,
    });
    emitter.addAction({
      tool_name: "bash",
      state_changing: false,
      outcome: "error",
      exit_code: 127,
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.exit_code).toBe(0);
    expect(record.actions[1]?.exit_code).toBe(127);
  });

  it("captures arguments_digest (hash of the tool call arguments)", () => {
    const emitter = new AEPEmitter({ run_id: "run-argdigest-001" });
    const argsDigest = AEPEmitter.digestContent(JSON.stringify({ path: "/tmp/x", mode: "w" }));
    emitter.addAction({
      tool_name: "write_file",
      state_changing: true,
      arguments_digest: argsDigest,
    });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.arguments_digest).toBe(argsDigest);
    expect(record.actions[0]?.arguments_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("captures the full bullet set — tool name, outcome, exit code, arguments hash, result hash", () => {
    const emitter = new AEPEmitter({ run_id: "run-full-capture-001" });
    const argsDigest = AEPEmitter.digestContent(JSON.stringify({ command: "npm run build" }));
    const resultDigest = AEPEmitter.digestContent("build output bytes");
    emitter.addAction({
      tool_name: "bash",
      state_changing: true,
      outcome: "success",
      exit_code: 0,
      arguments_digest: argsDigest,
      result_digest: resultDigest,
    });
    const record = emitter.build(1_700_000_000_000);
    const action = record.actions[0];
    expect(action?.tool_name).toBe("bash");
    expect(action?.outcome).toBe("success");
    expect(action?.exit_code).toBe(0);
    expect(action?.arguments_digest).toBe(argsDigest);
    expect(action?.result_digest).toBe(resultDigest);
  });

  it("outcome, exit_code, and arguments_digest are optional and backwards compatible", () => {
    const emitter = new AEPEmitter({ run_id: "run-optional-001" });
    emitter.addAction({ tool_name: "noop", state_changing: false });
    const record = emitter.build(1_700_000_000_000);
    expect(record.actions[0]?.outcome).toBeUndefined();
    expect(record.actions[0]?.exit_code).toBeUndefined();
    expect(record.actions[0]?.arguments_digest).toBeUndefined();
  });

  it("schema validation accepts an action with outcome, exit_code, and arguments_digest", () => {
    const raw = {
      schema_version: "aep/v0.3",
      run_id: "run-schema-outcome",
      created_at_ms: 1_700_000_000_000,
      actions: [
        {
          action_id: "action-0",
          tool_name: "bash",
          state_changing: true,
          timestamp_ms: 1_700_000_000_000,
          outcome: "error",
          exit_code: 2,
          arguments_digest: "a".repeat(64),
          result_digest: "b".repeat(64),
        },
      ],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };
    const result = AEPRecordSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actions[0]?.outcome).toBe("error");
      expect(result.data.actions[0]?.exit_code).toBe(2);
      expect(result.data.actions[0]?.arguments_digest).toBe("a".repeat(64));
    }
  });

  it("schema validation rejects a non-integer exit_code", () => {
    const raw = {
      schema_version: "aep/v0.3",
      run_id: "run-schema-bad-exit",
      created_at_ms: 1_700_000_000_000,
      actions: [
        {
          action_id: "action-0",
          tool_name: "bash",
          state_changing: true,
          timestamp_ms: 1_700_000_000_000,
          exit_code: 1.5,
        },
      ],
      signature: { alg: "ed25519", key_id: "k1", sig: "dGVzdA==" },
    };
    const result = AEPRecordSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it("captured fields are included in the signed record and verified (tamper detection)", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({ run_id: "run-sign-outcome", signer });
    emitter.addAction({
      tool_name: "bash",
      state_changing: false,
      outcome: "success",
      exit_code: 0,
      arguments_digest: "c".repeat(64),
    });
    const record = await emitter.emit(1_700_000_000_000);

    const publicKey = await signer.getPublicKey();
    expect(await verifyAEPRecord(record, publicKey)).toBe(true);

    // Tampering with a captured field must invalidate the signature
    const tampered = {
      ...record,
      actions: [{ ...record.actions[0]!, exit_code: 1 }],
    };
    expect(await verifyAEPRecord(tampered as any, publicKey)).toBe(false);
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

describe("verifyAEPRecord — Promise detection (#91)", () => {
  it("throws TypeError when passed a Promise instead of AEPRecord", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({ run_id: "run-promise-detect", signer });
    emitter.addAction({ tool_name: "noop", state_changing: false });

    const promise = emitter.emit(1_700_000_000_000);
    const publicKey = await signer.getPublicKey();

    // Pass the unawaited promise — should throw TypeError
    await expect(verifyAEPRecord(promise as any, publicKey)).rejects.toThrow(TypeError);
    await expect(verifyAEPRecord(promise as any, publicKey)).rejects.toThrow(
      "Did you forget to await"
    );

    // Clean up — actually await the promise
    await promise;
  });
});

describe("verifyAEPChain — Promise detection (#91)", () => {
  it("throws TypeError when passed a Promise instead of AEPRecord[]", () => {
    const promise = Promise.resolve([]);
    expect(() => verifyAEPChain(promise as any)).toThrow(TypeError);
    expect(() => verifyAEPChain(promise as any)).toThrow("Did you forget to await");
  });
});

describe("AEPEmitter.emit() — empty actions validation (#95)", () => {
  it("throws when emit() is called with no actions recorded", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({ run_id: "run-empty-001", signer });

    await expect(emitter.emit(1_700_000_000_000)).rejects.toThrow(
      "AEPEmitter.emit() called with no actions recorded"
    );
  });

  it("does not throw when allowEmptyActions is true", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-empty-002",
      signer,
      allowEmptyActions: true,
    });

    const record = await emitter.emit(1_700_000_000_000);
    expect(record.actions).toHaveLength(0);
    expect(record.schema_version).toBe("aep/v0.3");
  });

  it("does not throw when actions have been added", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({ run_id: "run-empty-003", signer });
    emitter.addAction({ tool_name: "read_file", state_changing: false });

    const record = await emitter.emit(1_700_000_000_000);
    expect(record.actions).toHaveLength(1);
  });
});

describe("DSSE/in-toto attestation envelope (v0.4) (#27)", () => {
  it("paeEncode produces correct Pre-Authentication Encoding", () => {
    const result = paeEncode("application/vnd.in-toto+json", "test-payload");
    const decoded = new TextDecoder().decode(result);
    // PAE = "DSSEv1" + SP + len(type) + SP + type + SP + len(body) + SP + body
    const typeLen = new TextEncoder().encode("application/vnd.in-toto+json").length;
    const payloadLen = new TextEncoder().encode("test-payload").length;
    expect(decoded).toBe(
      `DSSEv1 ${typeLen} application/vnd.in-toto+json ${payloadLen} test-payload`
    );
  });

  it("paeEncode handles empty strings", () => {
    const result = paeEncode("", "");
    const decoded = new TextDecoder().decode(result);
    expect(decoded).toBe("DSSEv1 0  0 ");
  });

  it("wrapInTotoStatement produces valid in-toto Statement shape", () => {
    const record = { run_id: "run-001", created_at_ms: 1700000000000 };
    const statement = wrapInTotoStatement(record, "run-001", "abcdef1234567890");
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.subject).toHaveLength(1);
    expect(statement.subject[0]?.name).toBe("urn:wasmagent:run:run-001");
    expect(statement.subject[0]?.digest).toEqual({ sha256: "abcdef1234567890" });
    expect(statement.predicateType).toBe("https://wasmagent.dev/attestations/aep/v0.4");
    expect(statement.predicate).toEqual(record);
  });

  it("AEPEmitter with useDsse: true produces record with dsse_envelope and schema_version aep/v0.4", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-dsse-001",
      signer,
      useDsse: true,
    });

    emitter.addAction({ tool_name: "write_file", state_changing: true });
    const record = await emitter.emit(1_700_000_000_000);

    expect(record.schema_version).toBe("aep/v0.4");
    expect(record.dsse_envelope).toBeDefined();
    expect(record.dsse_envelope?.payloadType).toBe("application/vnd.in-toto+json");
    expect(record.dsse_envelope?.payload).toBeDefined();
    expect(record.dsse_envelope?.signatures).toHaveLength(1);
    expect(record.dsse_envelope?.signatures[0]?.keyid).toBe(TEST_KEY_ID);
    expect(typeof record.dsse_envelope?.signatures[0]?.sig).toBe("string");
  });

  it("verifyDSSEEnvelope verifies a valid envelope", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-dsse-verify-001",
      signer,
      useDsse: true,
    });

    emitter.addAction({ tool_name: "bash", state_changing: false });
    const record = await emitter.emit(1_700_000_000_000);

    const publicKey = await signer.getPublicKey();
    const valid = await verifyDSSEEnvelope(record.dsse_envelope!, publicKey);
    expect(valid).toBe(true);
  });

  it("verifyDSSEEnvelope rejects tampered payload", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-dsse-tamper-001",
      signer,
      useDsse: true,
    });

    emitter.addAction({ tool_name: "bash", state_changing: false });
    const record = await emitter.emit(1_700_000_000_000);

    const publicKey = await signer.getPublicKey();
    // Tamper with the payload
    const tampered = {
      ...record.dsse_envelope!,
      payload: Buffer.from("tampered-content").toString("base64"),
    };
    const valid = await verifyDSSEEnvelope(tampered, publicKey);
    expect(valid).toBe(false);
  });

  it("verifyAEPRecord works for DSSE records (v0.4)", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-dsse-full-verify",
      signer,
      useDsse: true,
    });

    emitter.addAction({ tool_name: "deploy", state_changing: true });
    const record = await emitter.emit(1_700_000_000_000);

    const publicKey = await signer.getPublicKey();
    const valid = await verifyAEPRecord(record, publicKey);
    expect(valid).toBe(true);
  });

  it("verifyAEPRecord still works for legacy records (backward compat)", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-dsse-legacy-compat",
      signer,
      useDsse: false,
    });

    emitter.addAction({ tool_name: "noop", state_changing: false });
    const record = await emitter.emit(1_700_000_000_000);

    expect(record.schema_version).toBe("aep/v0.3");
    expect(record.dsse_envelope).toBeUndefined();

    const publicKey = await signer.getPublicKey();
    const valid = await verifyAEPRecord(record, publicKey);
    expect(valid).toBe(true);
  });

  it("legacy signature field is still populated for backward compat in DSSE records", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-dsse-legacy-sig",
      signer,
      useDsse: true,
    });

    emitter.addAction({ tool_name: "write_file", state_changing: true });
    const record = await emitter.emit(1_700_000_000_000);

    expect(record.signature).toBeDefined();
    expect(record.signature.alg).toBe("ed25519");
    expect(record.signature.key_id).toBe(TEST_KEY_ID);
    expect(record.signature.sig.length).toBeGreaterThan(0);
    // The legacy sig should match the DSSE envelope sig
    expect(record.signature.sig).toBe(record.dsse_envelope?.signatures[0]?.sig);
  });

  it("DSSE envelope payload decodes to a valid in-toto Statement", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-dsse-decode-001",
      signer,
      useDsse: true,
    });

    emitter.addAction({ tool_name: "read_file", state_changing: false });
    const record = await emitter.emit(1_700_000_000_000);

    const payloadJson = Buffer.from(record.dsse_envelope!.payload, "base64").toString("utf-8");
    const statement = JSON.parse(payloadJson);
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.subject).toHaveLength(1);
    expect(statement.subject[0].name).toBe("urn:wasmagent:run:run-dsse-decode-001");
    expect(statement.predicateType).toBe("https://wasmagent.dev/attestations/aep/v0.4");
    expect(statement.predicate.run_id).toBe("run-dsse-decode-001");
  });

  it("schema accepts aep/v0.4 with dsse_envelope", () => {
    const raw = {
      schema_version: "aep/v0.4",
      run_id: "run-v04-schema",
      created_at_ms: 1_700_000_000_000,
      input_refs: [],
      output_refs: [],
      capability_decisions: [],
      actions: [],
      verifier_results: [],
      dsse_envelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: "dGVzdA==",
        signatures: [{ keyid: "k1", sig: "c2ln" }],
      },
      signature: { alg: "ed25519", key_id: "k1", sig: "c2ln" },
    };
    const result = AEPRecordSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema_version).toBe("aep/v0.4");
      expect(result.data.dsse_envelope).toBeDefined();
    }
  });

  it("verifyDSSEEnvelope returns false for empty signatures", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const publicKey = await signer.getPublicKey();
    const envelope = {
      payloadType: "application/vnd.in-toto+json",
      payload: "dGVzdA==",
      signatures: [],
    };
    const valid = await verifyDSSEEnvelope(envelope, publicKey);
    expect(valid).toBe(false);
  });

  it("DSSE records work with hash chain verification", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-dsse-chain",
      signer,
      useDsse: true,
    });

    emitter.addAction({ tool_name: "read_file", state_changing: false });
    const r1 = await emitter.emit(1_700_000_000_000);

    emitter.addAction({ tool_name: "write_file", state_changing: true });
    const r2 = await emitter.emit(1_700_000_001_000);

    expect(r1.prev_record_hash).toBeNull();
    expect(r2.prev_record_hash).toBeDefined();
    expect(typeof r2.prev_record_hash).toBe("string");

    const result = verifyAEPChain([r1, r2]);
    expect(result.valid).toBe(true);
  });
});

describe("InMemoryEvidenceStore", () => {
  async function makeRecord(
    overrides: {
      run_id?: string;
      model_id?: string;
      created_at_ms?: number;
      tool_name?: string;
      side_effect_class?: SideEffectClass;
    } = {}
  ): Promise<AEPRecord> {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: overrides.run_id ?? "run-default",
      model_id: overrides.model_id,
      signer,
    });
    emitter.addAction({
      tool_name: overrides.tool_name ?? "default_tool",
      state_changing: false,
      side_effect_class: overrides.side_effect_class ?? "read",
    });
    return emitter.emit(overrides.created_at_ms ?? 1_700_000_000_000);
  }

  it("append and size work correctly", async () => {
    const store = new InMemoryEvidenceStore();
    expect(store.size()).toBe(0);

    const r1 = await makeRecord();
    store.append(r1);
    expect(store.size()).toBe(1);

    const r2 = await makeRecord({ run_id: "run-other" });
    store.append(r2);
    expect(store.size()).toBe(2);
  });

  it("query with no filter returns all records", async () => {
    const store = new InMemoryEvidenceStore();
    store.append(await makeRecord({ run_id: "run-a" }));
    store.append(await makeRecord({ run_id: "run-b" }));

    const results = store.query();
    expect(results).toHaveLength(2);
  });

  it("query by run_id", async () => {
    const store = new InMemoryEvidenceStore();
    store.append(await makeRecord({ run_id: "run-alpha" }));
    store.append(await makeRecord({ run_id: "run-beta" }));
    store.append(await makeRecord({ run_id: "run-alpha" }));

    const results = store.query({ run_id: "run-alpha" });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.run_id).toBe("run-alpha");
    }
  });

  it("getByRunId is a shorthand for query by run_id", async () => {
    const store = new InMemoryEvidenceStore();
    store.append(await makeRecord({ run_id: "run-x" }));
    store.append(await makeRecord({ run_id: "run-y" }));
    store.append(await makeRecord({ run_id: "run-x" }));

    expect(store.getByRunId("run-x")).toHaveLength(2);
    expect(store.getByRunId("run-y")).toHaveLength(1);
    expect(store.getByRunId("nonexistent")).toHaveLength(0);
  });

  it("query by model_id", async () => {
    const store = new InMemoryEvidenceStore();
    store.append(await makeRecord({ model_id: "claude-sonnet-5" }));
    store.append(await makeRecord({ model_id: "gpt-4o" }));
    store.append(await makeRecord()); // no model_id

    const results = store.query({ model_id: "claude-sonnet-5" });
    expect(results).toHaveLength(1);
    expect(results[0]!.model_id).toBe("claude-sonnet-5");
  });

  it("query by time range (created_after_ms and created_before_ms)", async () => {
    const store = new InMemoryEvidenceStore();
    store.append(await makeRecord({ created_at_ms: 100 }));
    store.append(await makeRecord({ created_at_ms: 200 }));
    store.append(await makeRecord({ created_at_ms: 300 }));
    store.append(await makeRecord({ created_at_ms: 400 }));

    // Only after 200 (inclusive)
    expect(store.query({ created_after_ms: 200 })).toHaveLength(3);
    // Only before 300 (inclusive)
    expect(store.query({ created_before_ms: 300 })).toHaveLength(3);
    // Range [200, 300]
    expect(store.query({ created_after_ms: 200, created_before_ms: 300 })).toHaveLength(2);
  });

  it("query by action_type (side_effect_class)", async () => {
    const store = new InMemoryEvidenceStore();
    store.append(await makeRecord({ tool_name: "read_file", side_effect_class: "read" }));
    store.append(await makeRecord({ tool_name: "write_file", side_effect_class: "mutate-local" }));
    store.append(await makeRecord({ tool_name: "http_call", side_effect_class: "network-egress" }));

    const mutateResults = store.query({ action_type: "mutate-local" });
    expect(mutateResults).toHaveLength(1);
    expect(mutateResults[0]!.actions[0]!.tool_name).toBe("write_file");

    const readResults = store.query({ action_type: "read" });
    expect(readResults).toHaveLength(1);
  });

  it("query by tool_name", async () => {
    const store = new InMemoryEvidenceStore();
    store.append(await makeRecord({ tool_name: "bash" }));
    store.append(await makeRecord({ tool_name: "read_file" }));
    store.append(await makeRecord({ tool_name: "bash" }));

    const results = store.query({ tool_name: "bash" });
    expect(results).toHaveLength(2);
  });

  it("combines multiple filters with AND logic", async () => {
    const store = new InMemoryEvidenceStore();
    store.append(
      await makeRecord({
        run_id: "run-1",
        model_id: "claude-sonnet-5",
        tool_name: "bash",
        side_effect_class: "mutate-local",
        created_at_ms: 100,
      })
    );
    store.append(
      await makeRecord({
        run_id: "run-1",
        model_id: "gpt-4o",
        tool_name: "bash",
        side_effect_class: "mutate-local",
        created_at_ms: 200,
      })
    );
    store.append(
      await makeRecord({
        run_id: "run-2",
        model_id: "claude-sonnet-5",
        tool_name: "read_file",
        side_effect_class: "read",
        created_at_ms: 300,
      })
    );

    // run_id + model_id
    expect(store.query({ run_id: "run-1", model_id: "claude-sonnet-5" })).toHaveLength(1);
    // run_id + time range
    expect(store.query({ run_id: "run-1", created_before_ms: 150 })).toHaveLength(1);
    // model_id + action_type
    expect(store.query({ model_id: "claude-sonnet-5", action_type: "mutate-local" })).toHaveLength(
      1
    );
    // tool_name + action_type
    expect(store.query({ tool_name: "bash", action_type: "mutate-local" })).toHaveLength(2);
    // All filters -> no match
    expect(
      store.query({
        run_id: "run-2",
        model_id: "claude-sonnet-5",
        action_type: "mutate-local",
      })
    ).toHaveLength(0);
  });

  it("returns a copy from query, mutations do not affect the store", async () => {
    const store = new InMemoryEvidenceStore();
    store.append(await makeRecord());

    const results = store.query();
    expect(results).toHaveLength(1);
    results.pop();
    expect(store.size()).toBe(1);
  });

  it("action_type filter matches records with multiple actions", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({ run_id: "run-multi", signer });
    emitter.addAction({ tool_name: "read_file", state_changing: false, side_effect_class: "read" });
    emitter.addAction({
      tool_name: "write_file",
      state_changing: true,
      side_effect_class: "mutate-local",
    });
    const record = await emitter.emit();

    const store = new InMemoryEvidenceStore();
    store.append(record);

    // Should match because one action has side_effect_class "read"
    expect(store.query({ action_type: "read" })).toHaveLength(1);
    // Should also match because one action has side_effect_class "mutate-local"
    expect(store.query({ action_type: "mutate-local" })).toHaveLength(1);
    // Should not match
    expect(store.query({ action_type: "network-egress" })).toHaveLength(0);
  });
});

describe("FilesystemEvidenceStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wasmagent-aep-fs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function logPath(): string {
    return join(dir, "evidence.ndjson");
  }

  async function makeRecord(
    overrides: {
      run_id?: string;
      model_id?: string;
      created_at_ms?: number;
      tool_name?: string;
      side_effect_class?: SideEffectClass;
    } = {}
  ): Promise<AEPRecord> {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: overrides.run_id ?? "run-default",
      model_id: overrides.model_id,
      signer,
    });
    emitter.addAction({
      tool_name: overrides.tool_name ?? "default_tool",
      state_changing: false,
      side_effect_class: overrides.side_effect_class ?? "read",
    });
    return emitter.emit(overrides.created_at_ms ?? 1_700_000_000_000);
  }

  it("starts empty when the log file does not exist yet", async () => {
    const store = new FilesystemEvidenceStore(logPath());
    await store.ready();
    expect(await store.size()).toBe(0);
    expect(await store.query()).toHaveLength(0);
    expect(await store.getByRunId("anything")).toHaveLength(0);
  });

  it("append and size work correctly", async () => {
    const store = new FilesystemEvidenceStore(logPath());
    expect(await store.size()).toBe(0);

    await store.append(await makeRecord());
    expect(await store.size()).toBe(1);

    await store.append(await makeRecord({ run_id: "run-other" }));
    expect(await store.size()).toBe(2);
  });

  it("persists records across sessions (durable AEP record persistence)", async () => {
    const filePath = logPath();
    const store1 = new FilesystemEvidenceStore(filePath);
    await store1.append(
      await makeRecord({ run_id: "run-a", model_id: "claude-sonnet-5", created_at_ms: 100 })
    );
    await store1.append(await makeRecord({ run_id: "run-b", created_at_ms: 200 }));

    // Simulate a new process session: a fresh store over the same log file
    // must rehydrate the previously-written records from disk.
    const store2 = new FilesystemEvidenceStore(filePath);
    await store2.ready();
    expect(await store2.size()).toBe(2);

    const all = await store2.query();
    expect(all.map((r) => r.run_id)).toEqual(["run-a", "run-b"]);
    // Records round-trip with full fidelity, signature included.
    expect(all[0]!.model_id).toBe("claude-sonnet-5");
    expect(all[0]!.signature.sig).toBeTruthy();
    expect(all[0]!.signature.key_id).toBe(TEST_KEY_ID);
  });

  it("appends to an existing log across sessions, preserving order", async () => {
    const filePath = logPath();
    const store1 = new FilesystemEvidenceStore(filePath);
    await store1.append(await makeRecord({ run_id: "run-a" }));

    const store2 = new FilesystemEvidenceStore(filePath);
    await store2.ready();
    expect(await store2.size()).toBe(1);
    await store2.append(await makeRecord({ run_id: "run-b" }));
    await store2.append(await makeRecord({ run_id: "run-c" }));

    const store3 = new FilesystemEvidenceStore(filePath);
    await store3.ready();
    expect(await store3.size()).toBe(3);
    expect((await store3.query()).map((r) => r.run_id)).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("query filters behave identically to the in-memory backend", async () => {
    const store = new FilesystemEvidenceStore(logPath());
    await store.append(
      await makeRecord({
        run_id: "run-1",
        model_id: "claude-sonnet-5",
        tool_name: "bash",
        side_effect_class: "mutate-local",
        created_at_ms: 100,
      })
    );
    await store.append(
      await makeRecord({
        run_id: "run-2",
        model_id: "gpt-4o",
        tool_name: "read_file",
        side_effect_class: "read",
        created_at_ms: 200,
      })
    );

    expect(await store.query({ run_id: "run-1" })).toHaveLength(1);
    expect(await store.query({ model_id: "gpt-4o" })).toHaveLength(1);
    expect(await store.query({ created_after_ms: 150 })).toHaveLength(1);
    expect(await store.query({ created_before_ms: 150 })).toHaveLength(1);
    expect(await store.query({ action_type: "read" })).toHaveLength(1);
    expect(await store.query({ tool_name: "bash" })).toHaveLength(1);
    expect(
      await store.query({
        run_id: "run-1",
        model_id: "claude-sonnet-5",
        action_type: "mutate-local",
      })
    ).toHaveLength(1);
    expect(await store.getByRunId("run-1")).toHaveLength(1);
    expect(await store.getByRunId("nope")).toHaveLength(0);
  });

  it("creates parent directories that do not yet exist on first append", async () => {
    const filePath = join(dir, "nested", "deep", "evidence.ndjson");
    const store = new FilesystemEvidenceStore(filePath);
    await store.append(await makeRecord());
    expect(await store.size()).toBe(1);

    // Re-open across sessions to confirm durability with nested paths.
    const store2 = new FilesystemEvidenceStore(filePath);
    await store2.ready();
    expect(await store2.size()).toBe(1);
  });

  it("returns copies from query; mutations do not affect the store", async () => {
    const store = new FilesystemEvidenceStore(logPath());
    await store.append(await makeRecord());

    const results = await store.query();
    expect(results).toHaveLength(1);
    results.pop();
    expect(await store.size()).toBe(1);
  });

  it("serializes concurrent appends without interleaving records", async () => {
    const store = new FilesystemEvidenceStore(logPath());
    // Fire many appends concurrently; the queue must serialize them so each
    // record lands as exactly one intact NDJSON line.
    const records = await Promise.all(
      Array.from({ length: 10 }, (_, i) => makeRecord({ run_id: `run-${i}` }))
    );
    await Promise.all(records.map((r) => store.append(r)));
    expect(await store.size()).toBe(10);

    // Re-open to confirm the on-disk log parses cleanly into 10 records.
    const store2 = new FilesystemEvidenceStore(logPath());
    await store2.ready();
    expect(await store2.size()).toBe(10);
  });

  it("round-tripped records still pass signature verification", async () => {
    const filePath = logPath();
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const publicKey = await signer.getPublicKey();

    const store1 = new FilesystemEvidenceStore(filePath);
    await store1.append(await makeRecord({ run_id: "run-verify" }));

    const store2 = new FilesystemEvidenceStore(filePath);
    await store2.ready();
    const loaded = (await store2.query())[0]!;
    // The signature must still verify against the original public key,
    // proving the filesystem backend does not mutate record contents on
    // the wire.
    expect(await verifyAEPRecord(loaded, publicKey)).toBe(true);
  });

  it("loads an existing NDJSON log written outside the store", async () => {
    const filePath = logPath();
    const r1 = await makeRecord({ run_id: "run-external-1" });
    const r2 = await makeRecord({ run_id: "run-external-2" });
    // Hand-write an NDJSON file the way another process might have.
    writeFileSync(filePath, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`, "utf8");

    const store = new FilesystemEvidenceStore(filePath);
    await store.ready();
    expect(await store.size()).toBe(2);
    expect((await store.query()).map((r) => r.run_id)).toEqual([
      "run-external-1",
      "run-external-2",
    ]);
  });
});

describe("AEPEmitter evidenceStore streaming", () => {
  it("streams emitted record to a configured InMemoryEvidenceStore", async () => {
    const store = new InMemoryEvidenceStore();
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-stream-test",
      signer,
      evidenceStore: store,
    });
    emitter.addAction({
      tool_name: "read_file",
      state_changing: false,
      side_effect_class: "read",
    });
    const record = await emitter.emit(1_700_000_000_000);
    expect(store.size()).toBe(1);
    expect(store.all[0]!.run_id).toBe("run-stream-test");
    // The stored record is the exact same object returned by emit
    expect(store.all[0]).toBe(record);
  });

  it("streams multiple sequential emits preserving insertion order", async () => {
    const store = new InMemoryEvidenceStore();
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-multi-emit",
      signer,
      evidenceStore: store,
    });
    emitter.addAction({
      tool_name: "step_one",
      state_changing: false,
      side_effect_class: "read",
    });
    await emitter.emit(1_700_000_000_000);

    emitter.addAction({
      tool_name: "step_two",
      state_changing: true,
      side_effect_class: "mutate-local",
    });
    await emitter.emit(1_700_000_001_000);

    expect(store.size()).toBe(2);
    // Second emit includes both actions since the emitter accumulates
    expect(store.all.map((r) => r.actions.length)).toEqual([1, 2]);
    expect(store.all[0]!.actions[0]!.tool_name).toBe("step_one");
    expect(store.all[1]!.actions[1]!.tool_name).toBe("step_two");
    // Verify hash chain continuity across stored records
    expect(store.all[1]!.prev_record_hash).not.toBeNull();
  });

  it("does not stream when no evidenceStore is configured", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-no-store",
      signer,
    });
    emitter.addAction({
      tool_name: "read_file",
      state_changing: false,
    });
    const record = await emitter.emit(1_700_000_000_000);
    expect(record.run_id).toBe("run-no-store");
    // No store configured — emit still works fine
    expect(record.signature.sig).toBeTruthy();
  });

  it("streams DSSE-wrapped records to the evidence store", async () => {
    const store = new InMemoryEvidenceStore();
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-dsse-stream",
      signer,
      evidenceStore: store,
      useDsse: true,
    });
    emitter.addAction({
      tool_name: "write_file",
      state_changing: true,
      side_effect_class: "mutate-external",
    });
    const record = await emitter.emit(1_700_000_000_000);
    expect(store.size()).toBe(1);
    expect(store.all[0]!.schema_version).toBe("aep/v0.4");
    expect(store.all[0]!.dsse_envelope).toBeDefined();
    expect(store.all[0]).toBe(record);
  });

  it("works with async evidence stores (FilesystemEvidenceStore)", async () => {
    const logFile = join(tmpdir(), `aep-stream-test-${Date.now()}.ndjson`);
    const store = new FilesystemEvidenceStore(logFile);
    await store.ready();
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-fs-stream",
      signer,
      evidenceStore: store,
    });
    emitter.addAction({
      tool_name: "bash",
      state_changing: false,
      side_effect_class: "mutate-local",
    });
    const record = await emitter.emit(1_700_000_000_000);
    expect(await store.size()).toBe(1);
    const stored = (await store.query({ run_id: "run-fs-stream" }))[0];
    expect(stored!.run_id).toBe("run-fs-stream");
    expect(stored!.signature.sig).toBe(record.signature.sig);
    // Cleanup
    rmSync(logFile, { force: true });
  });
});

describe("Evidence bundle export adapter (#228)", () => {
  /** Emit N signed records from a single emitter so they form a valid hash chain. */
  async function emitChain(runId: string, count: number, baseTs = 1_700_000_000_000) {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({ run_id: runId, signer });
    const records: AEPRecord[] = [];
    for (let i = 0; i < count; i++) {
      emitter.addAction({
        tool_name: i === 0 ? "read_file" : "write_file",
        state_changing: i > 0,
        side_effect_class: i === 0 ? "read" : "mutate-local",
      });
      records.push(await emitter.emit(baseTs + i * 1000));
    }
    return { signer, records };
  }

  it("buildEvidenceBundle produces a well-formed manifest for ordered records", async () => {
    const { records } = await emitChain("run-bundle-build", 3);
    const bundle = buildEvidenceBundle(records);

    expect(bundle.schema_version).toBe(EVIDENCE_BUNDLE_SCHEMA_VERSION);
    expect(bundle.manifest.schema_version).toBe(EVIDENCE_BUNDLE_SCHEMA_VERSION);
    expect(bundle.manifest.producer).toBe("@wasmagent/aep");
    expect(bundle.manifest.record_count).toBe(3);
    expect(bundle.manifest.records).toHaveLength(3);
    expect(bundle.manifest.run_ids).toEqual(["run-bundle-build"]);
    // Each manifest entry is indexed positionally and carries a sha256 hex digest.
    for (let i = 0; i < bundle.manifest.records.length; i++) {
      const entry = bundle.manifest.records[i]!;
      expect(entry.index).toBe(i);
      expect(entry.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.run_id).toBe("run-bundle-build");
    }
    // Time range spans the earliest and latest created_at_ms.
    expect(bundle.manifest.started_at_ms).toBe(1_700_000_000_000);
    expect(bundle.manifest.ended_at_ms).toBe(1_700_000_002_000);
    expect(bundle.manifest.bundle_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifyEvidenceBundle accepts a freshly built bundle", async () => {
    const { records } = await emitChain("run-verify", 3);
    const bundle = buildEvidenceBundle(records);
    const result = await verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.record_count_valid).toBe(true);
    expect(result.record_digests_valid).toBe(true);
    expect(result.bundle_digest_valid).toBe(true);
    expect(result.chain_valid).toBe(true);
    expect(result.broken_record_at).toBeUndefined();
    expect(result.broken_chain_at).toBeUndefined();
  });

  it("verifyEvidenceBundle verifies per-record signatures when a publicKey is supplied", async () => {
    const { signer, records } = await emitChain("run-sig", 3);
    const publicKey = await signer.getPublicKey();
    const bundle = buildEvidenceBundle(records);
    const result = await verifyEvidenceBundle(bundle, { publicKey });
    expect(result.valid).toBe(true);
    expect(result.signatures).toHaveLength(3);
    expect(result.signatures!.every((s) => s.valid)).toBe(true);
  });

  it("detects a mutated record via manifest digest mismatch", async () => {
    const { records } = await emitChain("run-tamper-record", 3);
    const bundle = buildEvidenceBundle(records);
    // Mutate the LAST record so the hash chain (which depends on predecessors)
    // stays intact and only the per-record digest check fails.
    bundle.records[2]!.model_id = "tampered-model-id";
    const result = await verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.record_digests_valid).toBe(false);
    expect(result.broken_record_at).toBe(2);
    // Other facets of the bundle are unaffected by this mutation.
    expect(result.bundle_digest_valid).toBe(true);
    expect(result.record_count_valid).toBe(true);
  });

  it("detects a tampered bundle_digest", async () => {
    const { records } = await emitChain("run-tamper-digest", 3);
    const bundle = buildEvidenceBundle(records);
    bundle.manifest.bundle_digest = "0".repeat(64);
    const result = await verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.bundle_digest_valid).toBe(false);
    expect(result.record_digests_valid).toBe(true);
    expect(result.record_count_valid).toBe(true);
  });

  it("detects a broken hash chain (reordered records) while manifests stay consistent", async () => {
    const { records } = await emitChain("run-chain", 3);
    const [r0, r1, r2] = records;
    // Rebuild the bundle from reordered records so per-record digests and the
    // bundle digest remain self-consistent; only the hash-chain links break.
    const reordered = buildEvidenceBundle([r1!, r0!, r2!]);
    const result = await verifyEvidenceBundle(reordered);
    expect(result.valid).toBe(false);
    expect(result.chain_valid).toBe(false);
    expect(result.broken_chain_at).toBe(2);
    expect(result.record_digests_valid).toBe(true);
    expect(result.bundle_digest_valid).toBe(true);
  });

  it("detects an inconsistent record_count", async () => {
    const { records } = await emitChain("run-count", 3);
    const bundle = buildEvidenceBundle(records);
    bundle.manifest.record_count = 99;
    const result = await verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.record_count_valid).toBe(false);
  });

  it("serialize/parse round-trips and the parsed bundle re-verifies", async () => {
    const { records } = await emitChain("run-roundtrip", 2);
    const bundle = buildEvidenceBundle(records);
    const json = serializeEvidenceBundle(bundle);
    expect(typeof json).toBe("string");
    const parsed = parseEvidenceBundle(json);
    expect(parsed).toEqual(bundle);
    const result = await verifyEvidenceBundle(parsed);
    expect(result.valid).toBe(true);
  });

  it("serialization is deterministic for identical inputs and options", async () => {
    const { records } = await emitChain("run-determinism", 2);
    const a = buildEvidenceBundle(records, { createdAt: "2026-07-27T00:00:00.000Z" });
    const b = buildEvidenceBundle(records, { createdAt: "2026-07-27T00:00:00.000Z" });
    expect(serializeEvidenceBundle(a)).toBe(serializeEvidenceBundle(b));
    expect(a.manifest.bundle_digest).toBe(b.manifest.bundle_digest);
  });

  it("handles an empty record set", () => {
    const bundle = buildEvidenceBundle([]);
    expect(bundle.manifest.record_count).toBe(0);
    expect(bundle.manifest.records).toEqual([]);
    expect(bundle.manifest.run_ids).toEqual([]);
    expect(bundle.manifest.started_at_ms).toBe(0);
    expect(bundle.manifest.ended_at_ms).toBe(0);
  });

  it("verifyEvidenceBundle on an empty bundle is valid", async () => {
    const bundle = buildEvidenceBundle([]);
    const result = await verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.chain_valid).toBe(true);
  });

  it("exports records from an EvidenceStore into a verifiable bundle", async () => {
    const store = new InMemoryEvidenceStore();
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: "run-store-export",
      signer,
      evidenceStore: store,
    });
    emitter.addAction({
      tool_name: "bash",
      state_changing: true,
      side_effect_class: "mutate-local",
    });
    await emitter.emit(1_700_000_000_000);

    const bundle = buildEvidenceBundle(await store.query());
    const result = await verifyEvidenceBundle(bundle, { publicKey: await signer.getPublicKey() });
    expect(result.valid).toBe(true);
    expect(bundle.manifest.record_count).toBe(await store.size());
  });
});
