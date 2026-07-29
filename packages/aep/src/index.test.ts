import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paeEncode, verifyDSSEEnvelope, wrapInTotoStatement } from "./dsse.js";
import { AEPEmitter } from "./emitter.js";
import {
  contentDigestKeyOf,
  EvidenceMirror,
  EvidenceMirrorConflictError,
  InMemoryRemoteEvidenceBackend,
} from "./evidenceMirror.js";
import {
  ComplianceDashboardObserver,
  type DeadLetterBackend,
  EvidenceMonitor,
  validateWebhookUrl,
  WebhookMonitorHook,
  type WebSocketLike,
  WebSocketMonitorHook,
} from "./evidenceMonitor.js";
import { EvidencePublisher, type EvidencePublisherStats } from "./evidencePublisher.js";
import {
  defaultTierClassifier,
  EvidenceRouter,
  type EvidenceSink,
  type StorageTier,
} from "./evidenceRouter.js";
import { FilesystemEvidenceStore, InMemoryEvidenceStore } from "./evidenceStore.js";
import {
  EvidenceStream,
  type StreamEvent,
  type StreamTransportInbound,
  type StreamTransportOutbound,
} from "./evidenceStream.js";
import {
  buildEvidenceBundle,
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  parseEvidenceBundle,
  serializeEvidenceBundle,
  verifyEvidenceBundle,
} from "./exportAdapter.js";
import {
  buildToolRollups,
  computeProofHash,
  GENESIS_PREV_HASH,
  hashLedgerRecord,
  Ledger,
  type LedgerRecord,
} from "./ledger.js";
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

  it("returns true for common domain verbs missing before #282", () => {
    expect(isStateChangingTool({ name: "submit_pr" })).toBe(true);
    expect(isStateChangingTool({ name: "convert_pr_to_po" })).toBe(true);
    expect(isStateChangingTool({ name: "approve_request" })).toBe(true);
    expect(isStateChangingTool({ name: "reject_vendor" })).toBe(true);
    expect(isStateChangingTool({ name: "insert_record" })).toBe(true);
    expect(isStateChangingTool({ name: "patch_config" })).toBe(true);
    expect(isStateChangingTool({ name: "apply_migration" })).toBe(true);
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

describe("Ledger — durable evidence ledger with per-record signing and hash-chaining (#235)", () => {
  const LEDGER_SEED = "abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01";
  const LEDGER_KEY_ID = "ledger-key-01";

  /** Helper: emit a signed AEPRecord with one action. */
  async function emitRecord(runId = "run-ledger", toolName = "tool_a", ts = 1_700_000_000_000) {
    const signer = createLocalSignerFromSeed(LEDGER_SEED, LEDGER_KEY_ID);
    const emitter = new AEPEmitter({ run_id: runId, signer });
    emitter.addAction({ tool_name: toolName, state_changing: false });
    return emitter.emit(ts);
  }

  it("genesis record has prevHash equal to the sentinel (empty string)", async () => {
    const ledger = new Ledger();
    const record = await emitRecord();
    const lr = await ledger.append(record);

    expect(lr.seq).toBe(0);
    expect(lr.prevHash).toBe(GENESIS_PREV_HASH);
    expect(lr.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("appending produces a correctly-signed record", async () => {
    const ledger = new Ledger();
    const signer = createLocalSignerFromSeed(LEDGER_SEED, LEDGER_KEY_ID);
    const emitter = new AEPEmitter({ run_id: "run-sig-check", signer });
    emitter.addAction({ tool_name: "bash", state_changing: true });
    const record = await emitter.emit();

    const lr = await ledger.append(record);

    // Verify the inner AEPRecord's signature with the public key
    const publicKey = await signer.getPublicKey();
    const valid = await verifyAEPRecord(lr.record, publicKey);
    expect(valid).toBe(true);
  });

  it("two consecutive appends yield records where record[1].prevHash == hash(record[0])", async () => {
    const ledger = new Ledger();
    const r0 = await emitRecord();
    const r1 = await emitRecord();

    const lr0 = await ledger.append(r0);
    const lr1 = await ledger.append(r1);

    expect(lr1.prevHash).toBe(lr0.hash);
  });

  it("seq is strictly monotonic across appends", async () => {
    const ledger = new Ledger();

    for (let i = 0; i < 5; i++) {
      const record = await emitRecord();
      const lr = await ledger.append(record);
      expect(lr.seq).toBe(i);
    }

    expect(ledger.size).toBe(5);
  });

  it("hash is a 64-char hex SHA-256 string", async () => {
    const ledger = new Ledger();
    const record = await emitRecord();
    const lr = await ledger.append(record);

    expect(lr.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashLedgerRecord is deterministic", async () => {
    const ledger = new Ledger();
    const record = await emitRecord();
    const lr = await ledger.append(record);

    // Compute hash again — must match
    const recomputed = hashLedgerRecord(lr);
    expect(recomputed).toBe(lr.hash);
  });

  it("three-record chain has correct prevHash linkage", async () => {
    const ledger = new Ledger();

    const lr0 = await ledger.append(await emitRecord());
    const lr1 = await ledger.append(await emitRecord());
    const lr2 = await ledger.append(await emitRecord());

    // Genesis
    expect(lr0.prevHash).toBe(GENESIS_PREV_HASH);
    // Chain linkage
    expect(lr1.prevHash).toBe(lr0.hash);
    expect(lr2.prevHash).toBe(lr1.hash);
    // No circularity
    expect(lr0.hash).not.toBe(lr1.hash);
    expect(lr1.hash).not.toBe(lr2.hash);
  });

  it("append rejects an unsigned record (no signature)", async () => {
    const ledger = new Ledger();
    const emitter = new AEPEmitter({ run_id: "run-unsigned" });
    emitter.addAction({ tool_name: "noop", state_changing: false });
    // build() produces a placeholder-signed record — use it to construct a truly unsigned record
    const unsigned = emitter.build();
    // Replace the signature with a falsy value
    const badRecord = { ...unsigned, signature: undefined } as unknown as AEPRecord;

    expect(ledger.append(badRecord)).rejects.toThrow(/signed AEPRecord/);
  });

  it("append with EvidenceStore persists the AEPRecord", async () => {
    const store = new InMemoryEvidenceStore();
    const ledger = new Ledger({ store });
    const record = await emitRecord("run-store-ledger");
    await ledger.append(record);

    expect(store.size()).toBe(1);
    const stored = store.getByRunId("run-store-ledger");
    expect(stored).toHaveLength(1);
  });

  it("last property returns the most recent ledger record", async () => {
    const ledger = new Ledger();
    expect(ledger.last).toBeUndefined();

    const lr0 = await ledger.append(await emitRecord());
    expect(ledger.last).toBe(lr0);

    const lr1 = await ledger.append(await emitRecord());
    expect(ledger.last).toBe(lr1);
  });

  it("records are returned in insertion order", async () => {
    const ledger = new Ledger();
    const lr0 = await ledger.append(await emitRecord("run-ord-1", "tool_a"));
    const lr1 = await ledger.append(await emitRecord("run-ord-2", "tool_b"));

    expect(ledger.records).toHaveLength(2);
    expect(ledger.records[0]).toBe(lr0);
    expect(ledger.records[1]).toBe(lr1);
  });

  it("holistic chain verification: signature recomputation, seq ordering, and prevHash continuity", async () => {
    const signer = createLocalSignerFromSeed(LEDGER_SEED, LEDGER_KEY_ID);
    const publicKey = await signer.getPublicKey();
    const ledger = new Ledger();

    // Append 4 records
    const records: AEPRecord[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await emitRecord("run-holistic", `tool_${i}`);
      records.push(r);
      await ledger.append(r);
    }

    const lrs = ledger.records;
    expect(lrs).toHaveLength(4);

    for (let i = 0; i < lrs.length; i++) {
      const lr = lrs[i];

      // (1) Verify each record's signature by recomputing it
      const sigValid = await verifyAEPRecord(lr.record, publicKey);
      expect(sigValid).toBe(true);

      // (2) Verify seq ordering is strictly monotonic starting from 0
      expect(lr.seq).toBe(i);

      // (3) Verify prevHash continuity by walking the chain
      if (i === 0) {
        // Genesis: prevHash must be the sentinel
        expect(lr.prevHash).toBe(GENESIS_PREV_HASH);
      } else {
        // Non-genesis: prevHash must equal hash of the previous ledger record
        const prevLr = lrs[i - 1];
        expect(lr.prevHash).toBe(prevLr.hash);
        // Also verify the hash is recomputable (stable canonical serialization)
        expect(hashLedgerRecord(prevLr)).toBe(prevLr.hash);
      }
    }
  });
});

describe("Ledger.compact() — evidence record compaction and rollup (#255)", () => {
  const LEDGER_SEED = "abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01";
  const LEDGER_KEY_ID = "ledger-key-01";

  /** Helper: emit a signed AEPRecord with configurable actions. */
  async function emitRecord(
    runId = "run-compact",
    toolName = "tool_a",
    ts = 1_700_000_000_000,
    opts: { state_changing?: boolean; side_effect_class?: SideEffectClass } = {}
  ) {
    const signer = createLocalSignerFromSeed(LEDGER_SEED, LEDGER_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: runId,
      signer,
    });
    emitter.addAction({
      tool_name: toolName,
      state_changing: opts.state_changing ?? false,
      side_effect_class: opts.side_effect_class ?? "read",
    });
    return emitter.emit(ts);
  }

  it("compact() produces a valid CompactionResult with proof hash and tool rollups", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 5; i++) {
      await ledger.append(await emitRecord("run-c1", "read_file", 1_700_000_000_000 + i * 1000));
    }

    const compaction = ledger.compact();

    expect(compaction.fromSeq).toBe(0);
    expect(compaction.toSeq).toBe(4);
    expect(compaction.recordCount).toBe(5);
    expect(compaction.proofHash).toMatch(/^[0-9a-f]{64}$/);
    expect(compaction.firstRecordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(compaction.firstRecordPrevHash).toBe(GENESIS_PREV_HASH);
    expect(compaction.lastRecordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(compaction.startedAtMs).toBe(1_700_000_000_000);
    expect(compaction.endedAtMs).toBe(1_700_000_004_000);
    expect(compaction.runIds).toEqual(["run-c1"]);
    expect(compaction.toolRollups.length).toBeGreaterThan(0);
    expect(typeof compaction.compactedAtMs).toBe("number");
  });

  it("compact() preserves cryptographic chain proof endpoints", async () => {
    const ledger = new Ledger();
    const lrs: Awaited<LedgerRecord>[] = [];

    for (let i = 0; i < 4; i++) {
      const r = await emitRecord("run-c2", `tool_${i}`);
      lrs.push(await ledger.append(r));
    }

    const compaction = ledger.compact();

    // firstRecordHash must match the genesis record's hash
    expect(compaction.firstRecordHash).toBe(lrs[0]!.hash);
    // lastRecordHash must match the last compacted record's hash
    expect(compaction.lastRecordHash).toBe(lrs[3]!.hash);
    // firstRecordPrevHash must be genesis sentinel
    expect(compaction.firstRecordPrevHash).toBe(GENESIS_PREV_HASH);

    // Verify each record's hash is individually recomputable
    for (const lr of lrs) {
      expect(hashLedgerRecord(lr)).toBe(lr.hash);
    }
  });

  it("compact() compresses repetitive tool calls into rollups", async () => {
    const ledger = new Ledger();
    // 5 read_file, 3 write_file, 2 bash
    for (let i = 0; i < 5; i++) {
      await ledger.append(await emitRecord("run-rollup", "read_file", 1_700_000_000_000 + i));
    }
    for (let i = 0; i < 3; i++) {
      await ledger.append(
        await emitRecord("run-rollup", "write_file", 1_700_000_010_000 + i, {
          state_changing: true,
          side_effect_class: "mutate-local",
        })
      );
    }
    for (let i = 0; i < 2; i++) {
      await ledger.append(
        await emitRecord("run-rollup", "bash", 1_700_000_020_000 + i, {
          state_changing: true,
          side_effect_class: "mutate-external",
        })
      );
    }

    const compaction = ledger.compact();

    // Should have 3 distinct tool rollups
    expect(compaction.toolRollups).toHaveLength(3);

    const readRollup = compaction.toolRollups.find((r) => r.tool_name === "read_file");
    expect(readRollup).toBeDefined();
    expect(readRollup!.count).toBe(5);
    expect(readRollup!.state_changing_count).toBe(0);
    expect(readRollup!.side_effect_classes.read).toBe(5);

    const writeRollup = compaction.toolRollups.find((r) => r.tool_name === "write_file");
    expect(writeRollup).toBeDefined();
    expect(writeRollup!.count).toBe(3);
    expect(writeRollup!.state_changing_count).toBe(3);
    expect(writeRollup!.side_effect_classes["mutate-local"]).toBe(3);

    const bashRollup = compaction.toolRollups.find((r) => r.tool_name === "bash");
    expect(bashRollup).toBeDefined();
    expect(bashRollup!.count).toBe(2);
    expect(bashRollup!.state_changing_count).toBe(2);
    expect(bashRollup!.side_effect_classes["mutate-external"]).toBe(2);
  });

  it("compact() with upToSeq only compacts the specified range", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 10; i++) {
      await ledger.append(await emitRecord("run-range", `tool_${i}`));
    }

    // Compact only records 0..4
    const compaction = ledger.compact({ upToSeq: 4 });

    expect(compaction.fromSeq).toBe(0);
    expect(compaction.toSeq).toBe(4);
    expect(compaction.recordCount).toBe(5);

    // Verify we have 5 rollups (one per tool)
    expect(compaction.toolRollups).toHaveLength(5);

    // Ledger should still have all 10 records (compact is read-only)
    expect(ledger.size).toBe(10);
  });

  it("compact() with label preserves the label in the result", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 3; i++) {
      await ledger.append(await emitRecord("run-label"));
    }

    const compaction = ledger.compact({ label: "session-1-rollup" });
    expect(compaction.label).toBe("session-1-rollup");
  });

  it("compact() with custom minRecords rejects small ranges", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 3; i++) {
      await ledger.append(await emitRecord("run-min"));
    }

    // minRecords=5 with only 3 records should throw
    expect(() => ledger.compact({ minRecords: 5 })).toThrow(/minimum: 5/);
  });

  it("compact() throws on empty ledger", () => {
    const ledger = new Ledger();
    expect(() => ledger.compact()).toThrow(/at least one record/);
  });

  it("compact() throws on single record (below default minRecords)", async () => {
    const ledger = new Ledger();
    await ledger.append(await emitRecord("run-single"));
    expect(() => ledger.compact()).toThrow(/minimum: 2/);
  });

  it("verifyCompaction() returns true for a valid compaction", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 5; i++) {
      await ledger.append(await emitRecord("run-verify"));
    }

    const compaction = ledger.compact();
    expect(ledger.verifyCompaction(compaction)).toBe(true);
  });

  it("verifyCompaction() returns false when proofHash is tampered", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 5; i++) {
      await ledger.append(await emitRecord("run-tamper-proof"));
    }

    const compaction = ledger.compact();
    compaction.proofHash = "0".repeat(64);
    expect(ledger.verifyCompaction(compaction)).toBe(false);
  });

  it("verifyCompaction() returns false when recordCount is wrong", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 5; i++) {
      await ledger.append(await emitRecord("run-tamper-count"));
    }

    const compaction = ledger.compact();
    compaction.recordCount = 99;
    expect(ledger.verifyCompaction(compaction)).toBe(false);
  });

  it("verifyCompaction() returns false when firstRecordHash is tampered", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 5; i++) {
      await ledger.append(await emitRecord("run-tamper-first"));
    }

    const compaction = ledger.compact();
    compaction.firstRecordHash = "ff".repeat(32);
    expect(ledger.verifyCompaction(compaction)).toBe(false);
  });

  it("verifyCompaction() returns false when lastRecordHash is tampered", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 5; i++) {
      await ledger.append(await emitRecord("run-tamper-last"));
    }

    const compaction = ledger.compact();
    compaction.lastRecordHash = "ff".repeat(32);
    expect(ledger.verifyCompaction(compaction)).toBe(false);
  });

  it("verifyCompaction() detects when records have been removed from the ledger", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 5; i++) {
      await ledger.append(await emitRecord("run-removed"));
    }

    const compaction = ledger.compact({ upToSeq: 3 });
    // Compaction covers seq 0..3. If we compacted all 5, changing toSeq to 3
    // should cause verifyCompaction to fail because it still finds 5 records in range.
    // But actually, verifyCompaction checks fromSeq..toSeq, so let's create a compaction
    // for a range that no longer fully exists by modifying the result:
    expect(ledger.verifyCompaction(compaction)).toBe(true);

    // Change toSeq to point beyond actual records
    const badCompaction = { ...compaction, toSeq: 99, recordCount: 100 };
    expect(ledger.verifyCompaction(badCompaction)).toBe(false);
  });

  it("compact() works with EvidenceStore-backed ledger", async () => {
    const store = new InMemoryEvidenceStore();
    const ledger = new Ledger({ store });
    for (let i = 0; i < 5; i++) {
      await ledger.append(await emitRecord("run-store-compact", `tool_${i}`));
    }

    const compaction = ledger.compact({ label: "store-backed" });
    expect(compaction.recordCount).toBe(5);
    expect(compaction.label).toBe("store-backed");
    expect(ledger.verifyCompaction(compaction)).toBe(true);

    // Store should still have all records (compact is read-only)
    expect(store.size()).toBe(5);
  });

  it("multiple compactions of overlapping ranges are independently verifiable", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 10; i++) {
      await ledger.append(await emitRecord("run-multi-compact", `tool_${i}`));
    }

    const c1 = ledger.compact({ upToSeq: 3, label: "first-4" });
    const c2 = ledger.compact({ upToSeq: 7, label: "first-8" });
    const c3 = ledger.compact({ upToSeq: 9, label: "all-10" });

    expect(ledger.verifyCompaction(c1)).toBe(true);
    expect(ledger.verifyCompaction(c2)).toBe(true);
    expect(ledger.verifyCompaction(c3)).toBe(true);

    expect(c1.recordCount).toBe(4);
    expect(c2.recordCount).toBe(8);
    expect(c3.recordCount).toBe(10);
  });

  it("proof hash is deterministic for the same records", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 3; i++) {
      await ledger.append(await emitRecord("run-deterministic"));
    }

    const c1 = ledger.compact();
    const c2 = ledger.compact();
    expect(c1.proofHash).toBe(c2.proofHash);
  });

  it("proof hash changes when records change (tamper detection)", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 3; i++) {
      await ledger.append(await emitRecord("run-tamper-det"));
    }

    const c1 = ledger.compact();
    // Append a new record — this changes the range if we compact all
    await ledger.append(await emitRecord("run-tamper-det", "new_tool"));
    const c2 = ledger.compact();

    // Different record set → different proof hash
    expect(c1.proofHash).not.toBe(c2.proofHash);
  });

  it("compact() captures distinct run_ids across mixed records", async () => {
    const ledger = new Ledger();
    await ledger.append(await emitRecord("run-a", "tool_1"));
    await ledger.append(await emitRecord("run-b", "tool_2"));
    await ledger.append(await emitRecord("run-a", "tool_3"));
    await ledger.append(await emitRecord("run-c", "tool_4"));

    const compaction = ledger.compact();
    expect(compaction.runIds).toContain("run-a");
    expect(compaction.runIds).toContain("run-b");
    expect(compaction.runIds).toContain("run-c");
    expect(compaction.runIds).toHaveLength(3);
  });

  it("getRange() returns the correct subset of records", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 10; i++) {
      await ledger.append(await emitRecord("run-range-get", `tool_${i}`));
    }

    const range = ledger.getRange(2, 5);
    expect(range).toHaveLength(4);
    expect(range[0]!.seq).toBe(2);
    expect(range[3]!.seq).toBe(5);

    // Out-of-range: no records
    expect(ledger.getRange(20, 30)).toHaveLength(0);
  });

  it("computeProofHash and buildToolRollups work as standalone functions", async () => {
    const ledger = new Ledger();
    for (let i = 0; i < 3; i++) {
      await ledger.append(
        await emitRecord("run-standalone", "bash", 1_700_000_000_000 + i, {
          state_changing: true,
          side_effect_class: "mutate-local",
        })
      );
    }

    const records = ledger.records;
    const proofHash = computeProofHash(records);
    expect(proofHash).toMatch(/^[0-9a-f]{64}$/);

    const rollups = buildToolRollups(records);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.tool_name).toBe("bash");
    expect(rollups[0]!.count).toBe(3);
    expect(rollups[0]!.state_changing_count).toBe(3);
  });
});

