#!/usr/bin/env node
/**
 * Validate train_seed.jsonl against the schema in
 * ../../docs/strategy/multi-turn-sft-spec.md §6.
 *
 * Read-only. Prints per-category counts + any schema violations.
 * Run before scaling data generation, and before shipping any larger
 * version to the SFT track.
 *
 * Exit 0 on clean pass, 1 on any violation.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] ?? join(__dirname, "train_seed.jsonl");

const REQUIRED_TOP = ["id", "split", "category", "messages", "loss_weight_tokens", "provenance"];
const ALLOWED_SPLIT = new Set(["train", "val", "eval"]);
const ALLOWED_LOSS = new Set(["default", "recovery", "state_summary"]);
const ALLOWED_ROLES = new Set(["system", "user", "assistant", "tool"]);

const lines = readFileSync(FILE, "utf8")
  .split("\n")
  .filter((l) => l.length > 0);
const errors = [];
const byCategory = {};
const byLossWeight = {};
const v1IdsSeen = new Set();
const synthIdsSeen = new Set();
const idsSeen = new Set();

for (let i = 0; i < lines.length; i++) {
  const lineNo = i + 1;
  let r;
  try {
    r = JSON.parse(lines[i]);
  } catch (e) {
    errors.push(`L${lineNo}: invalid JSON — ${e.message}`);
    continue;
  }
  for (const k of REQUIRED_TOP) {
    if (!(k in r)) errors.push(`L${lineNo} (${r.id ?? "?"}): missing top-level field "${k}"`);
  }
  if (!ALLOWED_SPLIT.has(r.split)) errors.push(`L${lineNo} (${r.id}): bad split "${r.split}"`);
  if (!ALLOWED_LOSS.has(r.loss_weight_tokens))
    errors.push(`L${lineNo} (${r.id}): bad loss_weight_tokens "${r.loss_weight_tokens}"`);
  if (idsSeen.has(r.id)) errors.push(`L${lineNo}: duplicate id "${r.id}"`);
  idsSeen.add(r.id);

  if (!Array.isArray(r.messages) || r.messages.length < 3)
    errors.push(
      `L${lineNo} (${r.id}): messages must be array with ≥3 entries (system+user+assistant)`
    );
  else {
    if (r.messages[0].role !== "system")
      errors.push(`L${lineNo} (${r.id}): first message must be system`);
    if (r.messages[1].role !== "user")
      errors.push(`L${lineNo} (${r.id}): second message must be user`);
    for (const [j, m] of r.messages.entries()) {
      if (!ALLOWED_ROLES.has(m.role))
        errors.push(`L${lineNo} (${r.id}) msg[${j}]: unknown role "${m.role}"`);
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (!tc.id || !tc.function?.name || typeof tc.function.arguments !== "string") {
            errors.push(`L${lineNo} (${r.id}) msg[${j}]: malformed tool_call`);
          } else {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              errors.push(`L${lineNo} (${r.id}) msg[${j}]: tool_call.arguments not JSON`);
            }
          }
        }
      }
      if (m.role === "tool" && !m.tool_call_id)
        errors.push(`L${lineNo} (${r.id}) msg[${j}]: tool message missing tool_call_id`);
    }
    // Final message should be a final_answer assistant turn (or at least an assistant turn — recovery records may end mid-stream).
    const last = r.messages[r.messages.length - 1];
    if (last.role !== "assistant")
      errors.push(`L${lineNo} (${r.id}): last message must be assistant (got ${last.role})`);
  }

  if (!r.provenance?.v1_item_id) errors.push(`L${lineNo} (${r.id}): missing provenance.v1_item_id`);
  else {
    if (r.provenance.v1_item_id.startsWith("synth-")) synthIdsSeen.add(r.provenance.v1_item_id);
    else v1IdsSeen.add(r.provenance.v1_item_id);
  }
  if (!r.provenance?.n_gram_hash)
    errors.push(`L${lineNo} (${r.id}): missing provenance.n_gram_hash`);

  byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  byLossWeight[r.loss_weight_tokens] = (byLossWeight[r.loss_weight_tokens] ?? 0) + 1;
}

console.log(`Records: ${lines.length}`);
console.log(`By category: ${JSON.stringify(byCategory)}`);
console.log(`By loss_weight_tokens: ${JSON.stringify(byLossWeight)}`);
console.log(`Distinct V1-canonical ids: ${v1IdsSeen.size}`);
console.log(`Distinct synth-* ids: ${synthIdsSeen.size}`);
if (errors.length === 0) {
  console.log("\n✓ Schema clean.");
  process.exit(0);
} else {
  console.log(`\n✗ ${errors.length} violations:`);
  for (const e of errors.slice(0, 50)) console.log(`  ${e}`);
  if (errors.length > 50) console.log(`  ...and ${errors.length - 50} more`);
  process.exit(1);
}
