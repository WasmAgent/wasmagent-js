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
  it("rejects legacy inline-signature records — DSSE is required", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, TEST_KEY_ID);
    const emitter = new AEPEmitter({ run_id: "r", signer, schemaVersion: "aep/v0.5" });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    const record = await emitter.emit();

    // Strip the envelope: the mirror `signature` field alone is NOT an
    // authenticity carrier. Historical inline-signed records are not a
    // verification target anymore.
    const { dsse_envelope: _removed, ...legacyShaped } = record;
    const pub = await signer.getPublicKey();
    expect(await verifyAEPRecord(legacyShaped as AEPRecord, pub)).toBe(false);

    // ...and even a forged "perfect-looking" legacy signature block does not
    // resurrect the record: without an envelope there is nothing to verify.
    const forged = {
      ...legacyShaped,
      signature: { alg: "ed25519" as const, key_id: TEST_KEY_ID, sig: "AA==" },
    } as AEPRecord;
    expect(await verifyAEPRecord(forged, pub)).toBe(false);
  });

  it("rejects corrupted envelope signature bytes for every corruption mode", async () => {
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
        dsse_envelope: {
          ...record.dsse_envelope!,
          signatures: [{ keyid: TEST_KEY_ID, sig: corruption }],
        },
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

  // Regression tests for the attribution guard paths — each guard added in
  // review rounds must fail closed forever; a refactor that re-opens any of
  // these bypasses must fail this suite.

  it("throws when a floor is supplied with no observed set at all", () => {
    const emitter = new AEPEmitter({
      run_id: "r",
      schemaVersion: "aep/v0.5",
      run_attribution_backing_floor: "operator_asserted",
      run_attribution_backing_observed: undefined,
    });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    expect(() => emitter.build()).toThrow();
  });

  it("throws when a floor is supplied with an empty observed set", () => {
    const emitter = new AEPEmitter({
      run_id: "r",
      schemaVersion: "aep/v0.5",
      run_attribution_backing_floor: "operator_asserted",
      run_attribution_backing_observed: [],
    });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    expect(() => emitter.build()).toThrow();
  });

  it("throws when observed is empty with no floor (empty grading claim)", () => {
    const emitter = new AEPEmitter({
      run_id: "r",
      schemaVersion: "aep/v0.5",
      run_attribution_backing_observed: [],
    });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    expect(() => emitter.build()).toThrow();
  });

  it("throws when an observed grade is outside the canonical vocabulary", () => {
    const emitter = new AEPEmitter({
      run_id: "r",
      schemaVersion: "aep/v0.5",
      run_attribution_backing_observed: ["operator_asserted", "biometric_bound"],
    });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    expect(() => emitter.build()).toThrow("canonical vocabulary");
  });

  it("throws when the floor grade is outside the canonical vocabulary", () => {
    const emitter = new AEPEmitter({
      run_id: "r",
      schemaVersion: "aep/v0.5",
      run_attribution_backing_observed: ["operator_asserted"],
      run_attribution_backing_floor: "wallet_attested" as never,
    });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    expect(() => emitter.build()).toThrow("canonical vocabulary");
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

// ---------------------------------------------------------------------------
// DSSE base64 alphabet interop (DSSE 1.0.2: verifiers MUST accept either)
// ---------------------------------------------------------------------------

describe("adversarial — DSSE base64 alphabet interop", () => {
  it("accepts standard, URL-safe, and mixed encodings of the same envelope", async () => {
    const signer = createLocalSignerFromSeed("cc".repeat(32), "key-b64");
    const emitter = new AEPEmitter({ run_id: "run-b64", signer, schemaVersion: "aep/v0.5" });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    const record = await emitter.emit();
    const pub = await signer.getPublicKey();
    const envelope = record.dsse_envelope!;

    // Sanity: the payload's standard encoding must actually contain '+' and
    // '/' so the URL-safe variants exercise the alternate alphabet. If the
    // natural statement bytes don't produce them, keep re-emitting with a
    // different run_id ('>'/'?' at aligned third-byte positions encode to
    // '+'/'/' deterministically).
    let std = envelope.payload;
    let attempt = 0;
    while (!(std.includes("+") && std.includes("/"))) {
      attempt += 1;
      if (attempt > 64) throw new Error("could not construct base64 interop vector");
      const e2 = new AEPEmitter({
        run_id: `run-b64-${attempt}-${">".repeat(9)}-${"?".repeat(9)}`,
        signer,
        schemaVersion: "aep/v0.5",
      });
      e2.addAction({ tool_name: "bash", state_changing: false });
      std = (await e2.emit()).dsse_envelope!.payload;
    }

    const toUrlsafe = (s: string) => s.replaceAll("+", "-").replaceAll("/", "_");
    expect(std.includes("+") && std.includes("/")).toBe(true);

    // Standard payload + standard signature (baseline).
    expect(await verifyDSSEEnvelope(envelope, pub)).toBe(true);

    // URL-safe payload (signature unchanged).
    const urlPayload = {
      ...envelope,
      payload: toUrlsafe(envelope.payload),
    };
    expect(await verifyDSSEEnvelope(urlPayload, pub)).toBe(true);

    // URL-safe payload + URL-safe signature.
    const urlBoth = {
      ...envelope,
      payload: toUrlsafe(envelope.payload),
      signatures: [
        { keyid: envelope.signatures[0]!.keyid, sig: toUrlsafe(envelope.signatures[0]!.sig) },
      ],
    };
    expect(await verifyDSSEEnvelope(urlBoth, pub)).toBe(true);

    // Mixed alphabets decode uniquely under the ('-'→'+', '_'→'/') bijection.
    const mixed = {
      ...envelope,
      payload: envelope.payload.replace("+", "-"),
      signatures: [
        {
          keyid: envelope.signatures[0]!.keyid,
          sig: toUrlsafe(envelope.signatures[0]!.sig).replace("-", "+"),
        },
      ],
    };
    expect(await verifyDSSEEnvelope(mixed, pub)).toBe(true);
  });

  it("rejects a mutated payloadType (it is inside the PAE)", async () => {
    const signer = createLocalSignerFromSeed("dd".repeat(32), "key-ptype");
    const emitter = new AEPEmitter({
      run_id: "run-ptype-tamper",
      signer,
      schemaVersion: "aep/v0.5",
    });
    emitter.addAction({ tool_name: "bash", state_changing: false });
    const record = await emitter.emit();
    const pub = await signer.getPublicKey();
    const tampered = {
      ...record.dsse_envelope!,
      payloadType: "application/json",
    };
    expect(await verifyDSSEEnvelope(tampered, pub)).toBe(false);
  });
});
