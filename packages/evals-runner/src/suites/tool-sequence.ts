/**
 * Tool-sequence — verifies the model emits tool calls in the expected
 * order for a multi-step task. We don't actually execute the tools; the
 * test is whether the model decides on the right sequence.
 *
 * 3-step sequences driven by `expectedTools`, scored by agentkit's
 * `toolCallAccuracy` scorer (LCS-based). Most published function-calling
 * benchmarks are 1-step; in production agents the multi-step planning
 * surface is what fails first, hence this depth.
 *
 * Note: because the runner currently builds a single-call AgentTrace
 * (no agent loop), we score the model's STRUCTURED reply against the
 * expected sequence — the model is asked to emit a JSON list of tool
 * calls. For full agent-loop scoring use the agent-trajectory suite.
 */

import { toolCallAccuracy } from "@agentkit-js/core";
import type { BenchmarkItem, BenchmarkSuite } from "../types.js";

const ITEMS: BenchmarkItem[] = [
  {
    id: "weather-then-pack",
    task:
      "I'm flying to Tokyo tomorrow. Plan: (1) get the Tokyo weather, " +
      "(2) check my packing-list document, (3) book a taxi to the airport. " +
      "Reply with a JSON array of objects {tool, args} naming each tool you'd call in order.",
    expectedAnswer: "[",
    expectedAnswerMatcher: extractToolSequence(["get_weather", "read_document", "book_taxi"]),
    category: "3-step",
  },
  {
    id: "search-summarise-email",
    task:
      "Find the three most recent papers on retrieval-augmented generation, " +
      "summarise them, and email the summary to alice@example.com. " +
      "Reply with a JSON array of objects {tool, args} naming each tool you'd call in order.",
    expectedAnswer: "[",
    expectedAnswerMatcher: extractToolSequence(["search_papers", "summarise", "send_email"]),
    category: "3-step",
  },
  {
    id: "calc-confirm-record",
    task:
      "Compute 7 * 137 + 53, confirm the result with the user, " +
      "then record it in the audit log. " +
      "Reply with a JSON array of objects {tool, args} naming each tool you'd call in order.",
    expectedAnswer: "[",
    expectedAnswerMatcher: extractToolSequence(["calculator", "ask_user", "audit_log"]),
    category: "3-step",
  },
];

/**
 * Build a matcher that parses the model's reply as JSON, extracts the
 * `tool` names, and tests the prefix match against the expected sequence.
 */
function extractToolSequence(expected: string[]): (answer: string) => boolean {
  return (answer: string) => {
    const trimmed = answer.trim();
    // Strip a markdown code fence if present.
    const stripped = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return false;
    }
    if (!Array.isArray(parsed)) return false;
    const got = parsed
      .map((entry) => {
        if (entry && typeof entry === "object" && "tool" in entry) {
          const t = (entry as { tool?: unknown }).tool;
          return typeof t === "string" ? t : null;
        }
        return null;
      })
      .filter((x): x is string => x !== null);
    if (got.length < expected.length) return false;
    // Strict in-order prefix match — extras allowed at the tail (some
    // models add a "verify" / "confirm" step we don't penalise).
    return expected.every((name, i) => got[i] === name);
  };
}

export const toolSequenceSuite: BenchmarkSuite = {
  name: "tool-sequence",
  title: "Tool-call sequence (3-step plans, JSON-replied)",
  description:
    "Each item is a 3-step task. The model replies with a JSON array of {tool, args} pairs. We check the in-order prefix matches the expected sequence — extra trailing steps allowed.",
  items: ITEMS,
  scorers: [toolCallAccuracy],
};
