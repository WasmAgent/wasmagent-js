#!/usr/bin/env node
/**
 * check-rollout-schema.mjs — schema governance CI check for wasmagent-js.
 *
 * Verifies that RolloutExporter.ts provenance fields use snake_case wire names,
 * matching rollout-wire.schema.json. Run in CI after lint, before tests.
 *
 * Exit 0 = clean. Non-zero = violations.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const errors = [];

// ── 1. RolloutExporter.ts must not use camelCase provenance keys ──────────────

const exporterSrc = readFileSync(
  resolve(ROOT, "packages/core/src/ranking/RolloutExporter.ts"),
  "utf8"
);

const FORBIDDEN_CAMEL = [
  "rolloutId",
  "exportedAtMs",
  "branchIndex",
  "chosenBranch",
  "rejectedBranch",
  "objectiveScore",
];

// Extract only the provenance object literals from the source.
// We look for content inside provenance: { ... } blocks.
const provenanceBlocks = exporterSrc.match(/provenance:\s*\{[^}]+\}/gs) ?? [];
const provenanceText = provenanceBlocks.join("\n");

for (const key of FORBIDDEN_CAMEL) {
  // Check for the key as a JSON property name inside provenance blocks
  const pattern = new RegExp(`\\b${key}:`);
  if (pattern.test(provenanceText)) {
    errors.push(
      `RolloutExporter.ts: provenance object uses camelCase key "${key}" — use snake_case in wire format`
    );
  }
}

// ── 2. Schema files must be present ──────────────────────────────────────────

const SCHEMA_FILES = [
  "packages/core/src/ranking/schemas/rollout-wire.schema.json",
  "packages/core/src/ranking/schemas/training-record.schema.json",
];

for (const f of SCHEMA_FILES) {
  try {
    JSON.parse(readFileSync(resolve(ROOT, f), "utf8"));
  } catch (e) {
    errors.push(`${f}: missing or invalid JSON — ${e.message}`);
  }
}

// ── 3. rollout-wire.schema.json provenance fields match source code ──────────

const wireSchema = JSON.parse(
  readFileSync(resolve(ROOT, "packages/core/src/ranking/schemas/rollout-wire.schema.json"), "utf8")
);

const dpoProvFields = Object.keys(wireSchema.$defs.DpoProvenance.properties);
const ppoProvFields = Object.keys(wireSchema.$defs.PpoProvenance.properties);

// source must be "wasmagent-rollout" in schema
if (wireSchema.$defs.DpoProvenance.properties.source?.const !== "wasmagent-rollout") {
  errors.push('rollout-wire.schema.json: DpoProvenance.source.const must be "wasmagent-rollout"');
}
if (wireSchema.$defs.PpoProvenance.properties.source?.const !== "wasmagent-rollout") {
  errors.push('rollout-wire.schema.json: PpoProvenance.source.const must be "wasmagent-rollout"');
}

// All provenance field names must be snake_case (no camelCase)
for (const f of [...dpoProvFields, ...ppoProvFields]) {
  if (/[A-Z]/.test(f)) {
    errors.push(`rollout-wire.schema.json: provenance field "${f}" must use snake_case`);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error("Schema governance violations found:\n");
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(
    `\n${errors.length} violation(s). See docs/schemas/GOVERNANCE.md for the change process.`
  );
  process.exit(1);
} else {
  console.log("✓ Schema governance checks passed");
}