describe("EvidenceMirror (#256)", () => {
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

  describe("InMemoryRemoteEvidenceBackend", () => {
    it("implements list/get/put/delete as a content-addressable KV store", async () => {
      const backend = new InMemoryRemoteEvidenceBackend("s3");
      expect(backend.kind).toBe("s3");
      expect(await backend.list()).toEqual([]);

      const record = await makeRecord({ run_id: "run-kv" });
      const key = contentDigestKeyOf(record);
      await backend.put(key, record);
      expect(await backend.list()).toEqual([key]);
      expect(await backend.get(key)).toBe(record);
      expect(await backend.get("missing")).toBeUndefined();

      await backend.delete(key);
      expect(await backend.list()).toEqual([]);
      expect(await backend.get(key)).toBeUndefined();
    });

    it("put overwrites the record stored under an existing key", async () => {
      const backend = new InMemoryRemoteEvidenceBackend();
      const a = await makeRecord({ run_id: "run-ow", created_at_ms: 100 });
      const b = await makeRecord({ run_id: "run-ow", created_at_ms: 200 });
      const key = "fixed-slot";
      await backend.put(key, a);
      await backend.put(key, b);
      expect(await backend.list()).toEqual([key]);
      expect((await backend.get(key))?.created_at_ms).toBe(200);
    });
  });

  describe("default content-digest keying (conflict-free)", () => {
    it("push copies local-only records to the remote backend", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      local.append(await makeRecord({ run_id: "run-a" }));

      const mirror = new EvidenceMirror({ local, remote });
      const result = await mirror.push();

      expect(result.pushed).toBe(1);
      expect(result.conflicts).toBe(0);
      expect(await remote.list()).toHaveLength(1);
    });

    it("pull appends remote-only records to the local store", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      const record = await makeRecord({ run_id: "run-b" });
      await remote.put(contentDigestKeyOf(record), record);

      const mirror = new EvidenceMirror({ local, remote });
      const result = await mirror.pull();

      expect(result.pulled).toBe(1);
      expect(result.conflicts).toBe(0);
      expect(local.size()).toBe(1);
    });

    it("sync is bidirectional and converges both sides", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      const a = await makeRecord({ run_id: "run-a" });
      const b = await makeRecord({ run_id: "run-b" });
      local.append(a);
      await remote.put(contentDigestKeyOf(b), b);

      const mirror = new EvidenceMirror({ local, remote });
      const result = await mirror.sync();

      expect(result.pushed).toBe(1);
      expect(result.pulled).toBe(1);
      expect(result.conflicts).toBe(0);
      // Both sides now hold both records.
      expect(local.size()).toBe(2);
      expect(await remote.list()).toHaveLength(2);
    });

    it("is idempotent: a second sync is a no-op", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      const a = await makeRecord({ run_id: "run-a" });
      const b = await makeRecord({ run_id: "run-b" });
      local.append(a);
      await remote.put(contentDigestKeyOf(b), b);

      const mirror = new EvidenceMirror({ local, remote });
      await mirror.sync();
      const second = await mirror.sync();

      expect(second.pushed).toBe(0);
      expect(second.pulled).toBe(0);
      expect(second.conflicts).toBe(0);
      // Every key is already in sync across both phases.
      expect(second.skipped).toBe(4);
      expect(local.size()).toBe(2);
      expect(await remote.list()).toHaveLength(2);
    });

    it("treats byte-identical records as the same key with no conflict", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      const record = await makeRecord({ run_id: "run-same" });
      local.append(record);
      await remote.put(contentDigestKeyOf(record), record);

      const mirror = new EvidenceMirror({ local, remote });
      const result = await mirror.sync();

      expect(result.conflicts).toBe(0);
      expect(result.pushed).toBe(0);
      expect(result.pulled).toBe(0);
    });
  });

  describe("one-way methods", () => {
    it("push does not pull remote-only records into the local store", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      local.append(await makeRecord({ run_id: "run-local" }));
      const remoteOnly = await makeRecord({ run_id: "run-remote" });
      await remote.put(contentDigestKeyOf(remoteOnly), remoteOnly);

      const mirror = new EvidenceMirror({ local, remote });
      const result = await mirror.push();

      expect(result.pushed).toBe(1);
      expect(result.pulled).toBe(0);
      expect(local.size()).toBe(1); // remote-only record was NOT pulled
      expect(await remote.list()).toHaveLength(2);
    });

    it("pull does not push local-only records to the remote backend", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      local.append(await makeRecord({ run_id: "run-local" }));
      const remoteOnly = await makeRecord({ run_id: "run-remote" });
      await remote.put(contentDigestKeyOf(remoteOnly), remoteOnly);

      const mirror = new EvidenceMirror({ local, remote });
      const result = await mirror.pull();

      expect(result.pulled).toBe(1);
      expect(result.pushed).toBe(0);
      expect(await remote.list()).toHaveLength(1); // local-only record was NOT pushed
    });
  });

  describe("conflict resolution (custom keyOf keyed by run_id)", () => {
    it("last-writer-wins keeps the newer record on both sides", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      const older = await makeRecord({
        run_id: "run-x",
        created_at_ms: 100,
        tool_name: "older_tool",
      });
      const newer = await makeRecord({
        run_id: "run-x",
        created_at_ms: 200,
        tool_name: "newer_tool",
      });
      local.append(older);
      await remote.put("run-x", newer);

      const mirror = new EvidenceMirror({
        local,
        remote,
        keyOf: (r) => r.run_id,
        conflictResolver: "last-writer-wins",
      });
      const result = await mirror.sync();

      expect(result.conflicts).toBeGreaterThanOrEqual(1);
      // push: local older vs remote newer → remote wins (newer) → skip
      // pull: remote newer vs local older → remote wins → append newer locally
      expect(result.pulled).toBe(1);
      const remoteRecord = await remote.get("run-x");
      expect(remoteRecord?.actions[0]?.tool_name).toBe("newer_tool");
      // Local now holds both the older and the appended newer record.
      expect(local.size()).toBe(2);
      const localNewer = local.query().find((r) => r.created_at_ms === 200);
      expect(localNewer?.actions[0]?.tool_name).toBe("newer_tool");
    });

    it("prefer-local overwrites the remote with the local record", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      const localRec = await makeRecord({
        run_id: "run-p",
        created_at_ms: 100,
        tool_name: "local_tool",
      });
      const remoteRec = await makeRecord({
        run_id: "run-p",
        created_at_ms: 999,
        tool_name: "remote_tool",
      });
      local.append(localRec);
      await remote.put("run-p", remoteRec);

      const mirror = new EvidenceMirror({
        local,
        remote,
        keyOf: (r) => r.run_id,
        conflictResolver: "prefer-local",
      });
      const result = await mirror.sync();

      expect(result.conflicts).toBeGreaterThanOrEqual(1);
      const remoteRecord = await remote.get("run-p");
      // Even though the remote record was newer, prefer-local wins.
      expect(remoteRecord?.actions[0]?.tool_name).toBe("local_tool");
      expect(remoteRecord?.created_at_ms).toBe(100);
      // The losing remote record was NOT pulled into the local store.
      expect(local.size()).toBe(1);
    });

    it("prefer-remote appends the remote record to the local store", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      const localRec = await makeRecord({
        run_id: "run-q",
        created_at_ms: 999,
        tool_name: "local_tool",
      });
      const remoteRec = await makeRecord({
        run_id: "run-q",
        created_at_ms: 100,
        tool_name: "remote_tool",
      });
      local.append(localRec);
      await remote.put("run-q", remoteRec);

      const mirror = new EvidenceMirror({
        local,
        remote,
        keyOf: (r) => r.run_id,
        conflictResolver: "prefer-remote",
      });
      const result = await mirror.sync();

      expect(result.conflicts).toBeGreaterThanOrEqual(1);
      // Even though the local record was newer, prefer-remote wins.
      const remoteRecord = await remote.get("run-q");
      expect(remoteRecord?.created_at_ms).toBe(100);
      // The winning remote record was appended to the local store.
      expect(local.size()).toBe(2);
      const localRemote = local.query().find((r) => r.created_at_ms === 100);
      expect(localRemote?.actions[0]?.tool_name).toBe("remote_tool");
    });

    it("accepts a custom resolver function and records each decision", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      const localRec = await makeRecord({ run_id: "run-c", created_at_ms: 100 });
      const remoteRec = await makeRecord({ run_id: "run-c", created_at_ms: 200 });
      local.append(localRec);
      await remote.put("run-c", remoteRec);

      let calls = 0;
      const mirror = new EvidenceMirror({
        local,
        remote,
        keyOf: (r) => r.run_id,
        conflictResolver: () => {
          calls++;
          return "local";
        },
      });
      const result = await mirror.sync();

      expect(calls).toBeGreaterThan(0);
      expect(result.resolutions.length).toBe(calls);
      for (const entry of result.resolutions) {
        expect(entry.winner).toBe("local");
        expect(entry.key).toBe("run-c");
      }
    });

    it("fails fast with EvidenceMirrorConflictError when conflictResolution is 'fail'", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      local.append(await makeRecord({ run_id: "run-f", created_at_ms: 100 }));
      await remote.put("run-f", await makeRecord({ run_id: "run-f", created_at_ms: 200 }));

      const mirror = new EvidenceMirror({
        local,
        remote,
        keyOf: (r) => r.run_id,
        conflictResolver: "fail",
      });

      await expect(mirror.sync()).rejects.toBeInstanceOf(EvidenceMirrorConflictError);
    });

    it("stays idempotent across repeated syncs after a conflict is resolved", async () => {
      const local = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend();
      const older = await makeRecord({ run_id: "run-i", created_at_ms: 100 });
      const newer = await makeRecord({ run_id: "run-i", created_at_ms: 200 });
      local.append(older);
      await remote.put("run-i", newer);

      const mirror = new EvidenceMirror({
        local,
        remote,
        keyOf: (r) => r.run_id,
        conflictResolver: "last-writer-wins",
      });

      await mirror.sync();
      const sizeAfterFirst = local.size();
      const remoteKeysAfterFirst = (await remote.list()).length;

      // Repeated syncs must not duplicate the appended winner.
      const second = await mirror.sync();
      const third = await mirror.sync();

      expect(second.pulled).toBe(0);
      expect(second.pushed).toBe(0);
      expect(local.size()).toBe(sizeAfterFirst);
      expect((await remote.list()).length).toBe(remoteKeysAfterFirst);
      expect(third.pulled).toBe(0);
    });
  });

  describe("works with async local stores (FilesystemEvidenceStore)", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "wasmagent-aep-mirror-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("syncs a FilesystemEvidenceStore against a remote backend", async () => {
      const local = new FilesystemEvidenceStore(join(dir, "evidence.ndjson"));
      await local.ready();
      const remote = new InMemoryRemoteEvidenceBackend();
      await local.append(await makeRecord({ run_id: "run-fs-a" }));
      const remoteOnly = await makeRecord({ run_id: "run-fs-b" });
      await remote.put(contentDigestKeyOf(remoteOnly), remoteOnly);

      const mirror = new EvidenceMirror({ local, remote });
      const result = await mirror.sync();

      expect(result.pushed).toBe(1);
      expect(result.pulled).toBe(1);
      expect(await local.size()).toBe(2);
      expect(await remote.list()).toHaveLength(2);

      // Idempotent re-sync over the durable local store.
      const second = await mirror.sync();
      expect(second.pushed).toBe(0);
      expect(second.pulled).toBe(0);
    });
  });
});

