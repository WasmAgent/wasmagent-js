#!/usr/bin/env node
/**
 * generate-v2-arm-f.mjs — re-shape v1 SFT records into arm-f-compatible
 * two-pass format. Reads `train_seed.jsonl` (the v1 native-tool_calls
 * format) and writes `train_seed_v2_arm_f.jsonl` (the two-pass format
 * defined in `docs/strategy/multi-turn-sft-spec-v2-arm-f-shape.md`).
 *
 * Why a transformer rather than a fresh generator: v1's content (which
 * tools, which args, which scenarios) is correct — only the wire shape
 * needs changing. A transformer guarantees v2 is byte-for-byte
 * equivalent semantically and any future fixes to v1 propagate.
 *
 * Reshape rules per assistant message in v1:
 *
 *   IF assistant has tool_calls (length 1):
 *     v1: [user_task, ..., assistant{content="", tool_calls:[{name, args}]}, tool{result}]
 *     v2: [user_task, ..., user{"Pick the next tool..."}, assistant{`{"choice":"<name>"}`},
 *          user{"Provide arguments for <name>..."}, assistant{`<args JSON>`}, tool{result}]
 *
 *   IF assistant has tool_calls (length > 1, parallel):
 *     v1's parallel-call records get expanded sequentially in v2 — arm-f
 *     is one tool per step. We process tool_calls[0..N] in order; the
 *     v1 narrative content (when present) is dropped because arm-f
 *     never produces narrative.
 *
 *   IF assistant has final_answer flag:
 *     v1: assistant{content="DONE", final_answer:true}
 *     v2: user{"Pick the next tool..."}, assistant{`{"choice":"final_answer"}`}
 *
 * The transient `Pick the next tool` and `Provide arguments` user turns
 * are the literal strings arm-f's runArmF emits at inference (see
 * packages/evals-runner/src/suites/multi-turn-scaffold-arms.ts).
 *
 * Provenance is preserved verbatim so G3 isolation analysis still works.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "train_seed.jsonl");
const DST = join(__dirname, "train_seed_v2_arm_f.jsonl");

// arm-f's exact transient prompts, verbatim from
// packages/evals-runner/src/suites/multi-turn-scaffold-arms.ts:runArmF.
const PICK_PROMPT_FIRST =
  "Pick the next tool to call (or final_answer if the task is already complete).";
const PICK_PROMPT_LATER =
  "Pick the next tool to call (or final_answer if the task is now complete).";
const ARGS_PROMPT = (toolName) =>
  `Provide arguments for ${toolName} as a JSON object matching its input schema.`;

function reshapeRecord(v1) {
  const v2messages = [];
  let assistantTurnSeen = 0;

  for (const msg of v1.messages) {
    if (msg.role === "system" || msg.role === "user") {
      v2messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === "tool") {
      const t = { role: "tool", tool_call_id: msg.tool_call_id, content: msg.content };
      if (msg.is_error) t.is_error = true;
      v2messages.push(t);
      continue;
    }

    if (msg.role !== "assistant") continue;

    if (msg.final_answer === true) {
      const pickPrompt = assistantTurnSeen === 0 ? PICK_PROMPT_FIRST : PICK_PROMPT_LATER;
      v2messages.push({ role: "user", content: pickPrompt });
      v2messages.push({
        role: "assistant",
        content: JSON.stringify({ choice: "final_answer" }),
      });
      assistantTurnSeen++;
      continue;
    }

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        const toolName = tc.function?.name ?? "unknown";
        let argsObj = {};
        try {
          argsObj = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          argsObj = {};
        }
        const pickPrompt = assistantTurnSeen === 0 ? PICK_PROMPT_FIRST : PICK_PROMPT_LATER;
        v2messages.push({ role: "user", content: pickPrompt });
        v2messages.push({
          role: "assistant",
          content: JSON.stringify({ choice: toolName }),
        });
        v2messages.push({ role: "user", content: ARGS_PROMPT(toolName) });
        v2messages.push({ role: "assistant", content: JSON.stringify(argsObj) });
        assistantTurnSeen++;
      }
      continue;
    }

    v2messages.push({
      role: "assistant",
      content: msg.content ?? "",
      _v2_anomaly: "assistant message had neither tool_calls nor final_answer in v1",
    });
  }

  return {
    id: `${v1.id}-v2`,
    split: v1.split,
    category: v1.category,
    messages: v2messages,
    loss_weight_tokens: v1.loss_weight_tokens,
    provenance: {
      ...v1.provenance,
      source: `${v1.provenance?.source ?? "unknown"}+v2-arm-f`,
      v2_arm_f_reshape: "2026-06-15",
    },
  };
}

function validateV2(v2) {
  const issues = [];
  const msgs = v2.messages;

  if (msgs.length < 2) issues.push("too few messages");
  if (msgs[0]?.role !== "system") issues.push("first message must be system");
  if (msgs[1]?.role !== "user") issues.push("second message must be user (task)");

  for (const [i, m] of msgs.entries()) {
    if (m.role === "assistant") {
      try {
        const parsed = JSON.parse(m.content);
        if (typeof parsed !== "object" || parsed === null) {
          issues.push(`msg[${i}] assistant content is not a JSON object`);
        }
      } catch {
        issues.push(`msg[${i}] assistant content is not valid JSON: ${m.content?.slice(0, 50)}`);
      }
    }
  }

  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i]?.role !== "assistant") continue;
    const prev = msgs[i - 1];
    if (prev?.role !== "user") {
      issues.push(`msg[${i}] assistant not preceded by user (got ${prev?.role})`);
      continue;
    }
    const isPick = prev.content?.startsWith("Pick the next tool");
    const isArgs = prev.content?.startsWith("Provide arguments for");
    if (!isPick && !isArgs) {
      const firstAssistantIdx = msgs.findIndex((m) => m.role === "assistant");
      if (i !== firstAssistantIdx) {
        issues.push(`msg[${i}] assistant preceded by non-prompt user turn`);
      }
    }
  }

  for (const [i, m] of msgs.entries()) {
    if (m.tool_calls !== undefined) issues.push(`msg[${i}] still has tool_calls field`);
    if (m.final_answer !== undefined) issues.push(`msg[${i}] still has final_answer field`);
  }

  return issues;
}

const lines = readFileSync(SRC, "utf8")
  .split("\n")
  .filter((l) => l.length > 0);
const v2records = [];
const errors = [];

for (const [i, line] of lines.entries()) {
  let v1;
  try {
    v1 = JSON.parse(line);
  } catch (e) {
    errors.push(`line ${i + 1}: invalid JSON in source: ${e.message}`);
    continue;
  }
  const v2 = reshapeRecord(v1);
  const issues = validateV2(v2);
  if (issues.length > 0) {
    errors.push(`record ${v1.id}: ${issues.join("; ")}`);
  } else {
    v2records.push(v2);
  }
}

const out = v2records.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(DST, out, "utf8");

const byCat = {};
const byLoss = {};
for (const r of v2records) {
  byCat[r.category] = (byCat[r.category] ?? 0) + 1;
  byLoss[r.loss_weight_tokens] = (byLoss[r.loss_weight_tokens] ?? 0) + 1;
}

console.log(`✓ Reshaped ${lines.length} v1 records → ${v2records.length} v2 records`);
console.log(`  → ${DST}`);
console.log(`  By category: ${JSON.stringify(byCat)}`);
console.log(`  By loss bucket: ${JSON.stringify(byLoss)}`);
console.log(`  Bytes: ${out.length}`);
if (errors.length > 0) {
  console.log(`\n⚠ ${errors.length} validation issues:`);
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
  if (errors.length > 10) console.log(`  ...and ${errors.length - 10} more`);
  process.exit(1);
}
console.log("\n✓ All records pass v2-arm-f shape validation.");
