/**
 * Adversarial and boundary tests for the AEP evidence chain.
 *
 * Each test is an attack or hostile input an attacker (or a buggy producer)
 * could aim at the emitter/verifier. Nothing here may crash the process;
 * every rejection must be a clean, diagnosable failure.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyDSSEEnvelope } from "./dsse.js";
import { AEPEmitter } from "./emitter.js";
import { createLocalSignerFromSeed } from "./signer.js";
import type { AEPRecord } from "./types.js";
import { verifyAEPRecord } from "./verify.js";

const TEST_SEED = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const TEST_KEY_ID = "test-key-01";

// ---------------------------------------------------------------------------
// Envelope-lifting / key-substitution attacks
// ---------------------------------------------------------------------------

describe("adversarial — envelope and key substitution", () => {
  it("rejects a DSSE envelope lifted from a different record", async () => {
    const signerA = createLocalSignerFromSeed("aa".repeat(32), "key-a");
    const emitterA = new AEPEmitter({
      run_id: "run-victim",
      signer: signerA,
      schemaVersion: "aep/v0.5",
      useDsse: true,
    });
    emitterA.addAction({ tool_name: "transfer_money", state_changing: true });
    const victim = await emitterA.emit();

    const signerB = createLocalSignerFromSeed("bb".repeat(32), "key-b");
    const emitterB = new AEPEmitter({ run_id: "run-attacker", signer: signerB });
    emitterB.addAction({ tool_name: "benign_read", state_changing: false });
    const attacker = await emitterB.build();

    // Attack: swap the victim's signed envelope onto the attacker's record
    const lifted = { ...attacker, dsse_envelope: victim.dsse_envelope! } as AEPRecord;
    const pubA = await signerA.getPublicKey();
    expect(await verifyAEPRecord(lifted, pubA)).toBe(false);
  });

  it("rejects verification with the wrong public key", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({ run_id: "r", signer, schemaVersion: "aep/v0.5" });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    const record = await emitter.emit();

    const wrongPub = new Uint8Array(32).fill(1);
    expect(await verifyAEPRecord(record, wrongPub)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Signature encoding attacks
// ---------------------------------------------------------------------------

describe("adversarial — signature encodings", () => {
  it("rejects a hex-encoded signature (legacy gateway format)", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({ run_id: "r", signer, schemaVersion: "aep/v0.5" });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    const record = await emitter.emit();

    // The Rust gateway used to emit hex; simulate that encoding here and
    // confirm the JS verifier still reads base64-only and rejects it.
    const pub = await signer.getPublicKey();
    const sigB64 = record.signature.sig;
    const raw = Buffer.from(sigB64, "base64");
    const recordHex = {
      ...record,
      signature: { ...record.signature, sig: raw.toString("hex") },
    } as AEPRecord;
    expect(await verifyAEPRecord(recordHex, pub)).toBe(false);
  });

  it("rejects corrupted signature bytes for every corruption mode", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({ run_id: "r", signer });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    const record = await emitter.emit();
    const pub = await signer.getPublicKey();

    for (const corruption of [
      "", // empty
      "!!!not-base64!!!", // invalid alphabet
      "Ug==", // decodes but wrong length
      "UdD9", // decodes but wrong length
    ]) {
      const mutated = {
        ...record,
        signature: { ...record.signature, sig: corruption },
      } as AEPRecord;
      expect(await verifyAEPRecord(mutated, pub)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Attribution floor consistency attacks
// ---------------------------------------------------------------------------

describe("adversarial — attribution floor consistency", () => {
  it("throws when a caller-supplied floor is stronger than observed", () => {
    const emitter = new AEPEmitter({
      run_id: "r",
      schemaVersion: "aep/v0.5",
      run_attribution_backing_observed: ["operator_asserted"],
      run_attribution_backing_floor: "qualified_signature", // lied upward
    });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    expect(() => emitter.build()).toThrow("MUST NOT round up");
  });

  it("auto-computes the floor as the weakest observed grade", () => {
    const emitter = new AEPEmitter({
      run_id: "r",
      schemaVersion: "aep/v0.5",
      attribution_backing: "qualified_signature",
      run_attribution_backing_observed: ["operator_asserted", "qualified_signature"],
    });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    const record = emitter.build();
    expect(record.run_attribution_backing_floor).toBe("operator_asserted");
    // The strong grant is still visible in the itemization.
    expect(record.run_attribution_backing_observed).toContain("qualified_signature");
  });
});

// ---------------------------------------------------------------------------
// Hostile key / payload attacks
// ---------------------------------------------------------------------------

describe("adversarial — hostile keys and payloads", () => {
  it("emitter normalises or rejects records, never crash-on-emit for long input", () => {
    const emitter = new AEPEmitter({
      run_id: "r-" + "x".repeat(100_000),
      schemaVersion: "aep/v0.5",
    });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    const record = emitter.build();
    expect(record.run_id.length).toBe(100_002);
  });
});

// ---------------------------------------------------------------------------
// Cross-language fixture — Rust-signed gateway record (interop regression)
// ---------------------------------------------------------------------------

describe("adversarial — cross-language fixtures", () => {
  const fixtureDir = join(import.meta.dir, "__fixtures__");

  it("rust-signed envelope verifies and binds the record", async () => {
    const record = JSON.parse(
      readFileSync(join(fixtureDir, "rust-gateway-dsse.json"), "utf-8")
    ) as AEPRecord;
    const pubHex = readFileSync(join(fixtureDir, "rust-gateway-verify-key.hex"), "utf-8").trim();
    const pub = Uint8Array.from(pubHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    expect(await verifyDSSEEnvelope(record.dsse_envelope!, pub)).toBe(true);
    expect(await verifyAEPRecord(record, pub)).toBe(true);

    // Any field mutation must break the payload binding.
    const tampered = { ...record, user_id: "user-attacker" } as AEPRecord;
    expect(await verifyAEPRecord(tampered, pub)).toBe(false);
  });
});