describe("EvidenceRouter (#254)", () => {
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

  describe("defaultTierClassifier", () => {
    it("maps side-effect severity to archival tiers", async () => {
      expect(defaultTierClassifier(await makeRecord({ side_effect_class: "read" }))).toBe("cold");
      expect(defaultTierClassifier(await makeRecord({ side_effect_class: "mutate-local" }))).toBe(
        "warm"
      );
      expect(
        defaultTierClassifier(await makeRecord({ side_effect_class: "mutate-external" }))
      ).toBe("hot");
      expect(defaultTierClassifier(await makeRecord({ side_effect_class: "network-egress" }))).toBe(
        "hot"
      );
      // Explicitly unknown risk stays on the hot tier for prompt audit.
      expect(defaultTierClassifier(await makeRecord({ side_effect_class: "unknown" }))).toBe("hot");
    });

    it("classifies records with no side-effect information as cold", () => {
      // A legacy record with no run_side_effect_class_max.
      const legacy = {
        schema_version: "aep/v0.3" as const,
        run_id: "run-legacy",
        created_at_ms: 1_700_000_000_000,
        input_refs: [],
        output_refs: [],
        capability_decisions: [],
        actions: [],
        verifier_results: [],
        signature: { alg: "ed25519" as const, key_id: "k1", sig: "dGVzdA==" },
      };
      expect(defaultTierClassifier(legacy as AEPRecord)).toBe("cold");
    });
  });

  describe("local vs remote storage routing", () => {
    it("delivers a record to both local and remote sinks", async () => {
      const store = new InMemoryEvidenceStore();
      const remote = new InMemoryRemoteEvidenceBackend("s3");
      const router = new EvidenceRouter({
        sinks: [
          { kind: "local", id: "local-1", store },
          { kind: "remote", id: "remote-1", remote },
        ],
      });

      const record = await makeRecord({ run_id: "run-a" });
      const result = await router.route(record);

      expect(result.deliveredToSinks).toBe(2);
      expect(result.sinks).toEqual([
        { sinkId: "local-1", kind: "local", status: "delivered" },
        { sinkId: "remote-1", kind: "remote", status: "delivered" },
      ]);
      expect(store.size()).toBe(1);
      expect(store.all[0]).toBe(record);
      // Remote sink defaults to content-digest keying.
      expect(await remote.get(contentDigestKeyOf(record))).toBe(record);
      expect(result.errors).toEqual([]);
    });

    it("remote sink uses a custom keyOf when provided", async () => {
      const remote = new InMemoryRemoteEvidenceBackend();
      const router = new EvidenceRouter({
        sinks: [{ kind: "remote", id: "by-run", remote, keyOf: (r) => r.run_id }],
      });

      const record = await makeRecord({ run_id: "run-keyed" });
      await router.route(record);

      expect(await remote.get("run-keyed")).toBe(record);
      expect(await remote.get(contentDigestKeyOf(record))).toBeUndefined();
    });

    it("remote delivery is idempotent under the default content-digest key", async () => {
      const remote = new InMemoryRemoteEvidenceBackend();
      const router = new EvidenceRouter({
        sinks: [{ kind: "remote", id: "remote-1", remote }],
      });

      const record = await makeRecord({ run_id: "run-idem" });
      await router.route(record);
      await router.route(record);

      expect(await remote.list()).toHaveLength(1);
      expect(await remote.get(contentDigestKeyOf(record))).toBe(record);
    });

    it("routes to no sinks when none are configured", async () => {
      const router = new EvidenceRouter();
      const result = await router.route(await makeRecord());
      expect(result.deliveredToSinks).toBe(0);
      expect(result.sinks).toEqual([]);
    });

    it("rejects duplicate sink ids at construction", () => {
      const store = new InMemoryEvidenceStore();
      const sinks: EvidenceSink[] = [
        { kind: "local", id: "dup", store },
        { kind: "local", id: "dup", store: new InMemoryEvidenceStore() },
      ];
      expect(() => new EvidenceRouter({ sinks })).toThrow("not unique");
    });
  });

  describe("archival tiers", () => {
    it("only delivers to sinks whose declared tier matches the classified record", async () => {
      const hot = new InMemoryEvidenceStore();
      const warm = new InMemoryEvidenceStore();
      const cold = new InMemoryEvidenceStore();
      const router = new EvidenceRouter({
        sinks: [
          { kind: "local", id: "hot-tier", store: hot, tiers: ["hot"] },
          { kind: "local", id: "warm-tier", store: warm, tiers: ["warm"] },
          { kind: "local", id: "cold-tier", store: cold, tiers: ["cold"] },
        ],
      });

      // mutate-external -> hot
      const hotRec = await makeRecord({ run_id: "run-hot", side_effect_class: "mutate-external" });
      const hotResult = await router.route(hotRec);
      expect(hotResult.tier).toBe("hot");
      expect(hot.size()).toBe(1);
      expect(warm.size()).toBe(0);
      expect(cold.size()).toBe(0);
      expect(hotResult.sinks.find((s) => s.sinkId === "hot-tier")?.status).toBe("delivered");
      expect(hotResult.sinks.find((s) => s.sinkId === "warm-tier")?.status).toBe("tier-excluded");
      expect(hotResult.sinks.find((s) => s.sinkId === "cold-tier")?.status).toBe("tier-excluded");

      // read -> cold
      const coldRec = await makeRecord({ run_id: "run-cold", side_effect_class: "read" });
      const coldResult = await router.route(coldRec);
      expect(coldResult.tier).toBe("cold");
      expect(cold.size()).toBe(1);
      expect(hot.size()).toBe(1); // unchanged
    });

    it("a sink with no tiers accepts records of every tier", async () => {
      const all = new InMemoryEvidenceStore();
      const router = new EvidenceRouter({
        sinks: [{ kind: "local", id: "all-tier", store: all }],
      });

      await router.route(await makeRecord({ side_effect_class: "read" }));
      await router.route(await makeRecord({ side_effect_class: "network-egress" }));
      expect(all.size()).toBe(2);
    });

    it("respects a custom classifyTier override", async () => {
      const hot = new InMemoryEvidenceStore();
      const router = new EvidenceRouter({
        sinks: [{ kind: "local", id: "hot-only", store: hot, tiers: ["hot"] }],
        classifyTier: () => "hot" as StorageTier,
      });

      // Even a pure read classifies as hot under the override.
      const result = await router.route(await makeRecord({ side_effect_class: "read" }));
      expect(result.tier).toBe("hot");
      expect(hot.size()).toBe(1);
    });

    it("excludes an unclassified record (undefined tier) from tier-restricted sinks", async () => {
      const tiered = new InMemoryEvidenceStore();
      const open = new InMemoryEvidenceStore();
      const router = new EvidenceRouter({
        sinks: [
          { kind: "local", id: "tiered", store: tiered, tiers: ["hot"] },
          { kind: "local", id: "open", store: open },
        ],
        classifyTier: () => undefined,
      });

      const result = await router.route(await makeRecord());
      expect(result.tier).toBeUndefined();
      expect(tiered.size()).toBe(0);
      expect(open.size()).toBe(1);
      expect(result.sinks.find((s) => s.sinkId === "tiered")?.status).toBe("tier-excluded");
      expect(result.sinks.find((s) => s.sinkId === "open")?.status).toBe("delivered");
    });
  });

  describe("selective broadcast to subscribed auditors", () => {
    it("broadcasts every record to an unfiltered auditor", async () => {
      const router = new EvidenceRouter();
      const seen: AEPRecord[] = [];
      const sub = router.subscribe((record) => {
        seen.push(record);
      });

      await router.route(await makeRecord({ run_id: "run-1" }));
      await router.route(await makeRecord({ run_id: "run-2" }));

      expect(seen.map((r) => r.run_id)).toEqual(["run-1", "run-2"]);
      expect(sub.id).toMatch(/^auditor-\d+$/);
      expect(router.auditorCount).toBe(1);
    });

    it("only broadcasts records matching the subscription filter", async () => {
      const router = new EvidenceRouter();
      const seen: AEPRecord[] = [];
      router.subscribe((record) => seen.push(record), { action_type: "network-egress" });

      await router.route(await makeRecord({ run_id: "read-1", side_effect_class: "read" }));
      await router.route(
        await makeRecord({ run_id: "egress-1", side_effect_class: "network-egress" })
      );
      await router.route(await makeRecord({ run_id: "read-2", side_effect_class: "read" }));

      expect(seen.map((r) => r.run_id)).toEqual(["egress-1"]);
    });

    it("passes the classified tier to the auditor callback", async () => {
      const router = new EvidenceRouter();
      const tiers: (StorageTier | undefined)[] = [];
      router.subscribe((_record, tier) => {
        tiers.push(tier);
      });

      await router.route(await makeRecord({ side_effect_class: "read" }));
      await router.route(await makeRecord({ side_effect_class: "mutate-local" }));
      expect(tiers).toEqual(["cold", "warm"]);
    });

    it("unsubscribe stops further broadcasts", async () => {
      const router = new EvidenceRouter();
      const seen: AEPRecord[] = [];
      const sub = router.subscribe((record) => {
        seen.push(record);
      });

      await router.route(await makeRecord({ run_id: "before" }));
      expect(router.unsubscribe(sub)).toBe(true);
      expect(router.auditorCount).toBe(0);
      // Already-unsubscribed returns false.
      expect(router.unsubscribe(sub)).toBe(false);

      await router.route(await makeRecord({ run_id: "after" }));
      expect(seen.map((r) => r.run_id)).toEqual(["before"]);
    });

    it("fan-outs to multiple auditors independently", async () => {
      const router = new EvidenceRouter();
      const a: string[] = [];
      const b: string[] = [];
      router.subscribe((r) => a.push(r.run_id));
      router.subscribe((r) => b.push(r.run_id), { run_id: "run-target" });

      await router.route(await makeRecord({ run_id: "run-target" }));
      await router.route(await makeRecord({ run_id: "run-other" }));

      expect(a).toEqual(["run-target", "run-other"]);
      expect(b).toEqual(["run-target"]);
    });
  });

  describe("filter-gated sinks", () => {
    it("only delivers records matching the sink filter", async () => {
      const matched = new InMemoryEvidenceStore();
      const router = new EvidenceRouter({
        sinks: [{ kind: "local", id: "filtered", store: matched, filter: { action_type: "read" } }],
      });

      const readRec = await makeRecord({ run_id: "read", side_effect_class: "read" });
      const writeRec = await makeRecord({
        run_id: "write",
        side_effect_class: "mutate-local",
      });

      const r1 = await router.route(readRec);
      const r2 = await router.route(writeRec);
      expect(r1.sinks[0]?.status).toBe("delivered");
      expect(r2.sinks[0]?.status).toBe("filter-excluded");
      expect(matched.size()).toBe(1);
      expect(matched.all[0]!.run_id).toBe("read");
    });

    it("tier and filter gates compose (both must pass)", async () => {
      const sink = new InMemoryEvidenceStore();
      const router = new EvidenceRouter({
        sinks: [
          {
            kind: "local",
            id: "hot-reads",
            store: sink,
            tiers: ["hot"],
            filter: { action_type: "network-egress" },
          },
        ],
      });

      // Hot but not network-egress -> filter-excluded.
      const hotMutate = await makeRecord({
        run_id: "hot-mutate",
        side_effect_class: "mutate-external",
      });
      const r1 = await router.route(hotMutate);
      expect(r1.sinks[0]?.status).toBe("filter-excluded");

      // network-egress (hot) -> delivered.
      const egress = await makeRecord({ run_id: "egress", side_effect_class: "network-egress" });
      const r2 = await router.route(egress);
      expect(r2.sinks[0]?.status).toBe("delivered");
      expect(sink.size()).toBe(1);
    });
  });

  describe("error isolation", () => {
    it("a throwing sink does not abort other sinks or auditors", async () => {
      const good = new InMemoryEvidenceStore();
      const boom: EvidenceStore = {
        append: () => {
          throw new Error("sink blew up");
        },
        query: () => [],
        getByRunId: () => [],
        size: () => 0,
      };
      const seen: AEPRecord[] = [];

      const router = new EvidenceRouter({
        sinks: [
          { kind: "local", id: "boom", store: boom },
          { kind: "local", id: "good", store: good },
        ],
      });
      router.subscribe((r) => {
        seen.push(r);
      });

      const result = await router.route(await makeRecord());

      expect(good.size()).toBe(1); // the good sink still received the record
      expect(seen).toHaveLength(1); // the auditor still got the broadcast
      expect(result.deliveredToSinks).toBe(1);
      expect(result.deliveredToAuditors).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.target).toBe("boom");
      expect(result.errors[0]?.kind).toBe("local");
    });

    it("a rejecting auditor is captured without aborting sinks", async () => {
      const store = new InMemoryEvidenceStore();
      const router = new EvidenceRouter({
        sinks: [{ kind: "local", id: "local-1", store }],
      });
      router.subscribe(() => {
        throw new Error("auditor blew up");
      });

      const result = await router.route(await makeRecord());

      expect(store.size()).toBe(1);
      expect(result.deliveredToSinks).toBe(1);
      expect(result.deliveredToAuditors).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.kind).toBe("auditor");
    });
  });

  describe("works with async local stores (FilesystemEvidenceStore)", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "wasmagent-aep-router-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("routes to a FilesystemEvidenceStore sink and awaits the append", async () => {
      const local = new FilesystemEvidenceStore(join(dir, "evidence.ndjson"));
      await local.ready();
      const remote = new InMemoryRemoteEvidenceBackend("s3");
      const router = new EvidenceRouter({
        sinks: [
          { kind: "local", id: "fs", store: local },
          { kind: "remote", id: "s3", remote, tiers: ["hot"] },
        ],
      });

      const hotRec = await makeRecord({
        run_id: "run-fs-hot",
        side_effect_class: "network-egress",
      });
      const coldRec = await makeRecord({ run_id: "run-fs-cold", side_effect_class: "read" });

      await router.route(hotRec);
      await router.route(coldRec);

      // The local fs sink accepts every tier; both records land on disk.
      expect(await local.size()).toBe(2);
      // The remote sink is hot-only; only the hot record is archived remotely.
      expect(await remote.list()).toHaveLength(1);
      expect(await remote.get(contentDigestKeyOf(hotRec))).toBe(hotRec);
    });
  });
});

