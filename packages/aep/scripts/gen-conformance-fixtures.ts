// Regenerates the wasmagent-protocol conformance corpus (DSSE-only target)
// from the REAL emitter signing path. Legacy inline constructions are
// retired: this generator MUST NOT produce them.
//
// Usage (from wasmagent-js repo root):
//   bun packages/aep/scripts/gen-conformance-fixtures.ts <protocol-repo>/conformance/aep
// The output directory must resolve inside the current working directory.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AEPRecord } from "@wasmagent/aep";
import {
  AEPEmitter,
  canonicalBytes,
  createLocalSignerFromSeed,
  paeEncode,
  wrapInTotoStatement,
} from "@wasmagent/aep";

const outArg = process.argv[2];
if (!outArg) throw new Error("usage: gen-conformance-fixtures.ts <out-dir>");
const CWD = process.cwd();
const OUT = resolve(outArg);
// resolve() collapses any '..'; the real guard is the prefix check below,
// which only allows output inside this repo or an org sibling checkout.
const repoRoot = resolve(CWD, "../..");
const allowedBase = resolve(repoRoot, "..");
if (OUT !== repoRoot && !OUT.startsWith(repoRoot + "/") && !OUT.startsWith(allowedBase + "/")) {
  throw new Error("out-dir must resolve inside this repository or an org sibling checkout");
}

const SEED = "c0ffee00".repeat(8);
const SECOND_SEED = "badc0de0".repeat(8);
const KEY_ID = "conformance-seed-key-01";
const signer = createLocalSignerFromSeed(SEED, KEY_ID);
const secondSigner = createLocalSignerFromSeed(SECOND_SEED, "conformance-seed-key-02");
const jsPub = await signer.getPublicKey();

for (const dir of ["valid", "invalid-semantic", "invalid-schema", "dsse", "chain", "historical"]) {
  mkdirSync(join(OUT, dir), { recursive: true });
}

function emitter(runId: string) {
  const e = new AEPEmitter({ run_id: runId, signer, schemaVersion: "aep/v0.5" });
  e.addAction({
    tool_name: "read_materials",
    state_changing: false,
    recording_mode: "validation",
    side_effect_class: "read",
  });
  return e;
}

async function resign(
  record: AEPRecord,
  mutate: (statement: any, envelope: any) => void
): Promise<AEPRecord> {
  const envelope = record.dsse_envelope!;
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  mutate(statement, envelope);
  const payloadB64 = Buffer.from(JSON.stringify(statement)).toString("base64");
  const pae = paeEncode(envelope.payloadType, payloadB64);
  const sig = await signer.sign(pae);
  return {
    ...record,
    dsse_envelope: { ...envelope, payload: payloadB64, signatures: [{ keyid: KEY_ID, sig }] },
  };
}

const linkHash = (r: AEPRecord) => {
  const { signature: _s, dsse_envelope: _d, ...u } = r;
  return createHash("sha256").update(canonicalBytes(u)).digest("hex");
};

const write = (rel: string, data: unknown) =>
  writeFileSync(join(OUT, rel), `${JSON.stringify(data, null, 2)}\n`);

// ---- valid ----------------------------------------------------------------
write("valid/unsigned-v05.json", emitter("conf-unsigned").build(1_700_000_000_000));
write("valid/minimal-v05.json", {
  schema_version: "aep/v0.5",
  run_id: "conf-minimal-v05",
  created_at_ms: 1_700_000_000_000,
});
write(
  "valid/proto-key-preserved.json",
  JSON.parse(
    '{"schema_version":"aep/v0.5","run_id":"conf-proto-preserved","created_at_ms":1700000000000,"__proto__":{"polluted":true},"actions":[]}'
  )
);
write("dsse/js-signed-v05.json", await emitter("conf-js-dsse").emit(1_700_000_000_000));

// ---- invalid-semantic -------------------------------------------------------
write("invalid-semantic/floor-roundup.json", {
  schema_version: "aep/v0.5",
  run_id: "conf-floor-roundup",
  created_at_ms: 1_700_000_000_000,
  attribution_backing: "principal_key_signed",
  run_attribution_backing_floor: "principal_key_signed",
  run_attribution_backing_observed: ["operator_asserted", "principal_key_signed"],
  authorization_evidence_count: 2,
});
write("invalid-semantic/floor-not-observed.json", {
  schema_version: "aep/v0.5",
  run_id: "conf-floor-not-observed",
  created_at_ms: 1_700_000_000_000,
  run_attribution_backing_floor: "unknown",
  run_attribution_backing_observed: ["operator_asserted", "principal_key_signed"],
});
write("invalid-semantic/unknown-attribution-grade.json", {
  schema_version: "aep/v0.5",
  run_id: "conf-unknown-grade",
  created_at_ms: 1_700_000_000_000,
  attribution_backing: "self_asserted",
});
write("invalid-semantic/duplicate-observed-grade.json", {
  schema_version: "aep/v0.5",
  run_id: "conf-dup-observed",
  created_at_ms: 1_700_000_000_000,
  run_attribution_backing_floor: "operator_asserted",
  run_attribution_backing_observed: ["operator_asserted", "operator_asserted"],
});
write("invalid-semantic/negative-authorization-evidence-count.json", {
  schema_version: "aep/v0.5",
  run_id: "conf-negative-count",
  created_at_ms: 1_700_000_000_000,
  authorization_evidence_count: -1,
});

