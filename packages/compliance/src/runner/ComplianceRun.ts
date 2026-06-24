/**
 * ComplianceRun — top-level orchestrator.
 *
 *   prompt → model → write artifact → verify → (if fail) repair → re-verify
 *                                                                   ↓
 *                                                          ComplianceEvalRecord
 *
 * Phase 0 supports three baselines, selected by `mode`:
 *
 *   - "direct"     — generate once, verify, return. No repair, no retry.
 *   - "prompt_retry" — generate; on fail, regenerate up to N times with
 *                     the violation hint appended to the prompt. No
 *                     local repair, no ConstraintIR-driven planning.
 *                     This is the canonical "Prompt+Retry" baseline.
 *   - "full_pcl"   — generate; on fail, hand off to RepairPlanner for
 *                    constraint-by-constraint local repair.
 *
 * # Why a single class instead of three classes
 *
 * The three modes share 90% of the structure: prompt building, model
 * invocation, workspace write, verification, eval-record assembly. The
 * branching is just the "what happens on first failure" step. Putting
 * it all in one class makes the cost-comparison story easier (same
 * code path, same telemetry).
 */

import { createHash } from "node:crypto";
import type { Model } from "@wasmagent/core/models";
import type { TaskSpec } from "../ir/ConstraintIR.js";
import type { RepairPlanner, WorkspaceWriter } from "../repair/RepairPlanner.js";
import type { RepairTraceEntry } from "../repair/RepairTrace.js";
import type { ComplianceVerifier } from "../verifier/ComplianceVerifier.js";
import type { ConstraintViolation } from "../verifier/violation.js";

export type RunMode = "direct" | "prompt_retry" | "full_pcl";

export interface ComplianceRunOptions {
  spec: TaskSpec;
  /** Natural-language prompt sent to the model. */
  prompt: string;
  /** Path the model's response is written to (the verifier reads it). */
  artifact_path: string;
  /** Stable model identifier for the eval record (e.g. "qwen2.5-1.5b-instruct"). */
  model_id: string;
  mode: RunMode;
  model: Model;
  verifier: ComplianceVerifier;
  writer: WorkspaceWriter;
  /**
   * Required when mode === "full_pcl"; ignored otherwise. We don't
   * default-construct a planner here so the caller controls strategy
   * registration and the LLM used for regeneration.
   */
  planner?: RepairPlanner;
  /**
   * Cap on retries for `prompt_retry`. Default 3. Ignored in other
   * modes.
   */
  max_retries?: number;
  /** Max tokens for the initial generation. */
  max_tokens?: number;
  /** Temperature for the initial generation. */
  temperature?: number;
  /**
   * Seed for the initial generation. When provided, runs against
   * deterministic models (e.g. LocalModel via node-llama-cpp) become
   * reproducible — important for any baseline comparison where
   * stochastic variance can swamp a real effect (confirmed
   * empirically 2026-06-24 when an unseeded baseline vs P1 sweep
   * differed on 47/50 direct-mode artifacts despite identical
   * configuration).
   */
  seed?: number;
}

/**
 * Eval record emitted by one run. Wire-shape mirrored in
 * `schemas/compliance-eval-record.schema.json`. Kept self-contained
 * for Phase 0 — Phase 1 will embed this into RolloutMemoryStore JSONL.
 *
 * `error` is non-null when the run failed *infrastructurally* (model
 * error, sandbox crash, sequence-pool exhaustion). It is NOT used for
 * verifier failures — those land in `violations` with `final_pass=false`
 * but the record is otherwise complete. This separation matters: a
 * user inspecting a JSONL of records can distinguish "model said
 * something the verifier didn't like" (the experiment worked) from
 * "the runtime broke" (the experiment is contaminated).
 */
export interface ComplianceEvalRecord {
  task_id: string;
  task_spec_hash: string;
  model: string;
  mode: RunMode;
  violations: ConstraintViolation[];
  repair_trace: RepairTraceEntry[];
  repair_rounds: number;
  final_pass: boolean;
  token_cost: {
    prompt?: number;
    generation?: number;
    repair?: number;
  };
  latency_ms: number;
  /** Final artifact text — kept for inspection / human eval. */
  artifact: string;
  /**
   * Infrastructural failure marker. Non-null iff the run could NOT
   * complete (model threw, sandbox crashed, etc.). When set,
   * `final_pass` is forced to false and downstream consumers
   * (benchmark aggregator, training-data exporter) MUST exclude this
   * record from rate calculations.
   */
  error?: {
    /** Coarse failure category for filtering. */
    kind: "model_error" | "verifier_error" | "repair_error" | "workspace_error" | "unknown";
    /** Original error message (truncated to 1000 chars). */
    message: string;
    /** Which step of the run produced the error. */
    stage: "generate" | "verify" | "repair" | "write";
  };
}