describe("EvidenceStream (#252)", () => {
  /** Helper: emit a signed AEPRecord with configurable fields. */
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
      run_id: overrides.run_id ?? "run-es-default",
      model_id: overrides.model_id,
      signer,
    });
    emitter.addAction({
      tool_name: overrides.tool_name ?? "es_tool",
      state_changing: false,
      side_effect_class: overrides.side_effect_class ?? "read",
    });
    return emitter.emit(overrides.created_at_ms ?? 1_700_000_000_000);
  }

  describe("constructor and accessors", () => {
    it("creates a stream with a generated topic", () => {
      const stream = new EvidenceStream();
      expect(stream.topic).toMatch(/^stream-[a-f0-9]{8}$/);
      expect(stream.sequence).toBe(0);
      expect(stream.subscriberCount).toBe(0);
      expect(stream.transportCount).toBe(0);
      expect(stream.closed).toBe(false);
    });

    it("accepts a custom topic", () => {
      const stream = new EvidenceStream({ topic: "custom-topic" });
      expect(stream.topic).toBe("custom-topic");
    });

    it("configures a replay buffer when replayBufferSize > 0", () => {
      const stream = new EvidenceStream({ replayBufferSize: 5 });
      expect(stream.replay()).toHaveLength(0);
    });
  });

  describe("subscribe / unsubscribe", () => {
    it("delivers published records to in-process subscribers", async () => {
      const stream = new EvidenceStream();
      const received: StreamEvent[] = [];
      stream.subscribe((event) => received.push(event));

      const record = await makeRecord();
      const result = await stream.publish(record);

      expect(result.sequence).toBe(1);
      expect(result.deliveredToSubscribers).toBe(1);
      expect(result.deliveredToTransports).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(received).toHaveLength(1);
      expect(received[0]!.record).toBe(record);
      expect(received[0]!.sequence).toBe(1);
      expect(received[0]!.topic).toBe(stream.topic);
      expect(received[0]!.publishedAtMs).toBeGreaterThan(0);
    });

    it("supports multiple independent subscribers", async () => {
      const stream = new EvidenceStream();
      const a: StreamEvent[] = [];
      const b: StreamEvent[] = [];
      stream.subscribe((e) => a.push(e));
      stream.subscribe((e) => b.push(e));

      await stream.publish(await makeRecord());

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(stream.subscriberCount).toBe(2);
    });

    it("unsubscribe stops delivery", async () => {
      const stream = new EvidenceStream();
      const received: StreamEvent[] = [];
      const sub = stream.subscribe((e) => received.push(e));

      await stream.publish(await makeRecord());
      expect(received).toHaveLength(1);

      expect(stream.unsubscribe(sub)).toBe(true);
      expect(stream.subscriberCount).toBe(0);

      await stream.publish(await makeRecord());
      expect(received).toHaveLength(1); // no new delivery
    });

    it("unsubscribe returns false for unknown subscriptions", () => {
      const stream = new EvidenceStream();
      expect(stream.unsubscribe("nonexistent")).toBe(false);
    });

    it("unsubscribe accepts a string id", async () => {
      const stream = new EvidenceStream();
      const received: StreamEvent[] = [];
      const sub = stream.subscribe((e) => received.push(e));
      expect(stream.unsubscribe(sub.id)).toBe(true);
    });
  });

  describe("content filtering", () => {
    it("only delivers events matching the subscription filter", async () => {
      const stream = new EvidenceStream();
      const filtered: StreamEvent[] = [];
      stream.subscribe((e) => filtered.push(e), { run_id: "run-es-alpha" });

      await stream.publish(await makeRecord({ run_id: "run-es-beta" }));
      await stream.publish(await makeRecord({ run_id: "run-es-alpha" }));
      await stream.publish(await makeRecord({ run_id: "run-es-gamma" }));

      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.record.run_id).toBe("run-es-alpha");
    });

    it("subscribers without a filter receive all events", async () => {
      const stream = new EvidenceStream();
      const all: StreamEvent[] = [];
      stream.subscribe((e) => all.push(e));

      await stream.publish(await makeRecord({ run_id: "run-a" }));
      await stream.publish(await makeRecord({ run_id: "run-b" }));

      expect(all).toHaveLength(2);
    });

    it("filter by tool_name", async () => {
      const stream = new EvidenceStream();
      const filtered: StreamEvent[] = [];
      stream.subscribe((e) => filtered.push(e), { tool_name: "es_special" });

      await stream.publish(await makeRecord({ tool_name: "es_other" }));
      await stream.publish(await makeRecord({ tool_name: "es_special" }));

      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.record.actions[0]!.tool_name).toBe("es_special");
    });
  });

  describe("sequence numbering", () => {
    it("assigns monotonically increasing sequence numbers", async () => {
      const stream = new EvidenceStream();
      const seqs: number[] = [];
      stream.subscribe((e) => seqs.push(e.sequence));

      for (let i = 0; i < 5; i++) {
        await stream.publish(await makeRecord({ created_at_ms: 1_700_000_000_000 + i }));
      }

      expect(seqs).toEqual([1, 2, 3, 4, 5]);
      expect(stream.sequence).toBe(5);
    });
  });

  describe("outbound transport adapters", () => {
    it("sends events to registered transport adapters", async () => {
      const stream = new EvidenceStream();
      const sent: StreamEvent[] = [];
      const transport: StreamTransportOutbound = {
        name: "mock-transport",
        send: (event) => sent.push(event),
      };
      stream.addTransport(transport);

      const record = await makeRecord();
      const result = await stream.publish(record);

      expect(result.deliveredToTransports).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.record).toBe(record);
      expect(stream.transportCount).toBe(1);
    });

    it("fans out to multiple transports", async () => {
      const stream = new EvidenceStream();
      const a: StreamEvent[] = [];
      const b: StreamEvent[] = [];
      stream.addTransport({ name: "t-a", send: (e) => a.push(e) });
      stream.addTransport({ name: "t-b", send: (e) => b.push(e) });

      await stream.publish(await makeRecord());

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it("removes a transport by name", async () => {
      const stream = new EvidenceStream();
      const sent: StreamEvent[] = [];
      stream.addTransport({ name: "removable", send: (e) => sent.push(e) });
      expect(stream.removeTransport("removable")).toBe(true);
      expect(stream.transportCount).toBe(0);

      await stream.publish(await makeRecord());
      expect(sent).toHaveLength(0);
    });

    it("removes unknown transport returns false", () => {
      const stream = new EvidenceStream();
      expect(stream.removeTransport("nope")).toBe(false);
    });

    it("isolates transport errors without aborting other deliveries", async () => {
      const stream = new EvidenceStream();
      const received: StreamEvent[] = [];
      stream.subscribe((e) => received.push(e));

      const failingTransport: StreamTransportOutbound = {
        name: "always-fails",
        send: () => {
          throw new Error("transport boom");
        },
      };
      stream.addTransport(failingTransport);

      const record = await makeRecord();
      const result = await stream.publish(record);

      // Subscriber still received the event despite transport failure
      expect(result.deliveredToSubscribers).toBe(1);
      expect(result.deliveredToTransports).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.target).toBe("transport:always-fails");
      expect(result.errors[0]!.kind).toBe("transport");
      expect((result.errors[0]!.error as Error).message).toBe("transport boom");
      expect(received).toHaveLength(1);
    });

    it("handles async transport send", async () => {
      const stream = new EvidenceStream();
      const sent: StreamEvent[] = [];
      const transport: StreamTransportOutbound = {
        name: "async-t",
        send: async (e) => {
          await Promise.resolve();
          sent.push(e);
        },
      };
      stream.addTransport(transport);

      const result = await stream.publish(await makeRecord());
      expect(result.deliveredToTransports).toBe(1);
      expect(sent).toHaveLength(1);
    });
  });

  describe("subscriber error isolation", () => {
    it("captures subscriber errors without aborting other subscribers", async () => {
      const stream = new EvidenceStream();
      const goodReceived: StreamEvent[] = [];
      stream.subscribe(() => {
        throw new Error("subscriber boom");
      });
      stream.subscribe((e) => goodReceived.push(e));

      const result = await stream.publish(await makeRecord());

      expect(result.deliveredToSubscribers).toBe(1); // only the non-throwing one counted
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.kind).toBe("subscriber");
      expect(goodReceived).toHaveLength(1);
    });

    it("handles async subscriber rejections", async () => {
      const stream = new EvidenceStream();
      stream.subscribe(async () => {
        throw new Error("async subscriber boom");
      });

      const result = await stream.publish(await makeRecord());
      // Async errors are fire-and-forget; the subscriber count includes them
      // but errors are captured asynchronously — in this sync publish, they
      // appear in result.errors via the .catch handler.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.kind).toBe("subscriber");
    });
  });

  describe("replay buffer", () => {
    it("retains recent events up to replayBufferSize", async () => {
      const stream = new EvidenceStream({ replayBufferSize: 3 });

      for (let i = 0; i < 5; i++) {
        await stream.publish(await makeRecord({ created_at_ms: 1_700_000_000_000 + i }));
      }

      const replayed = stream.replay();
      expect(replayed).toHaveLength(3);
      expect(replayed[0]!.sequence).toBe(3);
      expect(replayed[1]!.sequence).toBe(4);
      expect(replayed[2]!.sequence).toBe(5);
    });

    it("replay with count parameter returns fewer events", async () => {
      const stream = new EvidenceStream({ replayBufferSize: 5 });

      for (let i = 0; i < 5; i++) {
        await stream.publish(await makeRecord());
      }

      expect(stream.replay(2)).toHaveLength(2);
      expect(stream.replay(2)[0]!.sequence).toBe(4);
    });

    it("replay returns empty array when buffer size is 0", async () => {
      const stream = new EvidenceStream({ replayBufferSize: 0 });
      await stream.publish(await makeRecord());
      expect(stream.replay()).toHaveLength(0);
    });
  });

  describe("inbound transport adapters", () => {
    it("feeds inbound events to local subscribers", async () => {
      const stream = new EvidenceStream();
      const received: StreamEvent[] = [];
      stream.subscribe((e) => received.push(e));

      let onEventCallback: ((event: StreamEvent) => void) | undefined;
      const inbound: StreamTransportInbound = {
        name: "test-inbound",
        listen: (onEvent) => {
          onEventCallback = onEvent;
          return () => {
            onEventCallback = undefined;
          };
        },
      };
      await stream.addInbound(inbound);

      // Simulate an event arriving from remote
      const record = await makeRecord({ run_id: "run-inbound" });
      const inboundEvent: StreamEvent = {
        record,
        sequence: 100,
        publishedAtMs: Date.now(),
        topic: "remote-topic",
      };
      onEventCallback!(inboundEvent);

      expect(received).toHaveLength(1);
      expect(received[0]!.record.run_id).toBe("run-inbound");
    });

    it("inbound events do NOT re-broadcast to outbound transports", async () => {
      const stream = new EvidenceStream();
      const sent: StreamEvent[] = [];
      stream.addTransport({ name: "out-t", send: (e) => sent.push(e) });

      let onEventCallback: ((event: StreamEvent) => void) | undefined;
      await stream.addInbound({
        name: "in-t",
        listen: (onEvent) => {
          onEventCallback = onEvent;
          return () => {};
        },
      });

      const record = await makeRecord();
      onEventCallback!({
        record,
        sequence: 1,
        publishedAtMs: Date.now(),
        topic: "t",
      });

      // Outbound transport should NOT receive the inbound event (prevents loops)
      expect(sent).toHaveLength(0);
    });

    it("supports async listen that returns a cleanup function", async () => {
      const stream = new EvidenceStream();
      let cleanedUp = false;

      await stream.addInbound({
        name: "async-inbound",
        listen: async () => () => {
          cleanedUp = true;
        },
      });

      await stream.close();
      expect(cleanedUp).toBe(true);
    });
  });

  describe("close lifecycle", () => {
    it("closes all outbound transports on close", async () => {
      const stream = new EvidenceStream();
      let closed = false;
      stream.addTransport({
        name: "closeable",
        send: () => {},
        close: () => {
          closed = true;
        },
      });

      await stream.close();
      expect(closed).toBe(true);
      expect(stream.closed).toBe(true);
    });

    it("clears subscribers and replay buffer on close", async () => {
      const stream = new EvidenceStream({ replayBufferSize: 5 });
      stream.subscribe(() => {});
      await stream.publish(await makeRecord());
      expect(stream.subscriberCount).toBe(1);
      expect(stream.replay()).toHaveLength(1);

      await stream.close();
      expect(stream.subscriberCount).toBe(0);
      expect(stream.replay()).toHaveLength(0);
    });

    it("best-effort cleanup ignores transport close errors", async () => {
      const stream = new EvidenceStream();
      stream.addTransport({
        name: "boom-on-close",
        send: () => {},
        close: () => {
          throw new Error("close boom");
        },
      });

      // Should not throw
      await stream.close();
      expect(stream.closed).toBe(true);
    });
  });

  describe("closed stream guards", () => {
    it("rejects subscribe on a closed stream", async () => {
      const stream = new EvidenceStream();
      await stream.close();
      expect(() => stream.subscribe(() => {})).toThrow(
        "Cannot subscribe to a closed EvidenceStream"
      );
    });

    it("rejects addTransport on a closed stream", async () => {
      const stream = new EvidenceStream();
      await stream.close();
      expect(() => stream.addTransport({ name: "t", send: () => {} })).toThrow(
        "Cannot add transport to a closed EvidenceStream"
      );
    });

    it("rejects addInbound on a closed stream", async () => {
      const stream = new EvidenceStream();
      await stream.close();
      await expect(stream.addInbound({ name: "in", listen: () => {} })).rejects.toThrow(
        "Cannot add inbound transport to a closed EvidenceStream"
      );
    });

    it("rejects publish on a closed stream", async () => {
      const stream = new EvidenceStream();
      await stream.close();
      await expect(stream.publish(await makeRecord())).rejects.toThrow(
        "Cannot publish to a closed EvidenceStream"
      );
    });
  });

  describe("integration: subscriber + transport + replay", () => {
    it("end-to-end: publish fans out to subscriber, transport, and replay buffer", async () => {
      const stream = new EvidenceStream({ topic: "e2e", replayBufferSize: 10 });
      const subscriberEvents: StreamEvent[] = [];
      const transportEvents: StreamEvent[] = [];

      stream.subscribe((e) => subscriberEvents.push(e));
      stream.addTransport({
        name: "e2e-transport",
        send: (e) => transportEvents.push(e),
      });

      const record = await makeRecord({ run_id: "run-e2e" });
      const result = await stream.publish(record);

      // Subscriber received
      expect(subscriberEvents).toHaveLength(1);
      expect(subscriberEvents[0]!.record.run_id).toBe("run-e2e");
      expect(subscriberEvents[0]!.topic).toBe("e2e");

      // Transport received
      expect(transportEvents).toHaveLength(1);
      expect(transportEvents[0]!.record.run_id).toBe("run-e2e");

      // Replay buffer
      const replayed = stream.replay();
      expect(replayed).toHaveLength(1);
      expect(replayed[0]!.record.run_id).toBe("run-e2e");

      // Result summary
      expect(result.sequence).toBe(1);
      expect(result.deliveredToSubscribers).toBe(1);
      expect(result.deliveredToTransports).toBe(1);
      expect(result.errors).toHaveLength(0);
    });
  });
});