// ---- DSSE profile negatives (authentic signatures, non-conformant) ---------
write(
  "dsse/wrong-payload-type-resigned.json",
  await (async () => {
    const record = await emitter("conf-wrong-payload-type").emit(1_700_000_000_000);
    const envelope = record.dsse_envelope!;
    const pae = paeEncode("application/JSON", envelope.payload);
    const sig = await signer.sign(pae);
    return {
      ...record,
      dsse_envelope: {
        ...envelope,
        payloadType: "application/JSON",
        signatures: [{ keyid: KEY_ID, sig }],
      },
    };
  })()
);
write(
  "dsse/wrong-predicate-type-resigned.json",
  await resign(await emitter("conf-wrong-predicate-type").emit(1_700_000_000_000), (s) => {
    s.predicateType = "https://wasmagent.dev/attestations/aep/v0.9";
  })
);
write(
  "dsse/wrong-statement-type-resigned.json",
  await resign(await emitter("conf-wrong-statement-type").emit(1_700_000_000_000), (s) => {
    s._type = "https://example.com/Statement/v2";
  })
);
write(
  "dsse/missing-subject-name-resigned.json",
  await resign(await emitter("conf-missing-subject-name").emit(1_700_000_000_000), (s) => {
    delete s.subject[0].name;
  })
);
write(
  "dsse/wrong-subject-name-resigned.json",
  await resign(await emitter("conf-wrong-subject-name").emit(1_700_000_000_000), (s) => {
    s.subject[0].name = "urn:wasmagent:run:run-other";
  })
);
write(
  "dsse/multiple-signatures.json",
  await (async () => {
    const record = await emitter("conf-multi-sig").emit(1_700_000_000_000);
    const envelope = record.dsse_envelope!;
    const pae = paeEncode(envelope.payloadType, envelope.payload);
    const secondSig = await secondSigner.sign(pae);
    return {
      ...record,
      dsse_envelope: {
        ...envelope,
        signatures: [...envelope.signatures, { keyid: "conformance-seed-key-02", sig: secondSig }],
      },
    };
  })()
);
write(
  "dsse/tampered-run-id.json",
  await (async () => {
    // Emit a real DSSE record FIRST, then mutate the inline run_id — the
    // tampered record keeps its (now stale) envelope, so the fixture
    // exercises binding failure, not an unsigned record.
    const record = await emitter("conf-tampered").emit(1_700_000_000_000);
    return { ...record, run_id: "run-impersonated" };
  })()
);

// ---- chain ------------------------------------------------------------------
const jsonl = (rel: string, records: AEPRecord[]) =>
  writeFileSync(join(OUT, rel), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

// DSSE-signed composed chain: the emitter links sequentially.
const chainEmitter = new AEPEmitter({
  run_id: "conf-chain-dsse",
  signer,
  schemaVersion: "aep/v0.5",
});
const dsseChain: AEPRecord[] = [];
for (const tool of ["step_1", "step_2", "step_3"]) {
  chainEmitter.addAction({ tool_name: tool, state_changing: tool === "step_2" });
  dsseChain.push(await chainEmitter.emit(1_700_000_000_000));
}
jsonl("chain/intact-dsse-3.jsonl", dsseChain);

// Chain-only fixtures: unsigned records, links computed the way verifiers do.
function unsignedLinked(): AEPRecord[] {
  const records: AEPRecord[] = [];
  for (let i = 0; i < 3; i++) {
    const e = new AEPEmitter({ run_id: "conf-chain", signer, schemaVersion: "aep/v0.5" });
    e.addAction({ tool_name: `step_${i + 1}`, state_changing: i === 1 });
    const r = e.build(1_700_000_000_000 + i * 1000);
    if (i > 0) (r as any).prev_record_hash = linkHash(records[i - 1]);
    records.push(r);
  }
  return records;
}
const intact = unsignedLinked();
jsonl("chain/intact-3.jsonl", intact);
jsonl(
  "chain/missing-all.jsonl",
  intact.map(({ prev_record_hash: _p, ...r }) => r as AEPRecord)
);
const partialLast = intact.map((r) => ({ ...r }));
delete (partialLast[2] as any).prev_record_hash;
jsonl("chain/partial-last.jsonl", partialLast as AEPRecord[]);
const partialMiddle = intact.map((r) => ({ ...r }));
delete (partialMiddle[1] as any).prev_record_hash;
(partialMiddle[2] as any).prev_record_hash = linkHash(partialMiddle[1]);
jsonl("chain/partial-middle.jsonl", partialMiddle as AEPRecord[]);
jsonl("chain/broken-middle.jsonl", [intact[0], intact[2]]);
jsonl("chain/singleton-with-prev.jsonl", [
  (() => {
    const e = new AEPEmitter({ run_id: "conf-chain-singleton", signer, schemaVersion: "aep/v0.5" });
    e.addAction({ tool_name: "noop", state_changing: false });
    const r = e.build(1_700_000_000_000);
    (r as any).prev_record_hash = "f".repeat(64);
    return r as AEPRecord;
  })(),
]);

console.log(`corpus written to ${OUT}`);
writeFileSync(join(OUT, "dsse", "js-verify-key.hex"), Buffer.from(jsPub).toString("hex"));
console.log(`js verifying key (hex): ${Buffer.from(jsPub).toString("hex")}`);
