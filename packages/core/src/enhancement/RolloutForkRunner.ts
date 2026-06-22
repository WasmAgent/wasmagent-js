/**
 * RolloutForkRunner — forks a complete ToolCallingAgent run into N independent
 * branches and collects full AgentEvent trajectories for RLAIF training data.
 *
 * Unlike ParallelForkJoinRunner (which forks a single model.generate() call),
 * this class forks the entire agent loop — each branch runs all its tool calls
 * and produces a complete trajectory before yielding.
 *
 * Each branch is independent: separate agent instance, separate AbortSignal,
 * optional per-branch temperature. Branches run concurrently up to the
 * concurrency cap; the runner yields completed branch results as they finish.
 *
 * tool_result outputs in the JSONL record are passed through summarizeToolOutput()
 * before persistence so that training data and inference context are identical.
 */

import type { ToolCallingAgentOptions } from "../agents/ToolCallingAgent.js";
import { ToolCallingAgent } from "../agents/ToolCallingAgent.js";
import { summarizeToolOutput } from "../agents/ToolOutputSummarizer.js";
import type { AgentEvent } from "../types/events.js";
import { randomUUID } from "../util/runtime.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface RolloutBranchResult {
  rolloutId: string;
  task: string;
  branchIndex: number;
  temperature: number;
  sessionId: string;
  /** Full event stream from run_start to final_answer (or error). */
  trajectory: AgentEvent[];
  /** tool_call + tool_result events only, with outputs summarized. */
  toolCallSequence: AgentEvent[];
  /** Text of the final_answer event, or empty string on error/abort. */
  finalAnswer: string;
  /** null means not yet filled; filled externally by BuildPassesVerifier adapter. */
  buildResult: null;
}

export interface RolloutForkRunnerOptions {
  /** Number of independent branches to run. Default 5. */
  branches?: number;
  /** Max branches running concurrently. Default: branches. */
  concurrency?: number;
  /**
   * Temperature for each branch. If shorter than branches, last value is repeated.
   * Default: all branches use 0.7.
   */
  temperaturePerBranch?: number[];
  /**
   * Session ID prefix. Each branch gets `<prefix>-b<index>-<uuid>`.
   * Default: "rollout".
   */
  sessionIdPrefix?: string;
  /**
   * Optional per-branch model factory. When provided, each branch gets a fresh
   * model instance from the factory instead of sharing `agentOpts.model`.
   * Use this when the model has per-instance state (e.g. test mocks with call counters).
   * In production, stateless model adapters don't need this.
   */
  modelFactory?: () => ToolCallingAgentOptions["model"];
}

// ── Runner ────────────────────────────────────────────────────────────────────

export class RolloutForkRunner {
  readonly #branches: number;
  readonly #concurrency: number;
  readonly #temperaturePerBranch: number[];
  readonly #sessionIdPrefix: string;
  readonly #modelFactory: (() => ToolCallingAgentOptions["model"]) | null;

  constructor(opts: RolloutForkRunnerOptions = {}) {
    this.#branches = Math.max(1, opts.branches ?? 5);
    this.#concurrency = Math.max(1, opts.concurrency ?? this.#branches);
    this.#temperaturePerBranch = opts.temperaturePerBranch ?? [];
    this.#sessionIdPrefix = opts.sessionIdPrefix ?? "rollout";
    this.#modelFactory = opts.modelFactory ?? null;
  }

