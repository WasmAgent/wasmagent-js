/**
 * @wasmagent/eliza-rollout-plugin
 *
 * elizaOS community plugin that captures agent action runs as rollout-wire/v1
 * training records (DPO/PPO-ready JSONL) for fine-tuning via evomerge.
 *
 * elizaOS already provides OS-process-level sandbox isolation via Bun Workers
 * and RemotePluginPermissions. This plugin does NOT add another sandbox layer.
 * Its sole purpose is the training data loop: capture → rank → export JSONL.
 *
 * elizaOS integration path:
 *   - elizaOS plugin registry (community plugin, not a core dependency)
 *   - https://github.com/elizaOS/eliza/pull/9235
 *
 * Usage (zero-config):
 *
 *   import { createRolloutPlugin } from "@wasmagent/eliza-rollout-plugin";
 *
 *   // elizaOS agent config
 *   export default {
 *     plugins: [createRolloutPlugin()],
 *   };
 *
 * Usage (with evomerge HTTP sink):
 *
 *   export default {
 *     plugins: [createRolloutPlugin({
 *       sink: { type: "http", url: "https://evomerge.example.com/ingest" },
 *     })],
 *   };
 *
 * Architecture note:
 * elizaOS actions are the "action handler" layer — they receive a runtime,
 * message, state, and options, then call model and tools. This plugin wraps
 * each registered action's handler to intercept the prompt/completion pair
 * after the action completes. It does not fork branches (no RolloutForkRunner)
 * by default; branching is opt-in via `branches > 1` and requires the action
 * handler to be invokable multiple times independently (most elizaOS actions
 * are pure functions of their inputs, so this is safe in practice).
 */

import type {
  DpoRecord,
  PpoRecord,
  RankedBranch,
  RolloutBranchResult,
  RolloutRecord,
} from "@wasmagent/core/beta";
import { RolloutRanker, toDpoRecord, toJsonl, toPpoRecords } from "@wasmagent/core/beta";

// ── elizaOS structural types ─────────────────────────────────────────────────
//
// We define the elizaOS contract structurally rather than importing from
// @elizaos/core directly. This avoids a hard build-time dependency — the
// plugin works with any elizaOS major version that satisfies this shape.

export interface ElizaRuntime {
  agentId: string;
  character?: { name?: string };
}

export interface ElizaMessage {
  content: { text?: string };
  userId?: string;
}

export type ElizaState = Record<string, unknown>;

export type ElizaCallback = (response: { text: string }) => Promise<void>;

export type ElizaActionHandler = (
  runtime: ElizaRuntime,
  message: ElizaMessage,
  state: ElizaState | undefined,
  options: Record<string, unknown> | undefined,
  callback: ElizaCallback | undefined
) => Promise<unknown>;

export interface ElizaAction {
  name: string;
  description?: string;
  handler: ElizaActionHandler;
  [key: string]: unknown;
}

export interface ElizaPlugin {
  name: string;
  description?: string;
  actions?: ElizaAction[];
  [key: string]: unknown;
}

// ── Sink types ────────────────────────────────────────────────────────────────

export interface FileSinkOptions {
  type: "file";
  /** Directory path. Created if absent. Default: "./rollouts" */
  dir?: string;
}

export interface HttpSinkOptions {
  type: "http";
  /** POST target. Receives a JSON body: { records: DpoRecord[] | PpoRecord[] } */
  url: string;
  /** Extra headers (e.g. Authorization). */
  headers?: Record<string, string>;
}

export interface ConsoleSinkOptions {
  type: "console";
}

export type RolloutSink = FileSinkOptions | HttpSinkOptions | ConsoleSinkOptions;

// ── Plugin options ────────────────────────────────────────────────────────────

export interface RolloutPluginOptions {
  /**
   * Where to write the exported JSONL records.
   * Default: { type: "file", dir: "./rollouts" }
   */
  sink?: RolloutSink;

  /**
   * Export format.
   * - "dpo": one chosen/rejected pair per action run (requires branches >= 2).
   * - "ppo": one record per branch with a reward signal.
   * - "both": write both formats.
   * Default: "ppo"
   */
  format?: "dpo" | "ppo" | "both";

  /**
   * Number of independent branches to run per action invocation.
   * 1 = single-run mode (no branching, no ranking, reward = heuristic score).
   * >= 2 = fork mode (enables DPO export).
   * Default: 1
   */
  branches?: number;

  /**
   * Heuristic scorer for single-run / PPO mode.
   * Receives the final answer text; returns a score in [0, 1].
   * Default: length-normalised non-empty answer heuristic.
   */
  scorer?: (answer: string, task: string) => number;

  /**
   * Action names to instrument. Undefined = instrument all actions.
   */
  includeActions?: string[];
}

// ── Default scorer ────────────────────────────────────────────────────────────

function defaultScorer(answer: string): number {
  if (!answer.trim()) return 0;
  // Longer, substantive answers score higher; cap at 1.0.
  const wordCount = answer.split(/\s+/).filter(Boolean).length;
  return Math.min(wordCount / 50, 1.0);
}

// ── Sink implementations ──────────────────────────────────────────────────────

async function writeToSink(
  sink: RolloutSink,
  records: (DpoRecord | PpoRecord)[],
  format: string,
  timestamp: number
): Promise<void> {
  if (records.length === 0) return;
  const jsonl = toJsonl(records);

  if (sink.type === "console") {
    process.stdout.write(`[wasmagent-rollout] ${format} records:\n${jsonl}\n`);
    return;
  }

  if (sink.type === "file") {
    const { mkdir, appendFile } = await import("node:fs/promises");
    const dir = sink.dir ?? "./rollouts";
    await mkdir(dir, { recursive: true });
    const date = new Date(timestamp).toISOString().slice(0, 10);
    const file = `${dir}/${format}-${date}.jsonl`;
    await appendFile(file, jsonl + "\n", "utf8");
    return;
  }

  if (sink.type === "http") {
    await fetch(sink.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sink.headers ?? {}),
      },
      body: JSON.stringify({ records }),
    });
  }
}

