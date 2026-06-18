/**
 * A4 — LLM-as-judge scorer (richer than llmJudge).
 *
 * llmJudge() above accepts a free-form rubric and emits a coarse 0/0.5/1.0.
 * That's fine for ad-hoc smoke tests; it does NOT match the nuance Mastra's
 * 2026 Studio scorers go for. JudgeScorer adds:
 *   - configurable score scale (default: 0–10, normalized to 0..1)
 *   - structured criterion-level breakdown
 *   - works with ANY @wasmagent/core Model — judges can run on cheap
 *     models (Haiku/Doubao/DeepSeek) while the agent uses expensive ones
 *   - two built-in domain judges (trajectory-quality, answer-completeness)
 *     so consumers get value without authoring a rubric from scratch
 */

import type { Model, ModelMessage } from "../models/types.js";
import type { AgentTrace, Scorer, ScorerResult } from "./index.js";

export interface JudgeCriterion {
  /** Stable id used in dashboards. Letters / digits / dashes only. */
  id: string;
  /** One-line description shown to the judge model. */
  description: string;
  /**
   * Optional weight in the composite score (defaults to 1). Weights are
   * normalised so they always sum to 1; zero-weight criteria are
   * graded but excluded from the composite.
   */
  weight?: number;
}

export interface JudgeScorerOptions {
  /** Stable name for the scorer — surfaced in dashboards / logs. */
  name: string;
  /** Model used to grade. Should be a cheap one. */
  model: Model;
  /** Criteria to grade. Order matters for prompt determinism. */
  criteria: JudgeCriterion[];
  /**
   * Optional score scale. Defaults to 10 (so the judge picks 0–10).
   * The composite is always normalised to 0..1 in {@link ScorerResult}.
   */
  scale?: number;
  /** Optional generate() override — typical: `{ temperature: 0 }`. */
  generateOpts?: { temperature?: number; maxTokens?: number };
  /**
   * Optional system prompt prefix. Useful if the host has domain-specific
   * conventions (eg "You are a senior reviewer at FinCorp"). Ignored when
   * empty.
   */
  systemPersona?: string;
}

export interface JudgeBreakdown {
  criterionId: string;
  /** Raw score the judge returned, on `scale` (defaults to 10). */
  raw: number;
  /** Normalized to [0, 1]. */
  normalized: number;
  /** Free-form reasoning the judge gave for this criterion. */
  reasoning: string;
}

export interface JudgeScorerResult extends ScorerResult {
  breakdown: JudgeBreakdown[];
  /** Raw composite the judge produced, before any clamping. */
  rawComposite: number;
}

/** Hint regex extracting `criterionId: <number>` blocks the judge emits. */
const CRITERION_LINE = /^\s*([A-Za-z0-9-]+)\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\((.*)\))?/m;

const REASONING_HEADER = /^\s*REASONING\b/im;
const SCORES_HEADER = /^\s*SCORES\b/im;

function buildPrompt(trace: AgentTrace, criteria: JudgeCriterion[], scale: number): string {
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c.id} — ${c.description}`).join("\n");
  const exampleId = criteria[0]?.id ?? "criterion-1";
  return `Task: ${trace.task}
Final answer: ${trace.finalAnswer ?? "(no answer)"}
Tool calls: ${trace.toolCalls.length}

Score the answer against EACH of these criteria on a ${scale}-point scale
(0 = fails, ${scale} = perfect). Be strict — most answers should land below
${Math.floor(scale * 0.7)}. Then sum-weight into a composite.

Criteria:
${criteriaList}

Respond in this EXACT format (no preamble, no closing remarks):

SCORES
${exampleId}: <number 0-${scale}> (<one short sentence>)
<other criteria, one per line>