  /**
   * Fork the agent across N branches. Each branch runs a fresh ToolCallingAgent
   * to completion and yields its result. Branches yield as they complete — faster
   * branches yield first.
   *
   * @param agentOpts  Base ToolCallingAgent options shared by all branches.
   *                   Temperature is overridden per-branch from temperaturePerBranch.
   * @param task       The user task string passed to each agent run.
   * @param rolloutId  Optional stable ID for the whole rollout. Auto-generated if omitted.
   */
  async *run(
    agentOpts: ToolCallingAgentOptions,
    task: string,
    rolloutId?: string
  ): AsyncGenerator<RolloutBranchResult> {
    const rid = rolloutId ?? randomUUID();
    const n = this.#branches;
    const limit = Math.min(this.#concurrency, n);

    // Completed results queue + signalling
    const results: RolloutBranchResult[] = [];
    let done = 0;
    let resolveNext: (() => void) | null = null;

    const signal = () => {
      const r = resolveNext;
      resolveNext = null;
      r?.();
    };

    const runBranch = async (branchIndex: number): Promise<void> => {
      const temperature =
        this.#temperaturePerBranch[branchIndex] ??
        this.#temperaturePerBranch[this.#temperaturePerBranch.length - 1] ??
        0.7;

      const sessionId = `${this.#sessionIdPrefix}-b${branchIndex}-${randomUUID()}`;

      // Per-branch model: use factory if provided, else wrap shared model with temperature.
      const baseModel = this.#modelFactory ? this.#modelFactory() : agentOpts.model;
      const model = wrapTemperature(baseModel, temperature);
      const agent = new ToolCallingAgent({ ...agentOpts, model });

      const trajectory: AgentEvent[] = [];
      let finalAnswer = "";

      try {
        for await (const event of agent.run(task)) {
          trajectory.push(event);
          if (event.event === "final_answer") {
            const data = event.data as { answer: unknown };
            finalAnswer =
              typeof data.answer === "string" ? data.answer : JSON.stringify(data.answer);
          }
        }
      } catch {
        // Branch failed — trajectory contains events up to the error; finalAnswer stays ""
      }

      const toolCallSequence = buildToolCallSequence(trajectory);

      results.push({
        rolloutId: rid,
        task,
        branchIndex,
        temperature,
        sessionId,
        trajectory,
        toolCallSequence,
        finalAnswer,
        buildResult: null,
      });
      done++;
      signal();
    };

    // Launch up to `limit` workers; each worker processes branch indices spaced by limit.
    const workers: Promise<void>[] = [];
    for (let w = 0; w < limit && w < n; w++) {
      workers.push(
        (async (start: number) => {
          for (let idx = start; idx < n; idx += limit) {
            await runBranch(idx);
          }
        })(w)
      );
    }

    // Drain: yield each result as it arrives; wait for all workers to finish.
    let yielded = 0;
    const allDone = Promise.allSettled(workers).then(() => signal());

    while (yielded < n) {
      // Yield any results already buffered
      while (results.length > yielded) {
        const next = results[yielded++];
        if (next) yield next;
      }
      if (yielded >= n) break;
      // Wait for the next branch to finish
      await new Promise<void>((resolve) => {
        if (done > yielded) {
          resolve();
        } else {
          resolveNext = resolve;
        }
      });
    }

    await allDone;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract tool_call and tool_result events from a trajectory,
 * summarizing tool_result outputs for JSONL persistence.
 */
function buildToolCallSequence(trajectory: AgentEvent[]): AgentEvent[] {
  return trajectory
    .filter((e) => e.event === "tool_call" || e.event === "tool_result")
    .map((e) => {
      if (e.event !== "tool_result") return e;
      const data = e.data as { output?: unknown };
      if (typeof data.output !== "string") return e;
      const summarized = summarizeToolOutput(data.output);
      if (summarized === data.output) return e;
      // Spread preserves all AgentEvent fields; cast back to AgentEvent since
      // we only mutate the output field which stays the same type (string).
      return { ...e, data: { ...data, output: summarized } } as AgentEvent;
    });
}

/**
 * Wrap a Model to override the temperature on every generate() call.
 * This is a minimal shim — all other options from the caller are preserved.
 */
function wrapTemperature(
  model: ToolCallingAgentOptions["model"],
  temperature: number
): ToolCallingAgentOptions["model"] {
  return {
    ...model,
    generate: (messages, opts) => model.generate(messages, { ...opts, temperature }),
  };
}
