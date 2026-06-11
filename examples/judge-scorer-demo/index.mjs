/**
 * A4 — Judge scorer demo: code-based vs LLM-judge side by side.
 *
 * No API key needed — uses a deterministic mock model so the demo runs
 * offline and doubles as a smoke test for the JudgeScorer parser.
 *
 * Three traces are scored with FOUR scorers each:
 *   - exactMatch                   (rule-based)
 *   - finalAnswerLength            (rule-based)
 *   - trajectoryQualityJudge       (LLM-judge, built-in)
 *   - answerCompletenessJudge      (LLM-judge, built-in)
 *
 * Prints a markdown table comparing rule-based vs judge-based verdicts —
 * which is exactly the gap Mastra's 2026 Studio "code vs judge" split
 * surfaces in their dashboard.
 */
import {
  exactMatch,
  finalAnswerLength,
  answerCompletenessJudge,
  runJudgeScorer,
  trajectoryQualityJudge,
} from "@agentkit-js/core";

// ── Mock judge model ─────────────────────────────────────────────────────────
// Returns canned scores keyed by the trace task so we can demo nuance: an
// answer that exactly matches the expected string still might score POORLY
// on actionability (intentionally) — the kind of finding rule-based
// scorers miss.
function mockJudge(reply) {
  return {
    providerId: "mock/judge",
    async *generate() {
      yield { type: "text_delta", delta: reply };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

// Pre-generated SCORES blocks for each (trace, judge) pairing.
const completenessReplies = {
  hello: `SCORES
coverage: 10
actionability: 10
honesty: 10

REASONING
Direct, clear, complete.`,
  thirty: `SCORES
coverage: 10
actionability: 10
honesty: 10

REASONING
The math is right and stated plainly.`,
  pizza: `SCORES
coverage: 4 (skipped half the question)
actionability: 3 (no concrete next step)
honesty: 6

REASONING
The answer technically matched the keyword but skipped the recipe portion.`,
};

const trajectoryReplies = {
  hello: `SCORES
efficiency: 10
tool-fit: 10
self-correction: 10`,
  thirty: `SCORES
efficiency: 9
tool-fit: 9
self-correction: 8`,
  pizza: `SCORES
efficiency: 6
tool-fit: 7
self-correction: 4`,
};

// ── Synthetic traces ─────────────────────────────────────────────────────────
const traces = [
  {
    id: "hello",
    task: "Say hello",
    sample: { id: "hello", task: "Say hello", expectedAnswer: "hello" },
    trace: {
      traceId: "t1", task: "Say hello", events: [],
      toolCalls: [], toolResults: [], finalAnswer: "hello",
    },
  },
  {
    id: "thirty",
    task: "What is 6 * 5?",
    sample: { id: "thirty", task: "What is 6 * 5?", expectedAnswer: "30" },
    trace: {
      traceId: "t2", task: "What is 6 * 5?", events: [],
      toolCalls: [], toolResults: [], finalAnswer: "30",
    },
  },
  {
    id: "pizza",
    task: "Write a 3-step recipe for margherita pizza, then list the calories per serving.",
    sample: {
      id: "pizza",
      task: "Write a 3-step recipe for margherita pizza, then list the calories per serving.",
      expectedAnswer: "pizza",
    },
    trace: {
      traceId: "t3",
      task: "Write a 3-step recipe for margherita pizza, then list the calories per serving.",
      events: [],
      toolCalls: [{ toolName: "search", args: { q: "pizza" }, callId: "c1" }],
      toolResults: [{ toolName: "search", output: "...results...", callId: "c1", isError: false }],
      // Note: contains the expected keyword but skips the calorie part.
      finalAnswer: "pizza is delicious — recipe forthcoming.",
    },
  },
];

// ── Score each trace with all four scorers ──────────────────────────────────
async function scoreTrace(t) {
  const exact = exactMatch.score(t.trace, t.sample);
  const len = finalAnswerLength(80).score(t.trace, t.sample);

  const trajectory = await runJudgeScorer(
    t.trace,
    trajectoryQualityJudge(mockJudge(trajectoryReplies[t.id])),
  );
  const completeness = await runJudgeScorer(
    t.trace,
    answerCompletenessJudge(mockJudge(completenessReplies[t.id])),
  );

  return {
    id: t.id,
    task: t.task.slice(0, 50),
    exactMatch: exact.score,
    finalAnswerLength: len.score,
    trajectoryQuality: trajectory.score,
    answerCompleteness: completeness.score,
    completenessBreakdown: completeness.breakdown,
  };
}

const results = [];
for (const t of traces) {
  results.push(await scoreTrace(t));
}

// ── Markdown table ──────────────────────────────────────────────────────────
console.log("# Code-based vs LLM-judge scorers\n");
console.log("| Trace | exactMatch | finalAnswerLength | trajectoryQuality (judge) | answerCompleteness (judge) |");
console.log("|---|---:|---:|---:|---:|");
for (const r of results) {
  console.log(
    `| ${r.id} (\`${r.task}…\`) ` +
      `| ${r.exactMatch.toFixed(2)} ` +
      `| ${r.finalAnswerLength.toFixed(2)} ` +
      `| ${r.trajectoryQuality.toFixed(2)} ` +
      `| ${r.answerCompleteness.toFixed(2)} |`,
  );
}

console.log("\n## Why pizza diverges between rule-based and judge scorers");
const pizza = results.find((r) => r.id === "pizza");
console.log(`\`exactMatch\` is strict equality — pizza scored ${pizza.exactMatch.toFixed(2)} because the answer`);
console.log("contains the keyword but isn't byte-equal. \\`finalAnswerLength\\` only measures length.");
console.log("Both miss the actual problem the LLM-judge catches:");
for (const b of pizza.completenessBreakdown) {
  console.log(`- **${b.criterionId}**: ${b.raw}/10 — ${b.reasoning}`);
}
console.log("\nThis is the gap LLM-judges close. Pair them with rule-based scorers,");
console.log("don't replace them — the rule-based ones are cheap, deterministic, and");
console.log("anchor the dashboard. Judges add nuance the rules can't pattern-match.");
