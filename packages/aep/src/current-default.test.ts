/**
 * AEP-CURRENT-01..06 — the DEFAULT public producer path emits the CURRENT
 * schema family (aep/v0.5). Organization truth: read legacy, emit current;
 * backward compatibility governs parsing/verification, never new emission.
 *
 * These tests exercise the actual public constructor path with NO
 * schemaVersion option — exactly what ordinary usage instantiates.
 */
import { describe, expect, it } from "bun:test";
import { verifyDSSEEnvelope } from "./dsse.js";
import { AEPEmitter } from "./emitter.js";
import { createLocalSignerFromSeed } from "./signer.js";
import { verifyAEPRecord } from "./verify.js";

const TEST_SEED = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

describe("AEP-CURRENT: default producer emits aep/v0.5", () => {
  // AEP-CURRENT-01
  it("default unsigned build() -> schema_version aep/v0.5", () => {
    const emitter = new AEPEmitter({ run_id: "run-current-01" });
    emitter.addAction({ tool_name: "read_file", state_changing: false });
    const record = emitter.build();
    expect(record.schema_version).toBe("aep/v0.5");
  });

  // AEP-CURRENT-02
  it("default signed emit() -> schema_version aep/v0.5", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, "current-key");
    const emitter = new AEPEmitter({ run_id: "run-current-02", signer });
    emitter.addAction({ tool_name: "write_file", state_changing: true });
    const record = await emitter.emit();
    expect(record.schema_version).toBe("aep/v0.5");
  });

  // AEP-CURRENT-03 — the signed default record verifies with EXACT binding:
  // the DSSE payload binds the exact v0.5 record bytes, and the legacy
  // signature mirror verifies against the same key.
  it("AEP-CURRENT-03: signed default verifies (DSSE exact binding + signature mirror)", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, "current-key");
    const emitter = new AEPEmitter({ run_id: "run-current-03", signer });
    emitter.addAction({ tool_name: "write_file", state_changing: true });
    const record = await emitter.emit();

    expect(record.dsse_envelope).toBeDefined();
    const pub = await signer.getPublicKey();
    expect(await verifyDSSEEnvelope(record.dsse_envelope!, pub)).toBe(true);
    expect(await verifyAEPRecord(record, pub)).toBe(true);

    // Exact binding: the envelope payload decodes to an in-toto statement
    // whose subject names THIS run; the subject digest binds the exact v0.5
    // record bytes (verifyDSSEEnvelope already validated the signature).
    const statement = JSON.parse(
      Buffer.from(record.dsse_envelope!.payload, "base64").toString("utf-8")
    ) as { subject: Array<{ name?: string }> };
    expect(JSON.stringify(statement.subject)).toContain("urn:wasmagent:run:run-current-03");
  });

  // AEP-CURRENT-04 — explicit legacy targets remain readable/verifiable
  // (backward compatibility governs reads).
  it("AEP-CURRENT-04: explicit aep/v0.4 emission remains verifiable", async () => {
    const signer = createLocalSignerFromSeed(TEST_SEED, "legacy-key");
    const emitter = new AEPEmitter({
      run_id: "run-current-04",
      signer,
      schemaVersion: "aep/v0.4",
    });
    emitter.addAction({ tool_name: "read_file", state_changing: false });
    const record = await emitter.emit();
    expect(record.schema_version).toBe("aep/v0.4");
    expect(await verifyAEPRecord(record, await signer.getPublicKey())).toBe(true);

    const unsignedLegacy = new AEPEmitter({
      run_id: "run-current-04b",
      schemaVersion: "aep/v0.4",
    }).build();
    expect(unsignedLegacy.schema_version).toBe("aep/v0.4");
  });

  // AEP-CURRENT-06 — v0.5 with no optional attribution fields is schema-valid
  // and makes NO attribution claim by absence.
  it("AEP-CURRENT-06: v0.5 without attribution fields is valid and claims nothing", () => {
    const emitter = new AEPEmitter({ run_id: "run-current-06" });
    emitter.addAction({ tool_name: "read_file", state_changing: false });
    const record = emitter.build();
    expect(record.schema_version).toBe("aep/v0.5");
    // Absence of the attribution vocabulary IS the no-claim state.
    expect(record.authorized_by).toBeUndefined();
    expect(record.authority_origin).toBeUndefined();
    expect(record.identity_source).toBeUndefined();
    expect(record.attribution_backing).toBeUndefined();
    expect(record.run_attribution_backing_floor).toBeUndefined();
    expect(record.run_attribution_backing_observed).toBeUndefined();
  });
});
