/**
 * Minimal evals framework (B1).
 *
 * Provides a Scorer interface, built-in scorers, a trace collector,
 * and runEval() for evaluating agent runs against a dataset.
 */

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

export function collectTrace(
  task: string,
  events: AgentEvent[]
): AgentTrace {
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
      const d = (ev as { data: { toolName: string; args: Record<string, unknown>; callId: string } }).data;
      toolCalls.push({ toolName: d.toolName, args: d.args, callId: d.callId });
    }
    if (ev.event === "tool_result" && ev.channel === "tool") {
      const d = (ev as { data: { toolName: string; output: unknown; callId: string; error?: unknown } }).data;
      toolResults.push({ toolName: d.toolName, output: d.output, callId: d.callId, isError: !!d.error });
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
    if (callIds.size === 0) return { scorer: "trajectoryValidity", score: 1, detail: "no tool calls" };
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
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}