describe("EvidenceMonitor — real-time monitoring hooks (#265)", () => {
  /** Emit a signed AEPRecord with configurable fields. */
  async function makeRecord(
    overrides: {
      run_id?: string;
      model_id?: string;
      created_at_ms?: number;
      tool_name?: string;
      side_effect_class?: SideEffectClass;
      actions?: number;
    } = {}
  ): Promise<AEPRecord> {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({
      run_id: overrides.run_id ?? "run-mon-default",
      model_id: overrides.model_id,
      signer,
    });
    const actionCount = overrides.actions ?? 1;
    for (let i = 0; i < actionCount; i++) {
      emitter.addAction({
        tool_name: overrides.tool_name ?? "mon_tool",
        state_changing: false,
        side_effect_class: overrides.side_effect_class ?? "read",
      });
    }
    return emitter.emit(overrides.created_at_ms ?? 1_700_000_000_000);
  }

  /** Mock fetch that records every call. */
  function recorderFetch(responder: (url: string, init: RequestInit) => Response): {
    fetcher: typeof fetch;
    calls: Array<{ url: string; body: string; headers: Record<string, string> }>;
  } {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetcher = (async (url: string | Request, init?: RequestInit) => {
      const u = String(url);
      const i = init ?? {};
      calls.push({
        url: u,
        body: typeof i.body === "string" ? i.body : "",
        headers: (i.headers ?? {}) as Record<string, string>,
      });
      return responder(u, i as RequestInit);
    }) as typeof fetch;
    return { fetcher, calls };
  }

  /** Minimal fake WebSocket conforming to WebSocketLike. */
  function fakeSocket(open: boolean): WebSocketLike & {
    sent: string[];
    setReadyState(v: number): void;
    closed: boolean;
    failNextSend?: boolean;
  } {
    const sent: string[] = [];
    let readyState = open ? 1 : 0;
    let closed = false;
    return {
      sent,
      get readyState() {
        return readyState;
      },
      setReadyState(v: number) {
        readyState = v;
      },
      get closed() {
        return closed;
      },
      send(data: string) {
        if (this.failNextSend) {
          this.failNextSend = false;
          throw new Error("socket send boom");
        }
        sent.push(data);
      },
      close() {
        closed = true;
      },
    };
  }

  describe("validateWebhookUrl (SSRF guard)", () => {
    it("accepts a plain https URL", () => {
      expect(() => validateWebhookUrl("https://example.com/hook")).not.toThrow();
    });

    it("rejects non-https schemes", () => {
      expect(() => validateWebhookUrl("http://example.com/hook")).toThrow(/must use https/);
    });

    it("rejects loopback addresses", () => {
      expect(() => validateWebhookUrl("https://127.0.0.1/hook")).toThrow(/private\/internal/);
    });

    it("rejects RFC-1918 ranges", () => {
      expect(() => validateWebhookUrl("https://10.0.0.1/hook")).toThrow(/private\/internal/);
      expect(() => validateWebhookUrl("https://192.168.1.1/hook")).toThrow(/private\/internal/);
    });

    it("rejects localhost", () => {
      expect(() => validateWebhookUrl("https://localhost/hook")).toThrow(/private\/internal/);
    });

    it("rejects malformed URLs", () => {
      expect(() => validateWebhookUrl("not-a-url")).toThrow(/Invalid webhook URL/);
    });
  });

  describe("WebhookMonitorHook — webhook subscriptions", () => {
    it("fails fast on construction when a URL is private (SSRF)", () => {
      expect(
        () =>
          new WebhookMonitorHook({
            urls: ["https://127.0.0.1/x"],
            fetcher: (() => null) as typeof fetch,
          })
      ).toThrow(/private\/internal/);
    });

    it("requires at least one URL", () => {
      expect(() => new WebhookMonitorHook({ urls: [] })).toThrow(/at least one URL/);
    });

    it("POSTs each event to every configured URL", async () => {
      const { fetcher, calls } = recorderFetch(() => new Response("ok", { status: 200 }));
      const hook = new WebhookMonitorHook({
        urls: ["https://example.com/a", "https://example.com/b"],
        fetcher,
      });

      const stream = new EvidenceStream();
      stream.addTransport(hook);
      await stream.publish(await makeRecord({ run_id: "run-wh-1" }));

      expect(calls).toHaveLength(2);
      expect(calls[0]!.url).toBe("https://example.com/a");
      expect(calls[1]!.url).toBe("https://example.com/b");
      // Default payload hoists run_id and nests the full record.
      const body = JSON.parse(calls[0]!.body);
      expect(body.run_id).toBe("run-wh-1");
      expect(body.record.run_id).toBe("run-wh-1");
      expect(body.record.schema_version).toMatch(/^aep\/v0/);
    });

    it("records per-URL delivery results in lastResults", async () => {
      const { fetcher } = recorderFetch(() => new Response("ok", { status: 200 }));
      const hook = new WebhookMonitorHook({ urls: ["https://example.com/a"], fetcher });
      const stream = new EvidenceStream();
      stream.addTransport(hook);
      await stream.publish(await makeRecord());

      expect(hook.lastResults).toHaveLength(1);
      expect(hook.lastResults[0]!.ok).toBe(true);
      expect(hook.lastResults[0]!.status).toBe(200);
      expect(hook.lastResults[0]!.attempts).toBe(1);
    });

    it("retries with backoff on failure then reports the final status", async () => {
      let calls = 0;
      const { fetcher } = recorderFetch(() => {
        calls++;
        return new Response("nope", { status: 500 });
      });
      const hook = new WebhookMonitorHook({
        urls: ["https://example.com/a"],
        maxRetries: 3,
        backoffMs: 1,
        fetcher,
      });
      const stream = new EvidenceStream();
      stream.addTransport(hook);
      await stream.publish(await makeRecord());

      expect(calls).toBe(3);
      expect(hook.lastResults[0]!.ok).toBe(false);
      expect(hook.lastResults[0]!.attempts).toBe(3);
      expect(hook.lastResults[0]!.status).toBe(500);
      expect(hook.lastResults[0]!.error).toBe("HTTP 500");
    });

    it("signs the payload with HMAC-SHA-256 when a secret is set", async () => {
      const { fetcher, calls } = recorderFetch(() => new Response("ok", { status: 200 }));
      const hook = new WebhookMonitorHook({
        urls: ["https://example.com/a"],
        secret: "topsecret",
        fetcher,
      });
      const stream = new EvidenceStream();
      stream.addTransport(hook);
      await stream.publish(await makeRecord());

      expect(calls[0]!.headers["X-Wasmagent-Signature"]).toMatch(/^sha256=[a-f0-9]+$/);
    });

    it("writes persistently-failed deliveries to the DLQ backend", async () => {
      const dlqStore = new Map<string, string>();
      const dlqBackend: DeadLetterBackend = {
        put: async (k: string, v: string) => void dlqStore.set(k, v),
      };
      const { fetcher } = recorderFetch(() => new Response("err", { status: 503 }));
      const hook = new WebhookMonitorHook({
        urls: ["https://example.com/a"],
        maxRetries: 2,
        backoffMs: 1,
        dlqBackend,
        fetcher,
      });
      const stream = new EvidenceStream({ topic: "dlq-topic" });
      stream.addTransport(hook);
      await stream.publish(await makeRecord());

      expect(dlqStore.size).toBe(1);
      const [key, raw] = [...dlqStore.entries()][0]!;
      expect(key).toMatch(/^dlq:dlq-topic:1:[a-f0-9]+$/);
      const stored = JSON.parse(raw);
      expect(stored.ok).toBe(false);
      expect(stored.status).toBe(503);
      expect(stored.payload.run_id).toBe("run-mon-default");
    });

    it("only delivers events matching the hook filter", async () => {
      const { fetcher, calls } = recorderFetch(() => new Response("ok", { status: 200 }));
      const hook = new WebhookMonitorHook({
        urls: ["https://example.com/a"],
        filter: { tool_name: "mon_special" },
        fetcher,
      });
      const stream = new EvidenceStream();
      stream.addTransport(hook);
      await stream.publish(await makeRecord({ tool_name: "mon_other" }));
      await stream.publish(await makeRecord({ tool_name: "mon_special" }));

      expect(calls).toHaveLength(1);
      const body = JSON.parse(calls[0]!.body);
      expect(body.record.actions[0].tool_name).toBe("mon_special");
    });

    it("supports a custom payloadFor transform", async () => {
      const { fetcher, calls } = recorderFetch(() => new Response("ok", { status: 200 }));
      const hook = new WebhookMonitorHook({
        urls: ["https://example.com/a"],
        payloadFor: (event) => ({ seq: event.sequence, rid: event.record.run_id }),
        fetcher,
      });
      const stream = new EvidenceStream();
      stream.addTransport(hook);
      await stream.publish(await makeRecord({ run_id: "run-custom" }));

      const body = JSON.parse(calls[0]!.body);
      expect(body).toEqual({ seq: 1, rid: "run-custom" });
    });
  });

  describe("WebSocketMonitorHook — WebSocket streaming", () => {
    it("serializes and sends each event when the socket is open", async () => {
      const socket = fakeSocket(true);
      const stream = new EvidenceStream();
      stream.addTransport(new WebSocketMonitorHook({ socket }));
      await stream.publish(await makeRecord({ run_id: "run-ws-1" }));

      expect(socket.sent).toHaveLength(1);
      const msg = JSON.parse(socket.sent[0]!);
      expect(msg.record.run_id).toBe("run-ws-1");
      expect(msg.sequence).toBe(1);
    });

    it("drops events when the socket is not open (no throw)", async () => {
      const socket = fakeSocket(false);
      const hook = new WebSocketMonitorHook({ socket });
      const stream = new EvidenceStream();
      stream.addTransport(hook);
      const result = await stream.publish(await makeRecord());

      expect(socket.sent).toHaveLength(0);
      expect(hook.droppedCount).toBe(1);
      expect(hook.sentCount).toBe(0);
      // Best-effort: dropped events do not surface as delivery errors.
      expect(result.errors).toHaveLength(0);
    });

    it("only streams events matching the filter", async () => {
      const socket = fakeSocket(true);
      const stream = new EvidenceStream();
      stream.addTransport(new WebSocketMonitorHook({ socket, filter: { run_id: "run-ws-match" } }));
      await stream.publish(await makeRecord({ run_id: "run-ws-skip" }));
      await stream.publish(await makeRecord({ run_id: "run-ws-match" }));

      expect(socket.sent).toHaveLength(1);
      expect(JSON.parse(socket.sent[0]!).record.run_id).toBe("run-ws-match");
    });

    it("captures send errors without aborting the fan-out", async () => {
      const socket = fakeSocket(true);
      socket.failNextSend = true;
      const hook = new WebSocketMonitorHook({ socket });
      const stream = new EvidenceStream();
      stream.addTransport(hook);
      await stream.publish(await makeRecord());

      expect(hook.lastError).toBeInstanceOf(Error);
      expect((hook.lastError as Error).message).toBe("socket send boom");
      expect(hook.droppedCount).toBe(1);
      expect(hook.sentCount).toBe(0);
    });

    it("uses a custom serializer", async () => {
      const socket = fakeSocket(true);
      const stream = new EvidenceStream();
      stream.addTransport(
        new WebSocketMonitorHook({
          socket,
          serialize: (event) => `SEQ=${event.sequence}`,
        })
      );
      await stream.publish(await makeRecord());

      expect(socket.sent).toEqual(["SEQ=1"]);
    });

    it("closes the socket on stream close", async () => {
      const socket = fakeSocket(true);
      const stream = new EvidenceStream();
      stream.addTransport(new WebSocketMonitorHook({ socket }));
      await stream.close();

      expect(socket.closed).toBe(true);
    });
  });

  describe("ComplianceDashboardObserver — in-process observers", () => {
    it("aggregates counts by run_id, tool, side-effect class, and model", async () => {
      const stream = new EvidenceStream();
      const observer = new ComplianceDashboardObserver();
      stream.subscribe(observer.handle);

      await stream.publish(
        await makeRecord({
          run_id: "run-A",
          model_id: "model-X",
          tool_name: "tool-read",
          side_effect_class: "read",
        })
      );
      await stream.publish(
        await makeRecord({
          run_id: "run-A",
          model_id: "model-Y",
          tool_name: "tool-write",
          side_effect_class: "mutate-local",
        })
      );
      await stream.publish(
        await makeRecord({
          run_id: "run-B",
          model_id: "model-X",
          tool_name: "tool-read",
          side_effect_class: "network-egress",
        })
      );

      const snap = observer.snapshot;
      expect(snap.totalEvents).toBe(3);
      expect(snap.byRunId).toEqual({ "run-A": 2, "run-B": 1 });
      expect(snap.byTool).toEqual({ "tool-read": 2, "tool-write": 1 });
      expect(snap.byModelId).toEqual({ "model-X": 2, "model-Y": 1 });
      expect(snap.bySideEffectClass.read).toBe(1);
      expect(snap.bySideEffectClass["mutate-local"]).toBe(1);
      expect(snap.bySideEffectClass["network-egress"]).toBe(1);
      expect(snap.totalActions).toBe(3);
    });

    it("always exposes all five side-effect-class keys (zero-filled)", async () => {
      const stream = new EvidenceStream();
      const observer = new ComplianceDashboardObserver();
      stream.subscribe(observer.handle);
      await stream.publish(await makeRecord());

      const keys = Object.keys(observer.snapshot.bySideEffectClass).sort();
      expect(keys).toEqual(
        ["mutate-external", "mutate-local", "network-egress", "read", "unknown"].sort()
      );
    });

    it("maintains a bounded rolling window of recent events", async () => {
      const stream = new EvidenceStream();
      const observer = new ComplianceDashboardObserver({ windowSize: 3 });
      stream.subscribe(observer.handle);

      for (let i = 0; i < 5; i++) {
        await stream.publish(await makeRecord({ created_at_ms: 1_700_000_000_000 + i }));
      }

      const snap = observer.snapshot;
      expect(snap.totalEvents).toBe(5); // total is unaffected by window size
      expect(snap.recent).toHaveLength(3);
      expect(snap.recent[0]!.sequence).toBe(3);
      expect(snap.recent[2]!.sequence).toBe(5);
    });

    it("only aggregates events matching the filter", async () => {
      const stream = new EvidenceStream();
      const observer = new ComplianceDashboardObserver({ filter: { run_id: "run-keep" } });
      stream.subscribe(observer.handle);

      await stream.publish(await makeRecord({ run_id: "run-skip" }));
      await stream.publish(await makeRecord({ run_id: "run-keep" }));

      expect(observer.snapshot.totalEvents).toBe(1);
      expect(observer.snapshot.byRunId).toEqual({ "run-keep": 1 });
    });

    it("invokes the onEvent callback for each matching event", async () => {
      const stream = new EvidenceStream();
      const seen: StreamEvent[] = [];
      const observer = new ComplianceDashboardObserver({
        filter: { run_id: "run-cb" },
        onEvent: (e) => seen.push(e),
      });
      stream.subscribe(observer.handle);

      await stream.publish(await makeRecord({ run_id: "run-cb" }));
      await stream.publish(await makeRecord({ run_id: "run-other" }));

      expect(seen).toHaveLength(1);
      expect(seen[0]!.record.run_id).toBe("run-cb");
    });

    it("tracks firstSeenMs and lastSeenMs", async () => {
      const stream = new EvidenceStream();
      const observer = new ComplianceDashboardObserver();
      stream.subscribe(observer.handle);

      expect(observer.snapshot.firstSeenMs).toBeNull();
      await stream.publish(await makeRecord());
      const first = observer.snapshot.firstSeenMs;
      await stream.publish(await makeRecord());

      expect(first).not.toBeNull();
      expect(observer.snapshot.lastSeenMs).not.toBeNull();
      expect(observer.snapshot.lastSeenMs!).toBeGreaterThanOrEqual(first!);
    });

    it("reset() clears all aggregates and the recent window", async () => {
      const stream = new EvidenceStream();
      const observer = new ComplianceDashboardObserver();
      stream.subscribe(observer.handle);
      await stream.publish(await makeRecord());
      expect(observer.snapshot.totalEvents).toBe(1);

      observer.reset();
      const snap = observer.snapshot;
      expect(snap.totalEvents).toBe(0);
      expect(snap.recent).toHaveLength(0);
      expect(snap.byRunId).toEqual({});
      expect(snap.firstSeenMs).toBeNull();
    });
  });

  describe("EvidenceMonitor — unified container", () => {
    it("creates an underlying stream with the configured topic", () => {
      const monitor = new EvidenceMonitor({ topic: "compliance-feed" });
      expect(monitor.topic).toBe("compliance-feed");
      expect(monitor.stream).toBeInstanceOf(EvidenceStream);
      expect(monitor.hookCount).toBe(0);
      expect(monitor.observerCount).toBe(0);
    });

    it("can wrap an existing EvidenceStream", () => {
      const stream = new EvidenceStream({ topic: "preexisting" });
      const monitor = new EvidenceMonitor({ stream });
      expect(monitor.stream).toBe(stream);
      expect(monitor.topic).toBe("preexisting");
    });

    it("fans a published record out to webhook, websocket, and observer hooks", async () => {
      const { fetcher, calls } = recorderFetch(() => new Response("ok", { status: 200 }));
      const socket = fakeSocket(true);
      const monitor = new EvidenceMonitor({ topic: "all-hooks" });

      const dashboard = monitor.observe({ windowSize: 5 });
      monitor.addWebhook({ urls: ["https://example.com/a"], fetcher });
      monitor.addWebSocket({ socket });

      await monitor.publish(await makeRecord({ run_id: "run-fanout" }));

      // Webhook
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]!.body).run_id).toBe("run-fanout");
      // WebSocket
      expect(socket.sent).toHaveLength(1);
      // Observer
      expect(dashboard.snapshot.totalEvents).toBe(1);
      expect(dashboard.snapshot.byRunId).toEqual({ "run-fanout": 1 });

      expect(monitor.hookCount).toBe(2);
      expect(monitor.observerCount).toBe(1);
    });

    it("close() tears down the websocket hook (closing the socket)", async () => {
      const socket = fakeSocket(true);
      const monitor = new EvidenceMonitor();
      monitor.addWebSocket({ socket });
      await monitor.close();

      expect(socket.closed).toBe(true);
      expect(monitor.stream.closed).toBe(true);
    });

    it("isolates a failing webhook URL from observer delivery", async () => {
      // A webhook whose fetcher throws on every attempt must not stop the
      // observer from receiving the event.
      const { fetcher } = recorderFetch(() => {
        throw new Error("network down");
      });
      const socket = fakeSocket(true);
      const monitor = new EvidenceMonitor();
      const dashboard = monitor.observe();
      monitor.addWebhook({ urls: ["https://example.com/a"], maxRetries: 1, backoffMs: 1, fetcher });
      monitor.addWebSocket({ socket });

      await monitor.publish(await makeRecord());

      // Observer and websocket still received the event despite webhook failure.
      expect(dashboard.snapshot.totalEvents).toBe(1);
      expect(socket.sent).toHaveLength(1);
      expect(monitor.stream.transportCount).toBe(2);
    });
  });
});

