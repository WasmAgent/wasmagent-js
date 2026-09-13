#!/usr/bin/env node
/**
 * verify-corpus.mjs — consumer-side AEP corpus gate.
 *
 * Executes the authenticity and chain verdicts declared in the shared
 * conformance corpus manifest (WasmAgent/wasmagent-protocol
 * conformance/aep/manifest.json) with THIS repository's verifier, so the
 * corpus is a live consumer-side gate rather than protocol-side data.
 *
 * Usage: node scripts/verify-corpus.mjs <corpus-dir>
 * The corpus dir is the conformance/aep checkout of wasmagent-protocol.
 * Traversal segments are rejected.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const corpusArg = process.argv[2];
if (!corpusArg) {
  console.error("usage: verify-corpus.mjs <corpus-dir>");
  process.exit(1);
}
// resolve() collapses any traversal; the real guard is containment inside
// this repo or an org sibling checkout.
const CORPUS = resolve(corpusArg);
const allowedBase = resolve(process.cwd(), "../../..");
if (!CORPUS.startsWith(allowedBase + "/") && CORPUS !== allowedBase) {
  console.error(`corpus-dir must resolve inside ${allowedBase}`);
  process.exit(1);
}
if (!existsSync(join(CORPUS, "manifest.json"))) {
  console.error(`[verify-corpus] corpus not found at ${CORPUS}`);
  process.exit(1);
}

const { verifyAEPChain, verifyAEPRecordDetailed } = await import("../packages/aep/src/index.ts");

const manifest = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8"));

// Signing-profile gate: refuse a corpus whose manifest profile is not the one
// this verifier implements — a stale manifest must fail loudly.
const SUPPORTED_PROFILE = "aep-dsse-ed25519-decoded-body-v1";
if (manifest.signing_profile_id !== SUPPORTED_PROFILE) {
  console.error(
    `[verify-corpus] unsupported or stale signing_profile_id ${JSON.stringify(
      manifest.signing_profile_id
    )} — expected ${JSON.stringify(SUPPORTED_PROFILE)}`
  );
  process.exit(2);
}

// Per-entry path containment: manifest-declared paths are joined into the
// corpus root, so defend the tool against traversal (.. / absolute) entries.
function insideCorpus(rel) {
  const p = resolve(CORPUS, String(rel));
  if (p !== CORPUS && !p.startsWith(CORPUS + "/")) {
    console.error(`FAIL manifest path escapes corpus: ${rel}`);
    process.exit(2);
  }
  return p;
}

const keyHexDefault = readFileSync(join(CORPUS, "dsse", "js-verify-key.hex"), "utf8").trim();

let failures = 0;
let executed = 0;

const authentic = manifest.conformance_target.filter(
  (e) => e.authenticity === "dsse-valid" || e.authenticity === "invalid"
);
for (const entry of authentic) {
  const fixture = insideCorpus(entry.path);
  const raw = readFileSync(fixture, "utf8");
  const records = entry.path.endsWith(".jsonl")
    ? raw
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [JSON.parse(raw)];
  // Per-entry verifying key: the pinned Rust fixture was emitted with the
  // legacy test seed, not the corpus seed.
  const keyHex = entry.verify_key
    ? readFileSync(insideCorpus(entry.verify_key), "utf8").trim()
    : keyHexDefault;
  const publicKey = new Uint8Array(keyHex.match(/../g).map((b) => parseInt(b, 16)));
  executed++;
  let entryFailures = 0;
  for (const record of records) {
    const detailed = await verifyAEPRecordDetailed(record, publicKey);
    const valid = detailed.authenticity === "dsse-valid";
    if (valid !== (entry.authenticity === "dsse-valid")) {
      failures++;
      entryFailures++;
      console.error(
        `FAIL ${entry.path}: verifier said authenticity=${detailed.authenticity}, manifest expects ${entry.authenticity}`
      );
      break;
    }
  }
  if (entryFailures === 0) {
    console.log(`OK   ${entry.path} (${entry.authenticity})`);
  }
}

const chained = manifest.conformance_target.filter(
  (e) => e.chain && e.chain !== "not-checked" && String(e.path).endsWith(".jsonl")
);
for (const entry of chained) {
  const records = readFileSync(insideCorpus(entry.path), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const result = verifyAEPChain(records);
  executed++;
  if (result.status !== entry.chain) {
    failures++;
    console.error(
      `FAIL ${entry.path}: chain status=${result.status}, manifest expects ${entry.chain}`
    );
  } else {
    console.log(`OK   ${entry.path} (chain=${result.status})`);
  }
}

console.log(`\nverify-corpus: ${executed} verdict(s) checked, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
