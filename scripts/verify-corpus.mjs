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
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const corpusArg = process.argv[2];
if (!corpusArg) {
  console.error("usage: verify-corpus.mjs <corpus-dir>");
  process.exit(1);
}
if (corpusArg.split(/[\\/]/).includes("..")) {
  console.error("corpus-dir must not contain traversal segments");
  process.exit(1);
}
const CORPUS = resolve(corpusArg);
if (!existsSync(join(CORPUS, "manifest.json"))) {
  console.error(`[verify-corpus] corpus not found at ${CORPUS}`);
  process.exit(1);
}

const { verifyAEPChain, verifyAEPRecordDetailed } = await import("@wasmagent/aep");

const manifest = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8"));
const keyHex = readFileSync(join(CORPUS, "dsse", "js-verify-key.hex"), "utf8").trim();
const publicKey = new Uint8Array(keyHex.match(/../g).map((b) => parseInt(b, 16)));

let failures = 0;
let executed = 0;

const authentic = manifest.conformance_target.filter(
  (e) => e.authenticity === "dsse-valid" || e.authenticity === "invalid"
);
for (const entry of authentic) {
  const record = JSON.parse(readFileSync(join(CORPUS, entry.path), "utf8"));
  const detailed = await verifyAEPRecordDetailed(record, publicKey);
  const valid = detailed.authenticity === "dsse-valid";
  executed++;
  if (valid !== (entry.authenticity === "dsse-valid")) {
    failures++;
    console.error(
      `FAIL ${entry.path}: verifier said authenticity=${detailed.authenticity}, manifest expects ${entry.authenticity}`
    );
  } else {
    console.log(`OK   ${entry.path} (${detailed.authenticity})`);
  }
}

const chained = manifest.conformance_target.filter(
  (e) => e.chain && e.chain !== "not-checked" && String(e.path).endsWith(".jsonl")
);
for (const entry of chained) {
  const records = readFileSync(join(CORPUS, entry.path), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const result = verifyAEPChain(records);
  executed++;
  if (result.status !== entry.chain) {
    failures++;
    console.error(`FAIL ${entry.path}: chain status=${result.status}, manifest expects ${entry.chain}`);
  } else {
    console.log(`OK   ${entry.path} (chain=${result.status})`);
  }
}

console.log(`\nverify-corpus: ${executed} verdict(s) checked, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
