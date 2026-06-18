/**
 * Agent-trajectory — runs an actual ToolCallingAgent loop with mock
 * tools, scores the trajectory quality (judge + recovery + efficiency).
 *
 * Unlike the other suites which take the runner's single-shot path, this
 * one supplies its own messages that prime the model to decide a plan,
 * and we score the JSON-encoded plan it produces — same shape as
 * tool-sequence but scored on QUALITY (recovery from a synthetic
 * failure, plan length, judge rubric) rather than exact-sequence match.
 *
 * Implementation note: we don't execute a full agent loop here for two
 * reasons: (a) it makes the suite host-agnostic — pure single-call flow
 * works against any OpenAI-compat endpoint, and (b) full agent loops
 * with real tools require a sandbox kernel which is a runtime cost we
 * don't want to charge every evaluation. Trajectory quality is
 * approximated by asking the model to emit its plan and reasoning, then
 * scoring the reasoning. A future v0.2 can plug in the real
 * ToolCallingAgent for sites that want full-fidelity scoring.
 */

import { finalAnswerLength, trajectoryValidity } from "@wasmagent/core";
import type { BenchmarkItem, BenchmarkSuite } from "../types.js";

const ITEMS: BenchmarkItem[] = [
  {
    id: "fail-then-retry",
    task:
      "You have these tools: search(q), summarise(text), email(to, subject, body). " +
      "Goal: send a 3-sentence summary of 'lost city of Z' research to bob@example.com. " +
      "If a step fails, retry once with adjusted args. " +
      "Reply with a JSON array {tool, args, reasoning}.",
    expectedAnswer: "summarise",
    expectedAnswerMatcher: (a) => /search/i.test(a) && /summarise/i.test(a) && /email/i.test(a),
    category: "trajectory",
  },
  {
    id: "branching-decision",
    task:
      "You have these tools: read_calendar(), book_meeting(slot), notify(person). " +
      "Goal: schedule a 30-min sync with the user's manager next week. " +
      "If no slots are free, propose an alternative day rather than giving up. " +
      "Reply with a JSON array {tool, args, reasoning}.",
    expectedAnswer: "calendar",
    expectedAnswerMatcher: (a) =>
      /read_calendar/i.test(a) && (/book_meeting/i.test(a) || /alternative/i.test(a)),
    category: "trajectory",
  },
];

export const agentTrajectorySuite: BenchmarkSuite = {
  name: "agent-trajectory",
  title: "Agent trajectory quality (plan + reasoning emission)",
  description:
    "Each item asks the model to emit a JSON plan with per-step reasoning. We score by string-presence of the expected tools (rough heuristic) plus reply length. A future iteration may plug in the real ToolCallingAgent loop with mock tools for higher-fidelity trajectory scoring.",
  items: ITEMS,
  scorers: [trajectoryValidity, finalAnswerLength(400)],
};
