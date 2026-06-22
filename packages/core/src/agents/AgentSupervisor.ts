/**
 * SI-9 — AgentSupervisor: autonomous control loop.
 *
 * Wraps any agent in a bidirectional observe→decide→act cycle.
 * The supervisor reads the event stream and, after each event,
 * asks a policy function whether to continue, abort, or restart
 * the agent with updated options.
 *
 * Key properties:
 *   - Transparent: supervisor.run() returns the same AsyncGenerator<AgentEvent>
 *     shape as agent.run(); callers that don't care about supervisor_decision
 *     events see a normal event stream.
 *   - Composable: multiple policies can be stacked via composePolicies().
 *   - Safe: maxRuns prevents infinite restart loops.
 *   - Generic: works with any ToolCallingAgent, not just goal-directed ones.
 *
 * Pattern mirrors GoalDirectedAgent's inner loop but is policy-driven
 * rather than hardcoded.
 */

import type { AgentEvent } from "../types/events.js";
import type { ToolCallingAgent, ToolCallingAgentOptions } from "./ToolCallingAgent.js";

// ── Decision model ────────────────────────────────────────────────────────────

export type SupervisorAction =
  | { action: "continue" }
  | { action: "abort"; reason?: string }
  | {
      action: "restart";
      /** Optional reason for the restart (surfaced in supervisor_decision event). */
      reason?: string;
      /** Override the task for the next run. Omit to reuse the current task. */
      task?: string;
      /** Shallow-merge these options into the next agentFactory call. */
      patchOptions?: Partial<ToolCallingAgentOptions>;
    };

// ── Policy interface ──────────────────────────────────────────────────────────

export interface SupervisorPolicy {
  /**
   * Called after every event. Returns a decision:
   *   - "continue"  — pass the event through, keep running
   *   - "abort"     — terminate immediately, emit supervisor_decision
   *   - "restart"   — abandon current run, start a new one (with optional
   *                   task/option overrides), emit supervisor_decision
   *
   * @param event   The event just received from the agent.
   * @param history All events received so far (across all runs, including current).
   * @param runCount Number of completed runs (restarts increment this after the
   *                 inner agent finishes or is abandoned).
   */
  evaluate(
    event: AgentEvent,
    history: AgentEvent[],
    runCount: number
  ): SupervisorAction | Promise<SupervisorAction>;

  /**
   * Maximum number of complete or partial runs (initial + restarts).
   * When exceeded the supervisor stops regardless of policy decisions.
   * Default: 3.
   */
  maxRuns?: number;
}

// ── Supervisor ────────────────────────────────────────────────────────────────

export interface AgentSupervisorOptions {
  /**
   * Factory called once per run. Receives merged patch options accumulated
   * from restart decisions. Must return a freshly constructed agent so
   * each run starts with a clean assembler history.
   */
  agentFactory: (patch?: Partial<ToolCallingAgentOptions>) => ToolCallingAgent;
  policy: SupervisorPolicy;
  /** Initial task string. Restart decisions may override this. */
  task: string;
  /** External abort signal — terminates the supervisor immediately. */
  signal?: AbortSignal;
}

export class AgentSupervisor {
  readonly #factory: AgentSupervisorOptions["agentFactory"];
  readonly #policy: SupervisorPolicy;
  readonly #initialTask: string;
  readonly #signal: AbortSignal | undefined;
  readonly #maxRuns: number;

  constructor(opts: AgentSupervisorOptions) {
    this.#factory = opts.agentFactory;
    this.#policy = opts.policy;
    this.#initialTask = opts.task;
    this.#signal = opts.signal;
    this.#maxRuns = opts.policy.maxRuns ?? 3;
  }

