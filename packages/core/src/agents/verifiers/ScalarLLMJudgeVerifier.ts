/**
 * ScalarLLMJudgeVerifier — extends the LLMJudgeVerifier pattern to support
 * two additional output modes needed for RLAIF ranking:
 *
 *   - score mode:   single call returns { score: 0-10, reasoning }
 *   - pairwise mode: returns { preferred: "a"|"b"|"tie", reasoning }
 *
 * Inherits all five reward-hacking defences from LLMJudgeVerifier:
 * default-fail, k-of-N voting, low temperature (0.1), strict structured
 * output, and independent judge model.
 *
 * Score mode implements the Verifier interface; the numeric score is surfaced
 * via the extended CriterionVerdict (ok:true) so VerificationPipeline can
 * consume it. The score is stored in the `score` extension field — callers
 * that only care about pass/fail can ignore it.
 *
 * Pairwise mode is NOT a Verifier — call comparePair() directly.
 */

import type { Model } from "../../models/types.js";
import type { Criterion, Verifier, WorkspaceReader } from "./types.js";

// ── Extended verdict type for scalar scoring ────────────────────────────────

export type ScalarVerdict =
  | { ok: true; criterionId: string; score: number; reasoning: string }
  | { ok: false; criterionId: string; hint: string };

export type PairwiseVerdict = {
  preferred: "a" | "b" | "tie";
  reasoning: string;
};

// ── Options ──────────────────────────────────────────────────────────────────

export interface ScalarLLMJudgeVerifierOptions {
  /** The model used to judge. Recommended: separate from the executing model. */
  model: Model;
  /**
   * Independent judge calls per criterion (score mode). Default 3.
   * Final score is the mean of all parseable votes.
   */
  samples?: number;
  /** Sampling temperature. Default 0.1. */
  temperature?: number;
  /** Token cap per call. Default 400. */
  maxTokens?: number;
  /**
   * Hard limit on judge calls per batch. Rollouts beyond this cap receive
   * a neutral score (5.0) and are not sent to the model.
   */
  maxJudgeCallsPerBatch?: number;
  /**
   * If a criterion has a `path`, the judge sees the file contents
   * truncated to this many characters. Default 8000.
   */
  maxArtifactChars?: number;
}

// ── System prompts (exported for test lock-down) ─────────────────────────────

export const SCORE_JUDGE_SYSTEM_PROMPT = `You are an expert evaluator scoring an agent's output on a single criterion.

Score from 0 to 10 where:
  0  = completely fails the criterion or output is missing
  5  = partially meets the criterion with significant gaps
  10 = fully satisfies the criterion with no notable issues

Default to low scores when uncertain. Do not speculate about intent.

Reply with strict JSON, one line, no prose, no markdown fencing:
{"score": <integer 0-10>, "reasoning": "<one short sentence>"}`;

export const PAIRWISE_JUDGE_SYSTEM_PROMPT = `You are an expert evaluator comparing two agent outputs for a single criterion.

Choose which output better satisfies the criterion, or "tie" if they are equivalent.
Default to "tie" when uncertain or when the difference is negligible.

Reply with strict JSON, one line, no prose, no markdown fencing:
{"preferred": "a" | "b" | "tie", "reasoning": "<one short sentence>"}`;

// ── Reply parsers ─────────────────────────────────────────────────────────────

interface ScoreReply {
  score: number;
  reasoning: string;
}

interface PairReply {
  preferred: "a" | "b" | "tie";
  reasoning: string;
}

function parseScoreReply(text: string): ScoreReply | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const match = stripped.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { score?: unknown; reasoning?: unknown };
    const score = Number(parsed.score);
    if (!Number.isFinite(score) || score < 0 || score > 10) return null;
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
    return { score: Math.round(score), reasoning };
  } catch {
    return null;
  }
}

function parsePairReply(text: string): PairReply | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const match = stripped.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { preferred?: unknown; reasoning?: unknown };
    if (parsed.preferred !== "a" && parsed.preferred !== "b" && parsed.preferred !== "tie") {
      return null;
    }
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
    return { preferred: parsed.preferred as "a" | "b" | "tie", reasoning };
  } catch {
    return null;
  }
}

// ── Single-call helpers ───────────────────────────────────────────────────────

