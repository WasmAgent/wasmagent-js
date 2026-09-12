// One-off generator for the wasmagent-protocol conformance corpus (JS side).
// Paths are fully literal by design: this is a maintainer tool pinned to the
// sibling checkout on this machine, not a generic utility.
//
// Run: bun packages/aep/scripts/gen-conformance-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AEPEmitter, createLocalSignerFromSeed } from "@wasmagent/aep";

const OUT = "/Users/I041705/github/wasmagent-protocol/conformance/aep";

const SEED = "c0ffee00".repeat(8); // 64 hex chars — documented corpus seed
const KEY_ID = "conformance-seed-key-01";
const signer = createLocalSignerFromSeed(SEED, KEY_ID);

for (const dir of ["valid", "invalid-semantic", "invalid-schema", "dsse", "legacy", "chain"]) {
  mkdirSync(join(OUT, dir), { recursive: true });
}

function emitter(runId: string, useDsse = false) {
  const e = new AEPEmitter({ run_id: runId, signer, useDsse });
  e.addAction({
    tool_name: "read_materials",
    state_changing: false,
    recording_mode: "validation",
    side_effect_class: "read",
  });
  return e;
}

writeFileSync(
  join(OUT, "valid", "unsigned-v05.json"),
  JSON.stringify(emitter("conf-unsigned").build(1_700_000_000_000), null, 2)
);

writeFileSync(
  join(OUT, "legacy", "js-canonical-ed25519.json"),
  JSON.stringify(await emitter("conf-js-legacy").emit(1_700_000_000_000), null, 2)
);

writeFileSync(
  join(OUT, "dsse", "js-signed-v05.json"),
  JSON.stringify(await emitter("conf-js-dsse", true).emit(1_700_000_000_000), null, 2)
);

const lines: string[] = [];
const chained = new AEPEmitter({ run_id: "conf-chain", signer });
chained.addAction({ tool_name: "step_1", state_changing: false });
lines.push(JSON.stringify(await chained.emit(1_700_000_000_000)));
chained.addAction({ tool_name: "step_2", state_changing: true });
lines.push(JSON.stringify(await chained.emit(1_700_000_001_000)));
chained.addAction({ tool_name: "step_3", state_changing: false });
lines.push(JSON.stringify(await chained.emit(1_700_000_002_000)));
writeFileSync(join(OUT, "chain", "intact-3.jsonl"), lines.join("\n") + "\n");
