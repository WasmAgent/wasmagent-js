#!/usr/bin/env node

/**
 * e2e-data-loop.mjs — End-to-end data-loop smoke test.
 *
 * Verifies the full run → rank → export DPO/PPO pipeline is reproducible:
 *   1. Read rollout-branches.v1.jsonl (RolloutForkRunner output format)
 *   2. Rank with RolloutRanker (JS, from packages/core dist)
 *   3. Call evomerge TrainingDataExporter via Python subprocess to produce
 *      DPO/PPO JSONL + manifest.json
 *   4. Validate DPO/PPO files against rollout-wire.schema.json provenance rules
 *   5. Print record counts and "✓ Data loop end-to-end passed", exit 0
 *
 * Usage:
 *   node scripts/e2e-data-loop.mjs [--evomerge-root <path>] [--output-dir <path>]
 *
 * Flags:
 *   --evomerge-root <path>   Override evomerge repo root (default: ~/github/evomerge)
 *   --output-dir <path>      Output directory for generated files
 *                            (default: <os.tmpdir()>/wasmagent-data-loop-<timestamp>)
 */

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── CLI argument parsing ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
let evomergeRoot = null;
let outputDir = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--evomerge-root" && args[i + 1]) {
    evomergeRoot = args[++i];
  } else if (args[i] === "--output-dir" && args[i + 1]) {
    outputDir = args[++i];
  }
}

// Resolve evomerge root: CLI flag > env var > default ~/github/evomerge
if (!evomergeRoot) {
  evomergeRoot = process.env.EVOMERGE_ROOT ?? resolve(os.homedir(), "github", "evomerge");
}

