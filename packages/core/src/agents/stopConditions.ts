/**
 * Composable stop conditions for ToolCallingAgent and CodeAgent.
 *
 * Usage:
 *   new ToolCallingAgent({ stopWhen: [stepCountIs(10), noProgress(3), costBudget(50_000)] })
 *
 * The agent checks all conditions at the start of each step; the first that
 * returns true stops execution with a "stop_condition" error event.
 */

export interface StopConditionContext {
  /** Current step index (1-based). */
  step: number;
  /** Total tokens consumed so far. */
  totalTokens: number;
  /** Last tool call fingerprints (name + JSON-args) from the previous step, for noProgress. */
  lastCallFingerprints: string[];
  /** All call fingerprints recorded in previous steps (for noProgress history). */
  callHistory: string[][];
}

export type StopCondition = (ctx: StopConditionContext) => boolean;

/** Stop after exactly n steps. */
export function stepCountIs(n: number): StopCondition {
  return (ctx) => ctx.step > n;
}

/**
 * Stop when the last k consecutive steps all produced identical tool call
 * fingerprints (same tool names and arguments), indicating no progress.
 * A "step" with no tool calls (i.e. a final-answer step) never triggers this.
 */
export function noProgress(k: number): StopCondition {
  return (ctx) => {
    const history = ctx.callHistory;
    if (history.length < k) return false;
    const last = history.slice(-k);
    if (last.some((fp) => fp.length === 0)) return false; // steps with no calls don't count
    const reference = JSON.stringify(last[0]);
    return last.every((fp) => JSON.stringify(fp) === reference);
  };
}

/** Stop when total tokens consumed exceeds the budget. */
export function costBudget(maxTokens: number): StopCondition {
  return (ctx) => ctx.totalTokens >= maxTokens;
}

/** Build a fingerprint string for a single tool call (name + sorted JSON args). */
export function callFingerprint(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args, Object.keys(args).sort())}`;
}