REASONING
<two-sentence summary of why the composite landed where it did>`;
}

function parseJudgeReply(raw: string, criteria: JudgeCriterion[], scale: number): JudgeBreakdown[] {
  // Pull each criterionId line out of the SCORES block.
  const scoresStart = raw.search(SCORES_HEADER);
  const reasoningStart = raw.search(REASONING_HEADER);
  const scoreBlock = raw.slice(
    scoresStart === -1 ? 0 : scoresStart,
    reasoningStart === -1 ? raw.length : reasoningStart
  );
  const lines = scoreBlock.split(/\r?\n/);
  const breakdown: JudgeBreakdown[] = [];
  for (const c of criteria) {
    let found: JudgeBreakdown | null = null;
    for (const line of lines) {
      // Skip the SCORES header itself.
      if (/^SCORES\s*$/i.test(line.trim())) continue;
      const m = CRITERION_LINE.exec(line);
      if (!m) continue;
      const [, id, num, why] = m;
      if (!id || id.toLowerCase() !== c.id.toLowerCase()) continue;
      const raw = Math.max(0, Math.min(scale, Number(num)));
      found = {
        criterionId: c.id,
        raw,
        normalized: scale === 0 ? 0 : raw / scale,
        reasoning: why?.trim() ?? "",
      };
      break;
    }
    breakdown.push(
      found ?? {
        criterionId: c.id,
        raw: 0,
        normalized: 0,
        reasoning: "(judge did not score this criterion)",
      }
    );
  }
  return breakdown;
}

function compositeOf(breakdown: JudgeBreakdown[], criteria: JudgeCriterion[]): number {
  let totalWeight = 0;
  let weighted = 0;
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i];
    if (!c) continue;
    const weight = c.weight ?? 1;
    if (weight <= 0) continue;
    totalWeight += weight;
    weighted += weight * (breakdown[i]?.normalized ?? 0);
  }
  return totalWeight === 0 ? 0 : weighted / totalWeight;
}

/**
 * Run the judge against one trace. Async because LLM calls are; the
 * synchronous Scorer interface returns a sentinel and points at
 * {@link runJudgeScorer}.
 */
export async function runJudgeScorer(
  trace: AgentTrace,
  opts: JudgeScorerOptions
): Promise<JudgeScorerResult> {
  const scale = opts.scale ?? 10;
  const messages: ModelMessage[] = [];
  if (opts.systemPersona) {
    messages.push({ role: "system", content: opts.systemPersona });
  }
  messages.push({ role: "user", content: buildPrompt(trace, opts.criteria, scale) });

  let raw = "";
  for await (const ev of opts.model.generate(messages, {
    stream: true,
    temperature: opts.generateOpts?.temperature ?? 0,
    maxTokens: opts.generateOpts?.maxTokens ?? 600,
  })) {
    if (ev.type === "text_delta" && ev.delta) raw += ev.delta;
  }

  const breakdown = parseJudgeReply(raw, opts.criteria, scale);
  const composite = compositeOf(breakdown, opts.criteria);
  return {
    scorer: opts.name,
    score: Math.max(0, Math.min(1, composite)),
    rawComposite: composite,
    breakdown,
    detail: breakdown.map((b) => `${b.criterionId}=${b.raw}/${scale}`).join(", "),
  };
}

/**
 * Convenience wrapper. The synchronous Scorer surface returns a 0-score
 * sentinel pointing callers at the async runner — same trick as llmJudge.
 */
export function judgeScorer(opts: JudgeScorerOptions): Scorer {
  return {
    name: opts.name,
    score(): ScorerResult {
      return {
        scorer: opts.name,
        score: 0,
        detail: "Use runJudgeScorer() for asynchronous LLM evaluation",
      };
    },
  };
}

// ── Built-in domain judges ──────────────────────────────────────────────────

/** Default criteria for `trajectoryQualityJudge`. */
export const TRAJECTORY_QUALITY_CRITERIA: JudgeCriterion[] = [
  {
    id: "efficiency",
    description:
      "Did the agent use the minimum tool calls necessary? Penalise retries and dead ends.",
  },
  {
    id: "tool-fit",
    description: "Did the agent pick appropriate tools for each step? No 'guessing' tool inputs.",
  },
  {
    id: "self-correction",
    description: "When the agent saw an error, did it fix the cause rather than retry blindly?",
  },
];

/**
 * Built-in: judges trajectory quality (efficiency + tool fit + self-correction).
 * Inspired by SWE-Bench and τ-bench's heuristic scorers — but driven by an LLM
 * so it adapts to tasks the rule-based scorers can't pattern-match.
 */
export function trajectoryQualityJudge(
  model: Model,
  override: Partial<Omit<JudgeScorerOptions, "model">> = {}
): JudgeScorerOptions {
  return {
    name: "trajectoryQuality",
    model,
    criteria: override.criteria ?? TRAJECTORY_QUALITY_CRITERIA,
    scale: override.scale ?? 10,
    generateOpts: override.generateOpts ?? { temperature: 0 },
    ...(override.systemPersona ? { systemPersona: override.systemPersona } : {}),
  };
}

/** Default criteria for `answerCompletenessJudge`. */
export const ANSWER_COMPLETENESS_CRITERIA: JudgeCriterion[] = [
  {
    id: "coverage",
    description:
      "Did the answer address every part of the task? Penalise sub-questions left unanswered.",
  },
  {
    id: "actionability",
    description: "Is the answer concrete enough for the user to act on without follow-up?",
  },
  {
    id: "honesty",
    description:
      "When the answer is uncertain, does it say so? Penalise overconfident hand-waving.",
  },
];

/**
 * Built-in: judges whether an answer is COMPLETE relative to the task.
 * Answers can be technically correct yet skip a sub-question; this judge
 * catches that. Pair with rule-based scorers (exactMatch, faithfulness)
 * for a balanced suite.
 */
export function answerCompletenessJudge(
  model: Model,
  override: Partial<Omit<JudgeScorerOptions, "model">> = {}
): JudgeScorerOptions {
  return {
    name: "answerCompleteness",
    model,
    criteria: override.criteria ?? ANSWER_COMPLETENESS_CRITERIA,
    scale: override.scale ?? 10,
    generateOpts: override.generateOpts ?? { temperature: 0 },
    ...(override.systemPersona ? { systemPersona: override.systemPersona } : {}),
  };
}
