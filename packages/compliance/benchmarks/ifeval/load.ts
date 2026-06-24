/**
 * IFEval loader — read the curated 50-sample subset and convert each
 * sample to a `TaskSpec`.
 *
 * Input shape (one JSON object per line in samples.jsonl):
 *
 *   {
 *     key: 19,
 *     prompt: "Write a 600-word essay about ...",
 *     instruction_id_list: ["length_constraints:number_words", ...],
 *     kwargs: [{relation:"at least", num_words:600}, ...]
 *   }
 *
 * Output: one `TaskSpec` per sample, with one `ConstraintIR` per
 * instruction_id. `verify_method` is the upstream id prefixed with
 * `ifeval:` so the `IFEvalVerifier` picks it up.
 *
 * # Design note: response path
 *
 * IFEval doesn't ship reference answers — verification runs on the
 * *model's* response. We pick a per-sample response path
 * (`response_<key>.txt`) so a benchmark runner can write each model's
 * output to a fresh path and have the verifier read it back. The
 * runner is responsible for writing the response before invoking the
 * verifier.
 */

import { readFileSync } from "node:fs";
import type { ConstraintIR, RepairStrategy, TaskSpec } from "../../src/ir/ConstraintIR.js";

/** Raw shape of one row in samples.jsonl. */
export interface IFEvalSample {
  key: number;
  prompt: string;
  instruction_id_list: string[];
  kwargs: Array<Record<string, unknown>>;
}

export interface LoadedTask {
  /** Original sample, kept for the runner that needs the prompt. */
  sample: IFEvalSample;
  /** TaskSpec ready to feed into ComplianceVerifier. */
  spec: TaskSpec;
  /** Conventional response path the runner should write to. */
  responsePath: string;
}

/**
 * Convert one IFEval sample into a TaskSpec.
 *
 * Every instruction in the sample becomes a hard constraint with
 * priority 100 (IFEval doesn't grade soft instructions). Constraint ids
 * are `<sample_key>:<i>:<instruction_id>` for uniqueness across
 * samples and traceability back to the upstream row.
 */
export function sampleToTaskSpec(sample: IFEvalSample): LoadedTask {
  const responsePath = `response_${sample.key}.txt`;
  const constraints: ConstraintIR[] = sample.instruction_id_list.map((iid, i) => {
    const kw = sample.kwargs[i] ?? {};
    return {
      id: `${sample.key}:${i}:${iid}`,
      description: `IFEval ${iid}`,
      verify_method: `ifeval:${iid}`,
      arg: kw,
      path: responsePath,
      level: "hard",
      priority: 100,
      category: categoryFor(iid),
      // Default repair strategy is regenerate_region — IFEval responses
      // are short enough that section-level rewrites are usually
      // cheaper than full retry but cheaper-than-section patches are
      // rare to land cleanly. The planner can downshift to `patch`
      // when the violation is a single-character issue (no_comma,
      // english_lowercase).
      repair: { strategy: regenStrategyFor(iid) },
    };
  });

  const spec: TaskSpec = {
    id: `ifeval.${sample.key}`,
    intent: "ifeval_response",
    language: "en",
    constraints,
    priority_hierarchy: ["system_policy", "user_explicit_constraints"],
  };

  return { sample, spec, responsePath };
}

/** Load every sample in a JSONL file and convert to TaskSpecs. */
export function loadIFEvalSamples(jsonlPath: string): LoadedTask[] {
  const raw = readFileSync(jsonlPath, "utf8");
  const out: LoadedTask[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const sample = JSON.parse(trimmed) as IFEvalSample;
    out.push(sampleToTaskSpec(sample));
  }
  return out;
}

// ── Category mapping ────────────────────────────────────────────────────────
//
// Used for failure taxonomy reporting. IFEval's instruction taxonomy
// almost lines up with our category enum, with two compressions:
//   - `combination:*` and `startend:*` map to "format" because they
//     dictate the artifact's shape, not its content.
//   - `change_case:*` maps to "format" for the same reason — case
//     transforms are surface-level structural.

function categoryFor(instructionId: string): ConstraintIR["category"] {
  if (instructionId.startsWith("keywords:")) return "content";
  if (instructionId.startsWith("language:")) return "style";
  if (instructionId.startsWith("detectable_content:")) return "content";
  // Everything else — punctuation, length, detectable_format, change_case,
  // combination, startend — is structural.
  return "format";
}

function regenStrategyFor(instructionId: string): RepairStrategy {
  // Character-level violations (no_comma, lowercase) can be patched
  // cheaply by a regex-driven edit; the planner doesn't need an LLM
  // round.
  if (instructionId === "punctuation:no_comma") return "patch";
  if (instructionId === "change_case:english_lowercase") return "patch";
  // Title is an insertion task.
  if (instructionId === "detectable_format:title") return "insert_section";
  // repeat_prompt has a deterministic fix (prepend the verbatim prompt)
  // — much more reliable than LLM regeneration for this constraint
  // because the verifier requires byte-for-byte match at offset 0.
  // See InsertSectionStrategy#prependPrompt.
  if (instructionId === "combination:repeat_prompt") return "insert_section";
  // Everything else: regenerate the whole response. IFEval responses
  // are short enough that this is acceptable; cheaper strategies are
  // a Phase 1 optimisation.
  return "regenerate_region";
}