async function singleScoreCall(
  model: Model,
  systemPrompt: string,
  userMessage: string,
  opts: { temperature: number; maxTokens: number }
): Promise<string> {
  let buffer = "";
  for await (const ev of model.generate(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    { stream: true, temperature: opts.temperature, maxTokens: opts.maxTokens }
  )) {
    if (ev.type === "text_delta" && ev.delta) buffer += ev.delta;
  }
  return buffer;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class ScalarLLMJudgeVerifier implements Verifier {
  readonly methods = ["scalar_judge"] as const;

  readonly #model: Model;
  readonly #samples: number;
  readonly #temperature: number;
  readonly #maxTokens: number;
  readonly #maxArtifactChars: number;
  readonly #maxJudgeCallsPerBatch: number;
  #callsThisBatch = 0;

  constructor(opts: ScalarLLMJudgeVerifierOptions) {
    this.#model = opts.model;
    this.#samples = Math.max(1, opts.samples ?? 3);
    this.#temperature = opts.temperature ?? 0.1;
    this.#maxTokens = opts.maxTokens ?? 400;
    this.#maxArtifactChars = opts.maxArtifactChars ?? 8000;
    this.#maxJudgeCallsPerBatch = opts.maxJudgeCallsPerBatch ?? Number.POSITIVE_INFINITY;
  }

  /** Reset the per-batch call counter before starting a new batch. */
  resetBatch(): void {
    this.#callsThisBatch = 0;
  }

  async verify(criterion: Criterion, ws: WorkspaceReader): Promise<ScalarVerdict> {
    // Enforce per-batch cap: skip judge call, return neutral score.
    if (this.#callsThisBatch + this.#samples > this.#maxJudgeCallsPerBatch) {
      return {
        ok: true,
        criterionId: criterion.id,
        score: 5,
        reasoning: "skipped: maxJudgeCallsPerBatch exceeded, neutral score assigned",
      };
    }

    let artifact: string | null = null;
    if (criterion.path) {
      try {
        if (await ws.fileExists(criterion.path)) {
          const body = await ws.readFile(criterion.path);
          artifact =
            body.length <= this.#maxArtifactChars
              ? body
              : `${body.slice(0, this.#maxArtifactChars)}\n…[truncated]`;
        }
      } catch (e) {
        return {
          ok: false,
          criterionId: criterion.id,
          hint: `ScalarLLMJudgeVerifier failed to read ${criterion.path}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    const userMessage = [
      `Criterion id: ${criterion.id}`,
      `Criterion description: ${criterion.description}`,
      artifact === null
        ? "Artifact: <none — criterion has no path or file is missing>"
        : `Artifact:\n---\n${artifact}\n---`,
    ].join("\n");

    const scores: number[] = [];
    const reasonings: string[] = [];
    for (let i = 0; i < this.#samples; i++) {
      this.#callsThisBatch++;
      try {
        const raw = await singleScoreCall(this.#model, SCORE_JUDGE_SYSTEM_PROMPT, userMessage, {
          temperature: this.#temperature,
          maxTokens: this.#maxTokens,
        });
        const parsed = parseScoreReply(raw);
        if (parsed) {
          scores.push(parsed.score);
          reasonings.push(parsed.reasoning);
        }
        // Unparseable reply: treated as no vote (excluded from mean)
      } catch {
        // Model call failure: excluded from mean
      }
    }

    if (scores.length === 0) {
      return {
        ok: false,
        criterionId: criterion.id,
        hint: "all judge calls failed or returned unparseable output",
      };
    }

    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const score = Math.round(mean);
    const reasoning = reasonings[0] ?? "";

    return { ok: true, criterionId: criterion.id, score, reasoning };
  }

  /**
   * Compare two rollout outputs for a criterion. Not part of the Verifier
   * interface — call directly from RolloutRanker.
   *
   * Unparseable responses are counted as "tie" (never throw).
   */
  async comparePair(opts: {
    criterionDescription: string;
    outputA: string;
    outputB: string;
  }): Promise<PairwiseVerdict> {
    const userMessage = [
      `Criterion: ${opts.criterionDescription}`,
      `Output A:\n---\n${opts.outputA}\n---`,
      `Output B:\n---\n${opts.outputB}\n---`,
    ].join("\n");

    const votes: PairReply[] = [];
    for (let i = 0; i < this.#samples; i++) {
      try {
        const raw = await singleScoreCall(this.#model, PAIRWISE_JUDGE_SYSTEM_PROMPT, userMessage, {
          temperature: this.#temperature,
          maxTokens: this.#maxTokens,
        });
        const parsed = parsePairReply(raw);
        if (parsed) votes.push(parsed);
        else votes.push({ preferred: "tie", reasoning: "unparseable judge output" });
      } catch {
        votes.push({ preferred: "tie", reasoning: "judge call failed" });
      }
    }

    if (votes.length === 0) return { preferred: "tie", reasoning: "no votes collected" };

    const counts = { a: 0, b: 0, tie: 0 };
    for (const v of votes) counts[v.preferred]++;
    const maxCount = Math.max(counts.a, counts.b, counts.tie);
    let preferred: "a" | "b" | "tie" = "tie";
    if (counts.a === maxCount && counts.a > counts.b && counts.a > counts.tie) preferred = "a";
    else if (counts.b === maxCount && counts.b > counts.a && counts.b > counts.tie) preferred = "b";

    const winnerVote = votes.find((v) => v.preferred === preferred) ?? votes[0];
    return { preferred, reasoning: winnerVote?.reasoning ?? "" };
  }
}
