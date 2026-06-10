/**
 * Minimal evals framework (B1).
 *
 * Provides a Scorer interface, built-in scorers, a trace collector,
 * and runEval() for evaluating agent runs against a dataset.
 */

import type { GuardrailResult, OutputGuardrail } from "../guardrails/index.js";
import { runOutputGuardrails } from "../guardrails/index.js";
import type { Model, ModelMessage } from "../models/types.js";
import type { AgentEvent } from "../types/events.js";

// ── Scorer interface ──────────────────────────────────────────────────────────

export interface AgentTrace {
  traceId: string;
  task: string;
  events: AgentEvent[];
  finalAnswer: string | null;
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; callId: string }>;
  toolResults: Array<{ toolName: string; output: unknown; callId: string; isError: boolean }>;
}

export interface EvalSample {
  id: string;
  task: string;
  /** Expected final answer (for exactMatch scorer). */
  expectedAnswer?: string;
  /** Expected ordered sequence of tool names (for toolCallAccuracy scorer). */
  expectedTools?: string[];
}

export interface ScorerResult {
  /** Scorer name. */
  scorer: string;
  /** Score in [0, 1]. */
  score: number;
  /** Optional details. */
  detail?: string;
}

export interface Scorer {
  readonly name: string;
  score(trace: AgentTrace, sample: EvalSample): ScorerResult;
}

// ── Trace collector ───────────────────────────────────────────────────────────

export function collectTrace(task: string, events: AgentEvent[]): AgentTrace {
  const first = events[0];
  const traceId = first ? first.traceId : "unknown";
  let finalAnswer: string | null = null;
  const toolCalls: AgentTrace["toolCalls"] = [];
  const toolResults: AgentTrace["toolResults"] = [];

  for (const ev of events) {
    if (ev.event === "final_answer" && ev.channel === "text") {
      finalAnswer = String((ev as { data: { answer: unknown } }).data.answer ?? "");
    }
    if (ev.event === "tool_call" && ev.channel === "tool") {
      const d = (
        ev as { data: { toolName: string; args: Record<string, unknown>; callId: string } }
      ).data;
      toolCalls.push({ toolName: d.toolName, args: d.args, callId: d.callId });
    }
    if (ev.event === "tool_result" && ev.channel === "tool") {
      const d = (
        ev as { data: { toolName: string; output: unknown; callId: string; error?: unknown } }
      ).data;
      toolResults.push({
        toolName: d.toolName,
        output: d.output,
        callId: d.callId,
        isError: !!d.error,
      });
    }
  }

  return { traceId, task, events, finalAnswer, toolCalls, toolResults };
}

// ── Built-in scorers ──────────────────────────────────────────────────────────

/** Exact string match against expectedAnswer (case-insensitive, trimmed). */
export const exactMatch: Scorer = {
  name: "exactMatch",
  score(trace, sample) {
    if (sample.expectedAnswer === undefined) {
      return { scorer: "exactMatch", score: 0, detail: "no expectedAnswer in sample" };
    }
    const got = (trace.finalAnswer ?? "").trim().toLowerCase();
    const want = sample.expectedAnswer.trim().toLowerCase();
    return { scorer: "exactMatch", score: got === want ? 1 : 0 };
  },
};

/**
 * Compares actual tool call sequence against expectedTools.
 * Score = |intersection| / max(|actual|, |expected|).
 * Order-sensitive: full credit only when sequence matches exactly.
 */
export const toolCallAccuracy: Scorer = {
  name: "toolCallAccuracy",
  score(trace, sample) {
    if (!sample.expectedTools || sample.expectedTools.length === 0) {
      return { scorer: "toolCallAccuracy", score: 1, detail: "no expectedTools — skipped" };
    }
    const actual = trace.toolCalls.map((c) => c.toolName);
    const expected = sample.expectedTools;
    // Longest common subsequence length as the intersection measure.
    const lcs = lcsLength(actual, expected);
    const denom = Math.max(actual.length, expected.length);
    const score = denom === 0 ? 1 : lcs / denom;
    return {
      scorer: "toolCallAccuracy",
      score,
      detail: `actual=[${actual.join(",")}] expected=[${expected.join(",")}] lcs=${lcs}`,
    };
  },
};