  async *run(): AsyncGenerator<AgentEvent> {
    const history: AgentEvent[] = [];
    let currentTask = this.#initialTask;
    let currentPatch: Partial<ToolCallingAgentOptions> = {};
    let runCount = 0;

    while (runCount < this.#maxRuns) {
      // External abort check before each run.
      if (this.#signal?.aborted) return;

      const agent = this.#factory(currentPatch);
      let shouldRestart = false;
      let restartTask: string | undefined;
      let restartPatch: Partial<ToolCallingAgentOptions> | undefined;

      for await (const event of agent.run(currentTask, null, ...(this.#signal ? [{ signal: this.#signal }] : []))) {
        // External abort check before each event is processed.
        if (this.#signal?.aborted) return;

        history.push(event);
        yield event;

        // Ask the policy what to do.
        const decision = await this.#policy.evaluate(event, history, runCount);

        if (decision.action === "abort") {
          yield this.#mkDecisionEvent(
            event.traceId,
            event.parentTraceId,
            "abort",
            runCount,
            decision.reason
          );
          return;
        }

        if (decision.action === "restart") {
          yield this.#mkDecisionEvent(
            event.traceId,
            event.parentTraceId,
            "restart",
            runCount,
            decision.reason
          );
          shouldRestart = true;
          restartTask = decision.task;
          restartPatch = decision.patchOptions;
          break; // abandon inner run, outer while will restart
        }
      }

      runCount++;

      if (shouldRestart) {
        if (restartTask !== undefined) currentTask = restartTask;
        if (restartPatch) currentPatch = { ...currentPatch, ...restartPatch };
        // Don't increment again — runCount was already incremented above,
        // which is correct: we count each started run (including abandoned ones).
      } else {
        // Inner agent ran to completion naturally — stop.
        break;
      }
    }
  }

  #mkDecisionEvent(
    traceId: string,
    parentTraceId: string | null,
    action: "abort" | "restart",
    runCount: number,
    reason?: string
  ): AgentEvent {
    return {
      traceId,
      parentTraceId,
      channel: "status",
      event: "supervisor_decision",
      data: { action, runCount, ...(reason !== undefined ? { reason } : {}) },
      timestampMs: Date.now(),
    } as AgentEvent;
  }
}

// ── Built-in policies ─────────────────────────────────────────────────────────

/**
 * Restart on error: when an `error` event is received, restart the agent.
 * Stops after `maxRetries` restarts to prevent infinite loops.
 */
export function retryOnErrorPolicy(maxRetries = 2): SupervisorPolicy {
  return {
    maxRuns: maxRetries + 1,
    evaluate(event, _history, runCount) {
      if (event.event === "error") {
        if (runCount < maxRetries) {
          return { action: "restart", reason: `error retry ${runCount + 1}/${maxRetries}` };
        }
        return { action: "abort", reason: "max retries exceeded" };
      }
      return { action: "continue" };
    },
  };
}

/**
 * Token budget guard: abort when cumulative input+output tokens exceed the limit.
 * Reads from `model_done` events which carry token counts.
 */
export function budgetGuardPolicy(maxTokens: number): SupervisorPolicy {
  let totalTokens = 0;
  return {
    evaluate(event) {
      if (event.event === "model_done") {
        const data = event.data as { inputTokens?: number; outputTokens?: number };
        totalTokens += (data.inputTokens ?? 0) + (data.outputTokens ?? 0);
        if (totalTokens >= maxTokens) {
          return {
            action: "abort",
            reason: `token budget exhausted: ${totalTokens} >= ${maxTokens}`,
          };
        }
      }
      return { action: "continue" };
    },
  };
}

/**
 * No-progress guard: abort when the last `k` final_answer events all return
 * the same answer content, indicating the agent is stuck in a loop.
 */
export function noProgressPolicy(k = 2): SupervisorPolicy {
  const answers: string[] = [];
  return {
    evaluate(event) {
      if (event.event === "final_answer") {
        const answer = JSON.stringify((event.data as { answer: unknown }).answer);
        answers.push(answer);
        if (answers.length >= k) {
          const last = answers.slice(-k);
          if (last.every((a) => a === last[0])) {
            return { action: "abort", reason: `no progress: same answer repeated ${k} times` };
          }
        }
      }
      return { action: "continue" };
    },
  };
}

/**
 * Compose multiple policies: evaluate each in order, return the first
 * non-continue decision. If all return continue, return continue.
 */
export function composePolicies(policies: SupervisorPolicy[]): SupervisorPolicy {
  return {
    maxRuns: policies.length === 0 ? 3 : Math.max(...policies.map((p) => p.maxRuns ?? 3)),
    async evaluate(event, history, runCount) {
      for (const policy of policies) {
        const decision = await policy.evaluate(event, history, runCount);
        if (decision.action !== "continue") return decision;
      }
      return { action: "continue" };
    },
  };
}