export class ComplianceRun {
  readonly #opts: ComplianceRunOptions;
  constructor(opts: ComplianceRunOptions) {
    this.#opts = opts;
  }

  /**
   * Execute the run.
   *
   * Always returns a `ComplianceEvalRecord` — even on infrastructural
   * failure. When the run fails before completing (model error, sandbox
   * crash, sequence-pool exhaustion, …), the record's `error` field is
   * set, `final_pass` is forced false, and partial telemetry that was
   * already collected (initial generation, initial violations) is
   * preserved. This is intentional: long-running sweeps must never
   * lose silent failures, and downstream aggregators need to be able
   * to *count* the broken runs separately from passing/failing ones.
   *
   * The only exception that still throws is the programming-error path
   * (e.g. `mode='full_pcl'` without a planner). Those represent a
   * misconfiguration the caller must fix, not a runtime fault.
   */
  async execute(): Promise<ComplianceEvalRecord> {
    const { spec, mode } = this.#opts;
    const t0 = performance.now();
    const taskSpecHash = sha256Hex(JSON.stringify(spec));

    // Programming-error fast-path: validate the configuration before
    // starting any I/O so the caller gets a clear, immediate error
    // rather than 30s into a generation.
    if (mode === "full_pcl" && !this.#opts.planner) {
      throw new Error("ComplianceRun: mode='full_pcl' requires opts.planner");
    }

    // State that persists across stages — needed for the error
    // recovery path so we don't lose partial telemetry.
    let artifact = "";
    let initialViolations: ConstraintViolation[] = [];
    let repair_trace: RepairTraceEntry[] = [];
    let repair_token_cost = 0;
    let final_pass = false;
    let initialPromptTokens: number | undefined;
    let initialGenTokens: number | undefined;
    let runError: ComplianceEvalRecord["error"];

    try {
      // 1. Initial generation.
      const initial = await this.#generate(this.#opts.prompt).catch((e) => {
        throw tag(e, "generate", "model_error");
      });
      artifact = initial.text;
      if (initial.prompt_tokens !== undefined) initialPromptTokens = initial.prompt_tokens;
      if (initial.completion_tokens !== undefined) initialGenTokens = initial.completion_tokens;
      await this.#opts.writer.writeFile(this.#opts.artifact_path, initial.text).catch((e) => {
        throw tag(e, "write", "workspace_error");
      });

      // 2. Initial verification.
      const firstCheck = await this.#opts.verifier.verify(spec).catch((e) => {
        throw tag(e, "verify", "verifier_error");
      });
      initialViolations = firstCheck.violations;
      let violations = initialViolations;
      final_pass = firstCheck.ok;

      if (!firstCheck.ok) {
        if (mode === "prompt_retry") {
          const result = await this.#promptRetry(
            this.#opts.prompt,
            violations,
            this.#opts.max_retries ?? 3
          ).catch((e) => {
            throw tag(e, "repair", "repair_error");
          });
          artifact = result.artifact;
          violations = result.violations;
          repair_token_cost = result.repair_tokens;
          final_pass = result.final_pass;
          // prompt_retry has no per-round trace — record a single
          // synthetic entry summarising the retries for cost compare.
          if (result.attempts > 0) {
            repair_trace = [
              {
                round: 1,
                violation_ids: initialViolations.map((v) => v.constraint_id),
                strategy: "full",
                ok: final_pass,
                remaining_violation_ids: violations.map((v) => v.constraint_id),
                token_cost: {
                  ...(result.repair_tokens > 0 ? { generation: result.repair_tokens } : {}),
                },
              },
            ];
          }
        } else if (mode === "full_pcl") {
          // planner non-null guaranteed by the fast-path check above.
          const planner = this.#opts.planner;
          if (!planner) {
            throw new Error("ComplianceRun: mode='full_pcl' requires opts.planner");
          }
          const result = await planner
            .repair({
              spec,
              artifact_path: this.#opts.artifact_path,
              initial_artifact: artifact,
              initial_violations: initialViolations,
            })
            .catch((e) => {
              throw tag(e, "repair", "repair_error");
            });
          artifact = result.artifact;
          violations = result.remaining_hard_violations;
          repair_trace = result.trace;
          repair_token_cost = sumTokenCost(result.trace);
          final_pass = result.final_pass;
        }
        // mode === "direct" — no repair, final_pass already set.
        // Mark violations used (no-op assignment to silence linters).
        void violations;
      }
    } catch (e) {
      // Capture and tag as an infrastructure failure. We still return a
      // record so downstream JSONL aggregators see exactly what
      // happened.
      const tagged = e as TaggedError;
      runError = {
        kind: tagged.errorKind ?? "unknown",
        message: truncate(e instanceof Error ? e.message : String(e), 1000),
        stage: tagged.stage ?? "generate",
      };
      final_pass = false;
    }

    const latency_ms = Math.round(performance.now() - t0);

    const record: ComplianceEvalRecord = {
      task_id: spec.id,
      task_spec_hash: taskSpecHash,
      model: this.#opts.model_id,
      mode,
      violations: initialViolations,
      repair_trace,
      repair_rounds: repair_trace.length,
      final_pass,
      token_cost: {
        ...(initialPromptTokens !== undefined ? { prompt: initialPromptTokens } : {}),
        ...(initialGenTokens !== undefined ? { generation: initialGenTokens } : {}),
        ...(repair_token_cost > 0 ? { repair: repair_token_cost } : {}),
      },
      latency_ms,
      artifact,
    };
    if (runError) record.error = runError;
    return record;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Run one generation; return text + usage. */
  async #generate(promptText: string): Promise<{
    text: string;
    prompt_tokens?: number;
    completion_tokens?: number;
  }> {
    const generateOpts: { maxTokens?: number; temperature?: number; seed?: number } = {};
    if (this.#opts.max_tokens !== undefined) generateOpts.maxTokens = this.#opts.max_tokens;
    if (this.#opts.temperature !== undefined) generateOpts.temperature = this.#opts.temperature;
    if (this.#opts.seed !== undefined) generateOpts.seed = this.#opts.seed;

    let text = "";
    let prompt_tokens: number | undefined;
    let completion_tokens: number | undefined;
    for await (const ev of this.#opts.model.generate(
      [{ role: "user", content: promptText }],
      generateOpts
    )) {
      if (ev.type === "text_delta" && ev.delta) {
        text += ev.delta;
      } else if (ev.type === "usage" && ev.usage) {
        const u = ev.usage as unknown as Record<string, unknown>;
        const inT = u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens;
        const outT = u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens;
        if (typeof inT === "number") prompt_tokens = inT;
        if (typeof outT === "number") completion_tokens = outT;
      }
    }
    const result: { text: string; prompt_tokens?: number; completion_tokens?: number } = {
      text,
    };
    if (prompt_tokens !== undefined) result.prompt_tokens = prompt_tokens;
    if (completion_tokens !== undefined) result.completion_tokens = completion_tokens;
    return result;
  }

  /**
   * Prompt+Retry baseline. Re-prompt up to N times, appending the
   * verifier's violation hints. No ConstraintIR-driven planning — this
   * is what most production systems do today.
   */
  async #promptRetry(
    originalPrompt: string,
    initialViolations: ConstraintViolation[],
    maxRetries: number
  ): Promise<{
    artifact: string;
    violations: ConstraintViolation[];
    repair_tokens: number;
    attempts: number;
    final_pass: boolean;
  }> {
    let violations = initialViolations;
    let artifact = "";
    let attempts = 0;
    let repair_tokens = 0;

    while (violations.length > 0 && attempts < maxRetries) {
      attempts++;
      const hints = violations.map((v) => `- ${v.constraint_id}: ${v.hint}`).join("\n");
      const retryPrompt =
        `${originalPrompt}\n\nThe previous attempt failed these checks:\n${hints}\n\n` +
        "Try again. Output ONLY the new response.";
      const result = await this.#generate(retryPrompt);
      repair_tokens += result.completion_tokens ?? 0;
      artifact = result.text;
      await this.#opts.writer.writeFile(this.#opts.artifact_path, artifact);
      const check = await this.#opts.verifier.verify(this.#opts.spec);
      violations = check.violations;
    }

    return {
      artifact,
      violations,
      repair_tokens,
      attempts,
      final_pass: violations.length === 0,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sumTokenCost(trace: RepairTraceEntry[]): number {
  let n = 0;
  for (const t of trace) {
    n += t.token_cost?.generation ?? 0;
    n += t.token_cost?.prompt ?? 0;
  }
  return n;
}

/** Truncate a string to `n` chars, appending an ellipsis marker. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}… [truncated ${s.length - n} chars]`;
}

/**
 * Carrier for the (stage, kind) tags we want to flow with an error to
 * the outer catch. We mutate the original error so the stack trace is
 * preserved — `throw new Error(...)` would hide where the failure
 * actually came from.
 */
interface TaggedError extends Error {
  stage?: NonNullable<ComplianceEvalRecord["error"]>["stage"];
  errorKind?: NonNullable<ComplianceEvalRecord["error"]>["kind"];
}

function tag(
  e: unknown,
  stage: NonNullable<ComplianceEvalRecord["error"]>["stage"],
  kind: NonNullable<ComplianceEvalRecord["error"]>["kind"]
): TaggedError {
  const err = (e instanceof Error ? e : new Error(String(e))) as TaggedError;
  // Only set if not already tagged — preserve the first (deepest) tag.
  if (!err.stage) err.stage = stage;
  if (!err.errorKind) err.errorKind = kind;
  return err;
}