describe("EvidencePublisher — real-time streaming (#276)", () => {
  /** Helper: emit a signed AEPRecord with configurable fields. */
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
      run_id: overrides.run_id ?? "run-pub-default",
      model_id: overrides.model_id,
      signer,
    });
    emitter.addAction({
      tool_name: overrides.tool_name ?? "pub_tool",
      state_changing: false,
      side_effect_class: overrides.side_effect_class ?? "read",
    });
    return emitter.emit(overrides.created_at_ms ?? 1_700_000_000_000);
  }

  /** Capture transport that records every event handed to `send`. */
  function captureTransport(name = "capture"): StreamTransportOutbound & { events: StreamEvent[] } {
    const events: StreamEvent[] = [];
    return {
      name,
      events,
      async send(event: StreamEvent) {
        events.push(event);
      },
    };
  }

  describe("constructor and accessors", () => {
    it("creates a stream with a generated topic", () => {
      const publisher = new EvidencePublisher();
      expect(publisher.topic).toMatch(/^stream-[a-f0-9]{8}$/);
      expect(publisher.running).toBe(false);
      expect(publisher.closed).toBe(false);
      expect(publisher.stats).toEqual({ published: 0, filtered: 0, errors: 0, storePolled: 0 });
    });

    it("accepts a custom topic", () => {
      const publisher = new EvidencePublisher({ topic: "live-evidence" });
      expect(publisher.topic).toBe("live-evidence");
    });

    it("wraps a caller-supplied stream", () => {
      const stream = new EvidenceStream({ topic: "external" });
      const publisher = new EvidencePublisher({ stream });
      expect(publisher.stream).toBe(stream);
      expect(publisher.topic).toBe("external");
    });
  });

  describe("push mode — publish()", () => {
    it("delivers pushed records to subscribers and transports", async () => {
      const publisher = new EvidencePublisher();
      const received: StreamEvent[] = [];
      publisher.subscribe((event) => received.push(event));
      const transport = captureTransport();
      publisher.addTransport(transport);

      const record = await makeRecord();
      const result = await publisher.publish(record);

      expect(result.deliveredToSubscribers).toBe(1);
      expect(result.deliveredToTransports).toBe(1);
      expect(received).toHaveLength(1);
      expect(received[0]!.record).toBe(record);
      expect(transport.events).toHaveLength(1);
      expect(transport.events[0]!.record).toBe(record);
      expect(publisher.stats.published).toBe(1);
      expect(publisher.stats.errors).toBe(0);
    });

    it("counts per-target delivery errors without aborting the fan-out", async () => {
      const publisher = new EvidencePublisher();
      const good: StreamEvent[] = [];
      publisher.subscribe((event) => good.push(event));
      publisher.addTransport({
        name: "boom",
        async send() {
          throw new Error("transport down");
        },
      });

      const result = await publisher.publish(await makeRecord());

      // Subscriber still received it; the failing transport is captured, not thrown.
      expect(good).toHaveLength(1);
      expect(result.deliveredToTransports).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.target).toBe("transport:boom");
      expect(publisher.stats.published).toBe(1);
      expect(publisher.stats.errors).toBe(1);
    });

    it("throws once closed", async () => {
      const publisher = new EvidencePublisher();
      await publisher.close();
      expect(publisher.closed).toBe(true);
      await expect(publisher.publish(await makeRecord())).rejects.toThrow("closed");
    });
  });

  describe("subscriber / transport management", () => {
    it("supports unsubscribe and removeTransport", async () => {
      const publisher = new EvidencePublisher();
      const received: StreamEvent[] = [];
      const sub = publisher.subscribe((event) => received.push(event));
      const transport = captureTransport();
      publisher.addTransport(transport);

      await publisher.publish(await makeRecord());
      expect(received).toHaveLength(1);
      expect(transport.events).toHaveLength(1);

      expect(publisher.unsubscribe(sub)).toBe(true);
      expect(publisher.removeTransport("capture")).toBe(true);

      await publisher.publish(await makeRecord());
      expect(received).toHaveLength(1); // no new delivery
      expect(transport.events).toHaveLength(1);
      await publisher.close();
    });
  });

  describe("watch mode — start()/stop()", () => {
    it("streams records appended after start, never the pre-existing tail", async () => {
      const store = new InMemoryEvidenceStore();
      // Pre-existing records must NOT be replayed on start.
      await store.append(await makeRecord({ run_id: "old" }));

      const publisher = new EvidencePublisher({ store, pollIntervalMs: 5 });
      const seen: string[] = [];
      publisher.subscribe((event) => seen.push(event.record.run_id));

      await publisher.start();
      expect(publisher.running).toBe(true);
      expect(seen).toEqual([]); // old record not replayed

      // Append two new records; they should appear on subsequent polls.
      await store.append(await makeRecord({ run_id: "new-1" }));
      await store.append(await makeRecord({ run_id: "new-2" }));

      // Wait for at least one poll after the appends.
      await waitForStats(publisher, (s) => s.published >= 2);
      publisher.stop();
      expect(publisher.running).toBe(false);

      expect(seen).toEqual(["new-1", "new-2"]);
      expect(publisher.stats.published).toBe(2);
      expect(publisher.stats.storePolled).toBeGreaterThan(0);
    });

    it("applies the filter to records pulled from the store", async () => {
      const store = new InMemoryEvidenceStore();
      const publisher = new EvidencePublisher({
        store,
        pollIntervalMs: 5,
        filter: { run_id: "wanted" },
      });
      const seen: string[] = [];
      publisher.subscribe((event) => seen.push(event.record.run_id));

      await publisher.start();
      await store.append(await makeRecord({ run_id: "wanted" }));
      await store.append(await makeRecord({ run_id: "skipped" }));
      await store.append(await makeRecord({ run_id: "wanted" }));

      await waitForStats(publisher, (s) => s.published >= 2 && s.filtered >= 1);
      publisher.stop();

      expect(seen).toEqual(["wanted", "wanted"]);
      expect(publisher.stats.filtered).toBe(1);
    });

    it("requires a store to start", async () => {
      const publisher = new EvidencePublisher();
      await expect(publisher.start()).rejects.toThrow("requires a store");
      expect(publisher.running).toBe(false);
    });

    it("counts a failing store query as an error without stopping the loop", async () => {
      // A store whose query rejects on the first streaming poll.
      let queryCalls = 0;
      const store: EvidenceStore = {
        async append() {},
        async query() {
          queryCalls++;
          if (queryCalls === 1) return []; // the start() initial sizing read
          throw new Error("store IO failure");
        },
        async getByRunId() {
          return [];
        },
        async size() {
          return 0;
        },
      };
      const publisher = new EvidencePublisher({ store, pollIntervalMs: 5 });
      await publisher.start();

      await waitForStats(publisher, (s) => s.errors >= 1);
      publisher.stop();

      expect(publisher.stats.errors).toBeGreaterThanOrEqual(1);
      expect(publisher.stats.storePolled).toBeGreaterThanOrEqual(0);
    });

    it("start() is idempotent and close() stops polling and closes the stream", async () => {
      const store = new InMemoryEvidenceStore();
      const publisher = new EvidencePublisher({ store, pollIntervalMs: 5 });
      await publisher.start();
      const timerCountBefore = publisher.running;
      await publisher.start(); // no-op
      expect(publisher.running).toBe(timerCountBefore);

      await publisher.close();
      expect(publisher.running).toBe(false);
      expect(publisher.closed).toBe(true);
      expect(publisher.stream.closed).toBe(true);
      await expect(publisher.start()).rejects.toThrow("closed");
    });
  });
});

/** Poll `publisher.stats` until `pred` is satisfied or the timeout elapses. */
async function waitForStats(
  publisher: EvidencePublisher,
  pred: (s: EvidencePublisherStats) => boolean,
  timeoutMs = 1000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred(publisher.stats)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  // Timed out; let the caller's expect() surface the mismatch.
}
