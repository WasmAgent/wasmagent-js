/**
 * RecoveryScorer — measures how well the agent recovered from
 * tool failures.
 *
 * Looks at the trace's tool_result events. A tool failure (isError=true)
 * followed by a successful tool call (any subsequent tool_result with
 * isError=false) counts as a "recovery". The score is recoveries /
 * total failures, in [0, 1].
 *
 * Edge cases:
 * - No tool failures → score = 1.0 (vacuous success)
 * - Failures but no subsequent successes → score = 0
 * - Mixed → fraction recovered
 */

import type { AgentTrace, Scorer, ScorerResult } from "./index.js";

export function recoveryScorer(): Scorer {
  return {
    name: "recovery",
    score(trace: AgentTrace): ScorerResult {
      const results = trace.toolResults;
      const failures = results.filter((r) => r.isError);
      if (failures.length === 0) {
        return { scorer: "recovery", score: 1, detail: "no failures to recover from" };
      }

      let recovered = 0;
      for (const fail of failures) {
        const failIdx = results.findIndex((r) => r.callId === fail.callId);
        if (failIdx < 0) continue;
        // A subsequent tool_result with no error counts as recovery.
        const nextSuccess = results.slice(failIdx + 1).find((r) => !r.isError);
        if (nextSuccess) recovered++;
      }

      const score = recovered / failures.length;
      return {
        scorer: "recovery",
        score,
        detail: `recovered=${recovered}/${failures.length} failures`,
      };
    },
  };
}
