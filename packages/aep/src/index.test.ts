import { describe, expect, it } from "bun:test";
import { AEPEmitter } from "./emitter.js";
import { AEPRecordSchema } from "./types.js";
import { createLocalSignerFromSeed } from "./signer.js";
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
    await expect(emitter.emit()).rejects.toThrow(
      "AEPEmitter.emit() requires a signer"
    );
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