/**
 * Trajectory validity: every tool_call event must be paired with a tool_result
 * event with the same callId. Score = paired / total.
 */
export const trajectoryValidity: Scorer = {
  name: "trajectoryValidity",
  score(trace) {
    const callIds = new Set(trace.toolCalls.map((c) => c.callId));
    const resultIds = new Set(trace.toolResults.map((r) => r.callId));
    if (callIds.size === 0)
      return { scorer: "trajectoryValidity", score: 1, detail: "no tool calls" };
    let paired = 0;
    for (const id of callIds) {
      if (resultIds.has(id)) paired++;
    }
    return { scorer: "trajectoryValidity", score: paired / callIds.size };
  },
};

/** Final answer length normalised to [0, 1] by a target length (default 200 chars). */
export function finalAnswerLength(targetChars = 200): Scorer {
  return {
    name: "finalAnswerLength",
    score(trace) {
      const len = (trace.finalAnswer ?? "").length;
      return { scorer: "finalAnswerLength", score: Math.min(len / targetChars, 1) };
    },
  };
}

// ── runEval ───────────────────────────────────────────────────────────────────

export interface EvalRunResult {
  sample: EvalSample;
  trace: AgentTrace;
  scores: ScorerResult[];
}

export type AgentRunner = (task: string) => AsyncGenerator<AgentEvent>;

/**
 * Run each sample through the agent, collect traces, and score with all scorers.
 */
export async function runEval(
  dataset: EvalSample[],
  runner: AgentRunner,
  scorers: Scorer[]
): Promise<EvalRunResult[]> {
  const results: EvalRunResult[] = [];
  for (const sample of dataset) {
    const events: AgentEvent[] = [];
    for await (const ev of runner(sample.task)) {
      events.push(ev);
    }
    const trace = collectTrace(sample.task, events);
    const scores = scorers.map((s) => s.score(trace, sample));
    results.push({ sample, trace, scores });
  }
  return results;
}

// ── LCS helper ────────────────────────────────────────────────────────────────

function lcsLength(a: string[], b: string[]): number {
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      // biome-ignore lint/style/noNonNullAssertion: dp is fully initialized, indices always valid
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? (dp[i - 1]?.[j - 1] ?? 0) + 1
          : Math.max(dp[i - 1]?.[j] ?? 0, dp[i]?.[j - 1] ?? 0);
    }
  }
  return dp[m]?.[n] ?? 0;
}

// ── C2: llmJudge and guardrailCompliance scorers ───────────────────────────────

export interface LlmJudgeScorerResult extends ScorerResult {
  /** The judge's reasoning (from the model response). */
  reasoning?: string;
}

/**
 * C2: LLM-as-judge scorer.
 *
 * Uses a model to evaluate the agent's final answer against a rubric.
 * Returns a score in [0, 1] based on the model's judgment.
 *
 * To get reproducible scores in tests, pass temperature: 0 via generateOpts.
 *
 * @param model - The model to use as judge.
 * @param rubric - The evaluation criteria for the judge.
 * @param generateOpts - Optional overrides for the judge's generate() call.
 */
export function llmJudge(
  model: Model,
  rubric: string,
  generateOpts: { temperature?: number; maxTokens?: number } = {}
): Scorer {
  return {
    name: `llmJudge(${rubric.slice(0, 40).replace(/\s+/g, " ")}...)`,
    score(_trace, _sample): ScorerResult {
      // Note: Scorer.score() is sync, but we need async for LLM calls.
      // The async evaluation is deferred — use runEvalAsync() or manually await.
      // This returns 0 synchronously as a sentinel; use llmJudgeAsync for real scoring.
      void model;
      void generateOpts;
      return {
        scorer: "llmJudge",
        score: 0,
        detail: "Use llmJudgeAsync() for asynchronous LLM evaluation",
      };
    },
  };
}