// ── Action wrapper ────────────────────────────────────────────────────────────

function wrapAction(action: ElizaAction, opts: Required<RolloutPluginOptions>): ElizaAction {
  const original = action.handler;

  const wrapped: ElizaActionHandler = async (runtime, message, state, options, callback) => {
    const task = message.content.text ?? action.name;
    const now = Date.now();

    if (opts.branches <= 1) {
      // Single-run mode: run once, score heuristically, export PPO record.
      let finalAnswer = "";
      const capturingCallback: ElizaCallback = async (response) => {
        finalAnswer = response.text;
        await callback?.(response);
      };

      const result = await original(runtime, message, state, options, capturingCallback);
      if (!finalAnswer && typeof result === "string") finalAnswer = result;

      const score = opts.scorer(finalAnswer, task);
      const ppoRecord: PpoRecord = {
        prompt: task,
        completion: finalAnswer,
        reward: score,
        tool_call_sequence: [],
        provenance: {
          source: "wasmagent-rollout",
          rollout_id: `${runtime.agentId}-${now}`,
          branch_index: 0,
          objective_score: score >= 0.5 ? 1 : 0,
          exported_at_ms: now,
          n_gram_hash: task.slice(0, 16),
        },
      };

      await writeToSink(opts.sink, [ppoRecord], "ppo", now).catch(() => {});
      return result;
    }

    // Fork mode: run branches concurrently, rank, export DPO/PPO.
    const branchResults: RolloutBranchResult[] = [];
    await Promise.all(
      Array.from({ length: opts.branches }, async (_, i) => {
        let answer = "";
        const cb: ElizaCallback = async (r) => {
          answer = r.text;
          if (i === 0) await callback?.(r);
        };
        try {
          const r = await original(runtime, message, state, options, cb);
          if (!answer && typeof r === "string") answer = r;
        } catch {
          // Branch failure is non-fatal; it contributes a low-score record.
        }
        branchResults.push({
          rolloutId: `${runtime.agentId}-${now}`,
          task,
          branchIndex: i,
          temperature: 0.7,
          seed: null,
          sessionId: `${runtime.agentId}`,
          trajectory: [],
          toolCallSequence: [],
          finalAnswer: answer,
          buildResult: null,
        });
      })
    );

    const rolloutRecords: RolloutRecord[] = branchResults.map((b) => ({
      rolloutId: b.rolloutId,
      branchIndex: b.branchIndex,
      finalAnswer: b.finalAnswer,
      objectiveScore: (opts.scorer(b.finalAnswer, task) >= 0.5 ? 1 : 0) as 0 | 1,
      task,
    }));

    const ranker = new RolloutRanker();
    const { ranked } = await ranker.rank(rolloutRecords);

    const writes: Promise<void>[] = [];

    if (opts.format === "ppo" || opts.format === "both") {
      const ppo = toPpoRecords(branchResults, ranked as RankedBranch[], now);
      writes.push(writeToSink(opts.sink, ppo, "ppo", now).catch(() => {}));
    }

    if (opts.format === "dpo" || opts.format === "both") {
      const dpo = toDpoRecord(branchResults, ranked as RankedBranch[], now);
      if (dpo) writes.push(writeToSink(opts.sink, [dpo], "dpo", now).catch(() => {}));
    }

    await Promise.all(writes);

    // Return the top-ranked branch's answer.
    const topBranch = branchResults.find((b) => b.branchIndex === ranked[0]?.branchIndex);
    return topBranch?.finalAnswer ?? "";
  };

  return { ...action, handler: wrapped };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a WasmAgent rollout export plugin for elizaOS.
 *
 * The plugin wraps each registered action's handler to:
 * 1. Capture the prompt/completion pair after the action runs.
 * 2. Score and rank completions (single-run: heuristic; multi-branch: RolloutRanker).
 * 3. Emit rollout-wire/v1 JSONL records to the configured sink.
 *
 * This adds no sandbox layer and requires no permission configuration —
 * elizaOS's native Bun Worker isolation already handles that.
 */
export function createRolloutPlugin(opts: RolloutPluginOptions = {}): ElizaPlugin {
  const resolved: Required<RolloutPluginOptions> = {
    sink: opts.sink ?? { type: "file", dir: "./rollouts" },
    format: opts.format ?? "ppo",
    branches: opts.branches ?? 1,
    scorer: opts.scorer ?? defaultScorer,
    includeActions: opts.includeActions ?? [],
  };

  return {
    name: "@wasmagent/eliza-rollout-plugin",
    description:
      "Captures elizaOS action runs as rollout-wire/v1 training records (DPO/PPO JSONL) for fine-tuning",

    // elizaOS calls this hook when registering the plugin.
    // We return a proxy that wraps any actions the host registers.
    actions: [],

    // elizaOS plugin lifecycle: called after the plugin is registered.
    // We monkey-patch runtime.registerAction to intercept action registration.
    init(params: { runtime: ElizaRuntime & { registerAction?: (a: ElizaAction) => void } }) {
      const { runtime } = params;
      if (typeof runtime.registerAction !== "function") return;

      const originalRegister = runtime.registerAction.bind(runtime);
      runtime.registerAction = (action: ElizaAction) => {
        const shouldWrap =
          resolved.includeActions.length === 0 || resolved.includeActions.includes(action.name);

        originalRegister(shouldWrap ? wrapAction(action, resolved) : action);
      };
    },
  };
}

export type { DpoRecord, PpoRecord };