// Resolve output directory
if (!outputDir) {
  outputDir = resolve(os.tmpdir(), `wasmagent-data-loop-${Date.now()}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function step(n, label) {
  console.log(`\nStep ${n}: ${label}`);
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function readJsonl(filePath) {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function writeJsonl(records, filePath) {
  writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/**
 * Convert a snake_case wire record (from JSONL fixture) to the camelCase
 * RolloutBranchResult shape expected by the JS RolloutExporter functions.
 */
function wireToBranchResult(rec) {
  return {
    rolloutId: rec.rollout_id,
    task: rec.task,
    branchIndex: rec.branch_index,
    temperature: rec.temperature,
    seed: rec.seed ?? null,
    sessionId: rec.session_id,
    trajectory: rec.trajectory ?? [],
    toolCallSequence: rec.tool_call_sequence ?? [],
    finalAnswer: rec.final_answer ?? "",
    buildResult: rec.build_result ?? null,
  };
}

/**
 * Convert a snake_case wire record to the RolloutRecord shape expected by
 * RolloutRanker.rank() (objectiveScore is camelCase in the TS type).
 */
function wireToRolloutRecord(rec) {
  return {
    rolloutId: rec.rollout_id,
    branchIndex: rec.branch_index,
    finalAnswer: rec.final_answer ?? "",
    objectiveScore: rec.objective_score,
    task: rec.task,
  };
}

// ── Step 1: Read rollout-branches fixture ─────────────────────────────────────

step(1, "Read rollout-branches.v1.jsonl");

const fixtureFile = resolve(ROOT, "fixtures/data-loop/rollout-branches.v1.jsonl");
let wireRecords;
try {
  wireRecords = readJsonl(fixtureFile);
} catch (e) {
  fail(`Cannot read fixture: ${fixtureFile}\n  ${e.message}`);
}
console.log(`  → ${wireRecords.length} branch record(s) loaded`);

// ── Step 2: Rank with RolloutRanker ──────────────────────────────────────────

step(2, "Rank with RolloutRanker (JS)");

const { RolloutRanker } = await import(
  resolve(ROOT, "packages/core/dist/ranking/RolloutRanker.js")
);
const { toDpoRecord, toPpoRecords } = await import(
  resolve(ROOT, "packages/core/dist/ranking/RolloutExporter.js")
);

const ranker = new RolloutRanker();
const rolloutRecords = wireRecords.map(wireToRolloutRecord);
let rankingResult;
try {
  rankingResult = await ranker.rank(rolloutRecords);
} catch (e) {
  fail(`RolloutRanker.rank() failed: ${e.message}`);
}

const { ranked, stats } = rankingResult;
console.log(`  → ${ranked.length} branch(es) ranked`);
console.log(`  → powered=${stats.powered}, mcnemarP=${stats.mcnemarP}`);

// Write ranked-rollouts.jsonl: merge ranking results back into wire records
mkdirSync(outputDir, { recursive: true });

const rankedMap = new Map(ranked.map((r) => [r.branchIndex, r]));
const rankedWire = wireRecords.map((rec) => {
  const r = rankedMap.get(rec.branch_index);
  return {
    ...rec,
    rank: r?.rank ?? 0,
    total_score: r?.totalScore ?? 0,
    objective_score: r?.objectiveScore ?? rec.objective_score,
  };
});

const rankedRolloutsFile = resolve(outputDir, "ranked-rollouts.jsonl");
writeJsonl(rankedWire, rankedRolloutsFile);
console.log(`  → wrote ${rankedWire.length} record(s) to ${rankedRolloutsFile}`);

// ── Step 3: Export DPO/PPO via evomerge Python ───────────────────────────────

step(3, "Export DPO/PPO via evomerge Python TrainingDataExporter");

const pythonBin = resolve(evomergeRoot, ".venv/bin/python");
const dpoFile = resolve(outputDir, "dpo-training.jsonl");
const ppoFile = resolve(outputDir, "ppo-training.jsonl");
const manifestFile = resolve(outputDir, "manifest.json");

// Write the Python script to a temp file to avoid shell quoting issues with
// multi-line -c arguments. The script:
//   - adds evomerge/src to sys.path
//   - imports TrainingDataExporter
//   - loads from the ranked-rollouts file we just wrote
//   - exports to dpo/ppo files and writes manifest.json
const pyScript = [
  "import sys, json",
  `sys.path.insert(0, ${JSON.stringify(resolve(evomergeRoot, "src"))})`,
  "from datafactory.exporter import TrainingDataExporter",
  "",
  "exporter = TrainingDataExporter(eval_items_path=None)",
  `records = exporter.load_rollouts(${JSON.stringify(rankedRolloutsFile)})`,
  `print(f"[py] loaded {len(records)} rollout record(s)", file=sys.stderr)`,
  "",
  "dpo, ppo = exporter.export(",
  "    records,",
  `    dpo_path=${JSON.stringify(dpoFile)},`,
  `    ppo_path=${JSON.stringify(ppoFile)},`,
  '    mode="fixture",',
  `    manifest_path=${JSON.stringify(manifestFile)},`,
  ")",
  `print(f"[py] exported dpo={len(dpo)} ppo={len(ppo)}", file=sys.stderr)`,
  `print(json.dumps({"dpo": len(dpo), "ppo": len(ppo)}))`,
].join("\n");

const pyScriptFile = resolve(outputDir, "_export_runner.py");
writeFileSync(pyScriptFile, pyScript, "utf8");

let pyResult;
try {
  const output = execSync(`${pythonBin} ${pyScriptFile}`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  pyResult = JSON.parse(output.trim());
} catch (e) {
  fail(`Python export step failed:\n  ${e.message}`);
} finally {
  // Clean up temp script file
  try {
    rmSync(pyScriptFile);
  } catch (_) {
    /* ignore */
  }
}

console.log(`  → DPO records exported: ${pyResult.dpo}`);
console.log(`  → PPO records exported: ${pyResult.ppo}`);
console.log(`  → wrote ${dpoFile}`);
console.log(`  → wrote ${ppoFile}`);
console.log(`  → wrote ${manifestFile}`);

// ── Step 4: Validate DPO/PPO files against schema rules ──────────────────────

step(4, "Validate DPO/PPO files against schema rules");

// Load rollout-wire.schema.json (used for intermediate ranked-rollouts validation)
const wireSchemaFile = createRequire(import.meta.url).resolve(
  "@wasmagent/protocol/schemas/compliance/rollout-wire.schema.json"
);
// Load training-record.schema.json (used for final DPO/PPO output from Python exporter)
const trainingSchemaFile = resolve(
  ROOT,
  "packages/core/src/ranking/schemas/training-record.schema.json"
);
let wireSchema, trainingSchema;
try {
  wireSchema = JSON.parse(readFileSync(wireSchemaFile, "utf8"));
  trainingSchema = JSON.parse(readFileSync(trainingSchemaFile, "utf8"));
} catch (e) {
  fail(`Cannot read schema files: ${e.message}`);
}

const validationErrors = [];

// -- 4a: Validate ranked-rollouts.jsonl against RolloutBranchRecord schema ----
const branchRequired = wireSchema.$defs.RolloutBranchRecord.required ?? [];
const rankedWireRecords = readJsonl(rankedRolloutsFile);
for (let i = 0; i < rankedWireRecords.length; i++) {
  const rec = rankedWireRecords[i];
  for (const f of branchRequired) {
    if (!(f in rec)) {
      validationErrors.push(`ranked-rollouts record ${i}: missing required field "${f}"`);
    }
  }
}
console.log(`  → ranked-rollouts.jsonl: ${rankedWireRecords.length} record(s) checked`);

// -- 4b: Validate DPO training output against DpoTrainingRecord schema --------
const dpoRequired = trainingSchema.$defs.DpoTrainingRecord.required ?? [];
const ppoRequired = trainingSchema.$defs.PpoTrainingRecord.required ?? [];
const provRequired = trainingSchema.$defs.Provenance.required ?? [];
const lossWeightValues = trainingSchema.$defs.LossWeightTokens.enum ?? [];

let dpoRecords = [];
try {
  dpoRecords = readJsonl(dpoFile);
} catch (e) {
  fail(`Cannot read DPO output file: ${dpoFile}\n  ${e.message}`);
}

for (let i = 0; i < dpoRecords.length; i++) {
  const rec = dpoRecords[i];
  // Required top-level fields
  for (const f of dpoRequired) {
    if (!(f in rec)) {
      validationErrors.push(`DPO record ${i}: missing required field "${f}"`);
    }
  }
  // messages must be non-empty array
  if (!Array.isArray(rec.messages) || rec.messages.length === 0) {
    validationErrors.push(`DPO record ${i}: "messages" must be a non-empty array`);
  }
  // chosen/rejected must be non-empty strings
  if (typeof rec.chosen !== "string" || !rec.chosen) {
    validationErrors.push(`DPO record ${i}: "chosen" must be a non-empty string`);
  }
  if (typeof rec.rejected !== "string" || !rec.rejected) {
    validationErrors.push(`DPO record ${i}: "rejected" must be a non-empty string`);
  }
  // loss_weight_tokens
  if (!lossWeightValues.includes(rec.loss_weight_tokens)) {
    validationErrors.push(
      `DPO record ${i}: "loss_weight_tokens" must be one of ${JSON.stringify(lossWeightValues)}, got ${JSON.stringify(rec.loss_weight_tokens)}`
    );
  }
  // provenance
  const prov = rec.provenance ?? {};
  for (const f of provRequired) {
    if (!(f in prov)) {
      validationErrors.push(`DPO record ${i}: provenance missing required field "${f}"`);
    }
  }
  // snake_case check on provenance keys
  for (const key of Object.keys(prov)) {
    if (/[A-Z]/.test(key)) {
      validationErrors.push(`DPO record ${i}: provenance field "${key}" must use snake_case`);
    }
  }
  // source must be "wasmagent-rollout"
  if (prov.source !== "wasmagent-rollout") {
    validationErrors.push(
      `DPO record ${i}: provenance.source must be "wasmagent-rollout", got ${JSON.stringify(prov.source)}`
    );
  }
}

// -- 4c: Validate PPO training output against PpoTrainingRecord schema --------
let ppoRecords = [];
try {
  ppoRecords = readJsonl(ppoFile);
} catch (e) {
  fail(`Cannot read PPO output file: ${ppoFile}\n  ${e.message}`);
}

for (let i = 0; i < ppoRecords.length; i++) {
  const rec = ppoRecords[i];
  // Required top-level fields
  for (const f of ppoRequired) {
    if (!(f in rec)) {
      validationErrors.push(`PPO record ${i}: missing required field "${f}"`);
    }
  }
  // messages must be non-empty array
  if (!Array.isArray(rec.messages) || rec.messages.length === 0) {
    validationErrors.push(`PPO record ${i}: "messages" must be a non-empty array`);
  }
  // reward must be number in [0, 1]
  if (typeof rec.reward !== "number" || rec.reward < 0 || rec.reward > 1) {
    validationErrors.push(
      `PPO record ${i}: "reward" must be a number in [0, 1], got ${JSON.stringify(rec.reward)}`
    );
  }
  // loss_weight_tokens
  if (!lossWeightValues.includes(rec.loss_weight_tokens)) {
    validationErrors.push(
      `PPO record ${i}: "loss_weight_tokens" must be one of ${JSON.stringify(lossWeightValues)}, got ${JSON.stringify(rec.loss_weight_tokens)}`
    );
  }
  // provenance
  const prov = rec.provenance ?? {};
  for (const f of provRequired) {
    if (!(f in prov)) {
      validationErrors.push(`PPO record ${i}: provenance missing required field "${f}"`);
    }
  }
  // snake_case check
  for (const key of Object.keys(prov)) {
    if (/[A-Z]/.test(key)) {
      validationErrors.push(`PPO record ${i}: provenance field "${key}" must use snake_case`);
    }
  }
  // source check
  if (prov.source !== "wasmagent-rollout") {
    validationErrors.push(
      `PPO record ${i}: provenance.source must be "wasmagent-rollout", got ${JSON.stringify(prov.source)}`
    );
  }
}

// -- 4d: Validate manifest.json -----------------------------------------------
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
} catch (e) {
  fail(`Cannot read manifest: ${manifestFile}\n  ${e.message}`);
}
if (manifest.schema_version !== "export-manifest/v1") {
  validationErrors.push(
    `manifest.json: schema_version must be "export-manifest/v1", got ${JSON.stringify(manifest.schema_version)}`
  );
}

if (validationErrors.length > 0) {
  console.error("\nValidation errors:");
  for (const e of validationErrors) {
    console.error(`  ✗ ${e}`);
  }
  fail(`${validationErrors.length} validation error(s). Pipeline failed.`);
}

console.log(`  → DPO: ${dpoRecords.length} record(s) — training-record schema valid`);
console.log(`  → PPO: ${ppoRecords.length} record(s) — training-record schema valid`);
console.log(`  → manifest.json: schema_version=${manifest.schema_version}`);

// ── Step 5: Summary ───────────────────────────────────────────────────────────

step(5, "Summary");
console.log(`  Input rollout branches : ${wireRecords.length}`);
console.log(`  Ranked branches        : ${ranked.length}`);
console.log(`  DPO pairs exported     : ${dpoRecords.length}`);
console.log(`  PPO records exported   : ${ppoRecords.length}`);
console.log(`  Output directory       : ${outputDir}`);
console.log(`  manifest.mode          : ${manifest.mode}`);
console.log(`  manifest.g3_passed     : ${manifest.g3_passed}`);

console.log("\n✓ Data loop end-to-end passed");