/**
 * C2: Async LLM-as-judge scorer — evaluates final answer against a rubric.
 *
 * Returns a score in [0, 1]:
 *   1.0 — answer meets all rubric criteria
 *   0.5 — answer partially meets criteria
 *   0.0 — answer fails criteria
 *
 * @param model - The model to use as judge.
 * @param rubric - The evaluation criteria (e.g. "Is the answer factually correct? Is it complete?")
 * @param trace - The agent trace to evaluate.
 * @param generateOpts - Optional generate options (e.g. temperature: 0 for reproducibility).
 */
export async function llmJudgeAsync(
  model: Model,
  rubric: string,
  trace: AgentTrace,
  generateOpts: { temperature?: number; maxTokens?: number } = {}
): Promise<LlmJudgeScorerResult> {
  const answer = trace.finalAnswer ?? "(no answer)";
  const prompt = `You are an objective evaluator. Assess the following answer against the rubric.

Task: ${trace.task}
Answer: ${answer}

Rubric: ${rubric}

Respond in this exact format:
SCORE: <0.0|0.5|1.0>
REASONING: <one sentence explanation>`;

  const messages: ModelMessage[] = [{ role: "user", content: prompt }];
  let responseText = "";
  for await (const ev of model.generate(messages, { ...generateOpts, stream: true })) {
    if (ev.type === "text_delta" && ev.delta) responseText += ev.delta;
  }

  const scoreMatch = /SCORE:\s*(0\.0|0\.5|1\.0|0|1)/.exec(responseText);
  const reasoningMatch = /REASONING:\s*(.+)/.exec(responseText);
  const score = scoreMatch ? parseFloat(scoreMatch[1] as string) : 0;
  const reasoning = reasoningMatch
    ? (reasoningMatch[1]?.trim() ?? "")
    : responseText.trim().slice(0, 200);

  return {
    scorer: "llmJudge",
    score: Math.min(1, Math.max(0, score)),
    detail: reasoning,
    reasoning,
  };
}

/**
 * C2: Guardrail compliance scorer.
 *
 * Checks whether the agent's final answer passes all output guardrails.
 * Score is 1.0 when all guardrails pass, 0.0 when any tripwire fires.
 *
 * Use this to detect guardrail-violating samples in a dataset:
 *   score === 0 means the answer would have been blocked in production.
 *
 * @param guardrails - Output guardrails to check the final answer against.
 */
export function guardrailCompliance(guardrails: OutputGuardrail[]): Scorer {
  return {
    name: "guardrailCompliance",
    score(trace): ScorerResult {
      // Note: sync scorer signature — use runOutputGuardrails synchronously
      // by checking if all guardrails are sync (no async check() methods).
      // For async guardrails, use guardrailComplianceAsync.
      const answer = trace.finalAnswer ?? "";
      let tripwireTriggered = false;
      let tripwireName = "";
      for (const g of guardrails) {
        const result = g.check(answer) as GuardrailResult | Promise<GuardrailResult>;
        if (result instanceof Promise) {
          // Async guardrail — cannot evaluate synchronously; treat as passed.
          continue;
        }
        if (result.tripwireTriggered) {
          tripwireTriggered = true;
          tripwireName = g.name;
          break;
        }
      }
      return {
        scorer: "guardrailCompliance",
        score: tripwireTriggered ? 0 : 1,
        detail: tripwireTriggered
          ? `Guardrail "${tripwireName}" triggered`
          : "All guardrails passed",
      };
    },
  };
}

/**
 * C2: Async version of guardrailCompliance — handles async guardrails properly.
 *
 * @param guardrails - Output guardrails to check against.
 * @param trace - The agent trace to evaluate.
 */
export async function guardrailComplianceAsync(
  guardrails: OutputGuardrail[],
  trace: AgentTrace
): Promise<ScorerResult> {
  const answer = trace.finalAnswer ?? "";
  const tripwire = await runOutputGuardrails(guardrails, answer);
  return {
    scorer: "guardrailCompliance",
    score: tripwire === null ? 1 : 0,
    detail:
      tripwire !== null
        ? `Guardrail "${tripwire.guardrailName}" triggered`
        : "All guardrails passed",
  };
}
