/**
 * GoalAgent — Loop Engineering 的 declarative `/goal` 原语（agentkit-js 形态）。
 *
 * 核心抽象：用户声明一个**可机器判定**的完成条件 `verify()`，agent
 * 反复迭代直到 verify 返回 true 或撞到预算/步数上限。这是
 * Claude Code v2.1.139+ 的 `/goal` 原语在 SDK 层的等价物，但
 * agentkit 的实现刻意保持库性质（不绑 cron、不绑 worktree
 * 自动管理、不假设运行环境是 CLI）——把那些做成上层应用的事。
 *
 * ## 与 ToolCallingAgent 的关系
 *
 * GoalAgent 不重写 agent loop，它是 ToolCallingAgent 的 **声明式包装**：
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ GoalAgent.run(goal)                                       │
 *   │                                                            │
 *   │   loop until verify() or budget exhausted:                │
 *   │     ┌──────────────────────────────────────────────────┐  │
 *   │     │ ToolCallingAgent.run(goal.describe + state hint)  │  │
 *   │     │   — uses your tools, your model, your guardrails  │  │
 *   │     └──────────────────────────────────────────────────┘  │
 *   │     check verify()                                         │
 *   │     if !verified: feed the (still-failing) state back as  │
 *   │       the next iteration's input                          │
 *   │                                                            │
 *   └─────────────────────────────────────────────────────────┘
 *
 * 关键不变量：
 *   - **verify() 是确定性、机器可判定的断言**（典型形态：跑测试看 exit
 *     code、检查文件存在、grep 输出）。verify 中**不要**调 LLM
 *     做模糊判断——那会让 reward hacking 立即出现（详见
 *     `docs/guides/loop-engineering.md` 的 IPT 段落）。
 *   - **每轮 ToolCallingAgent 是新一轮**：history 从 0 开始，不累积。
 *     这是为了避免上一轮 attempt 的失败信息污染下一轮决策（observed
 *     in Run H: 累积 history 让小模型 overfit "我刚才说我做完了" 的
 *     虚假状态）。如果你需要跨轮 memory，自己管理 `assembler` /
 *     `MemoryBlockSet` 并通过 ctx 注入。
 *   - **L1/L2/L3 分层是用户的事**：GoalAgent 只接受**一个** model；
 *     如果你想分层，把不同层各自构造成 GoalAgent / ToolCallingAgent
 *     再组合（比如 L3 协调器调 L2 执行器，L2 执行器内部用 L1
 *     verify()）。这是刻意的——agentkit 不做 router，你做。
 *
 * ## 与 Loop Engineering 文献的对应
 *
 * 对应 Addy Osmani《Loop Engineering》的 6 组件：
 *   - Automations:        不在 GoalAgent 范围（cron/触发器留给上层）
 *   - Worktrees:          通过 `BranchableWorkspace` (F3) 做隔离，不是这里
 *   - Skills:             通过 `Skill` (S3) 注入到 tools，不是这里
 *   - Plugins/Connectors: MCP 工具，不是这里
 *   - Sub-agents:         通过 `Subagent` + `asTool()` 组合，不是这里
 *   - Memory/State:       通过 `Checkpointer` + `StructuredMemory`，不是这里
 *
 * GoalAgent 只是把"goal-driven loop 自身"做成 first-class 抽象——
 * 让用户写 `await goalAgent.run(goal)` 而不是手写 while 循环。
 */

import type { Model } from "../models/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentEvent } from "../types/events.js";
import { ToolCallingAgent } from "./ToolCallingAgent.js";

/**
 * Goal — declarative completion condition that the agent loops toward.
 *
 * `describe`: natural-language goal text fed as the first user prompt
 *     (e.g. "Make all unit tests in test/auth pass"). Should NOT be
 *     ambiguous — phrase it as something the verify() can actually
 *     check.
 *
 * `verify`: deterministic check fired AFTER each iteration. Return
 *     `{ ok: true }` to terminate as success. Return
 *     `{ ok: false, hint }` to continue — the optional `hint` will
 *     be appended to the next iteration's prompt as feedback ("the
 *     verifier reports: <hint>"). Common implementations:
 *       - run a test command via `child_process.exec`, return
 *         ok: process.exitCode === 0
 *       - read a file and check a substring is present
 *       - grep CI output for the absence of error markers
 *
 *     IMPORTANT: do NOT use an LLM here. The verifier is the
 *     externally-trusted measurement; if it's another LLM, you've
 *     re-introduced reward hacking (see RHB / RLVR / Rebound papers
 *     cited in `docs/guides/loop-engineering.md`). Use a real check.
 */
export interface Goal {
  describe: string;
  verify: () => Promise<{ ok: true } | { ok: false; hint?: string }>;
}

export interface GoalAgentOptions {
  model: Model;
  tools: ToolDefinition[];
  /**
   * Hard upper bound on goal-loop iterations. Each iteration is one
   * full ToolCallingAgent.run() invocation, which itself has a
   * `maxSteps` cap. Total work ≤ maxIterations × maxStepsPerIteration.
   * Default: 5 — the Loop Engineering literature converges on 3-7
   * as the sweet spot before reward-hacking + cost overrun dominate.
   */
  maxIterations?: number;
  /**
   * Per-iteration ToolCallingAgent step cap. Default 15.
   */
  maxStepsPerIteration?: number;
  /**
   * Token budget across the WHOLE goal loop (sum of all iterations).
   * When exceeded, the loop terminates with `outcome: "budget"`.
   * Default: undefined (no budget cap; rely on maxIterations).
   */
  tokenBudget?: number;
  /**
   * Optional system-prompt addendum baked into every iteration. Useful
   * for state hints, project conventions, or "you are L1/L2/L3" role
   * differentiation when this GoalAgent is part of a tiered stack.
   */
  systemPromptAddendum?: string;
  /**
   * 2026-06-18 (axis 9, L2). Forwarded verbatim to the inner
   * `ToolCallingAgent` — see its `enableToolSynthesis` doc.
   */
  enableToolSynthesis?: boolean | { codeToolName: string };
  /**
   * 2026-06-18 (axis 9, stop-loss). Maximum consecutive iterations
   * with byte-identical verifier hints before the loop bails out
   * with `outcome: "exhausted"`. Default 2 — tight enough that a
   * truly stuck agent doesn't burn more than ~2× the tokens of a
   * single failed iteration.
   *
   * Set higher when verifier hints are noisy and identical-by-chance
   * is plausible; set to a very high number to disable. The default
   * preserves existing semantics for tasks that DO progress (a hint
   * change resets the streak), so this is a stop-loss not a gate.
   */
  maxNoProgressIterations?: number;
}

/**
 * Outcome of a GoalAgent.run() loop.
 *
 *   "verified":  verify() returned ok:true at some iteration; the goal
 *                is met. `iterationCount` tells you how many tries.
 *   "exhausted": maxIterations reached without verify() ever passing.
 *   "budget":    tokenBudget exceeded mid-loop.
 *   "error":     an iteration threw; the final attempt's error is in
 *                `lastError`. Loop bails on first throw rather than
 *                retrying — exceptions are infrastructure failures,
 *                not goal-state failures.
 */
export type GoalOutcome = "verified" | "exhausted" | "budget" | "error";

export interface GoalRunResult {
  outcome: GoalOutcome;
  iterationCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** verify()'s last hint, if any. Useful for logs / human handoff. */
  lastHint?: string;
  lastError?: string;
}

/**
 * Run a declarative goal-driven loop.
 *
 * Yields `AgentEvent`s from each underlying ToolCallingAgent
 * iteration (so consumers can stream them to a UI / DevTools log)
 * plus two synthetic events:
 *
 *   - `goal_iteration_start` — before each new iteration; data
 *     contains `{ iteration, hint? }` (hint from previous verify
 *     failure, if any)
 *   - `goal_done` — terminal; data contains the full `GoalRunResult`
 *
 * The two synthetic events use channel: "status" and event names
 * with `goal_` prefix to avoid collision with the standard
 * AgentEvent vocabulary.
 */
export class GoalAgent {
  readonly #model: Model;
  readonly #tools: ToolDefinition[];
  readonly #maxIterations: number;
  readonly #maxStepsPerIteration: number;
  readonly #tokenBudget: number | undefined;
  readonly #systemPromptAddendum: string | undefined;
  readonly #enableToolSynthesis: boolean | { codeToolName: string } | undefined;
  readonly #maxNoProgressIterations: number;

  constructor(opts: GoalAgentOptions) {
    this.#model = opts.model;
    this.#tools = opts.tools;
    this.#maxIterations = opts.maxIterations ?? 5;
    this.#maxStepsPerIteration = opts.maxStepsPerIteration ?? 15;
    this.#tokenBudget = opts.tokenBudget;
    this.#systemPromptAddendum = opts.systemPromptAddendum;
    this.#enableToolSynthesis = opts.enableToolSynthesis;
    // Default disabled at this layer (preserves pre-2026-06-18 behaviour
    // for callers that drive GoalAgent directly). The high-level
    // GoalDirectedAgent overrides this default to 2 — see its constructor.
    this.#maxNoProgressIterations = opts.maxNoProgressIterations ?? Number.POSITIVE_INFINITY;
  }

  async *run(goal: Goal, parentTraceId: string | null = null): AsyncGenerator<AgentEvent> {
    let iteration = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let lastHint: string | undefined;
    let lastError: string | undefined;
    let outcome: GoalOutcome = "exhausted";
    // 2026-06-18 (axis 9, stop-loss): count consecutive iterations
    // where the verifier returned the byte-identical hint as last time.
    // When this hits #maxNoProgressIterations the loop bails early.
    let noProgressStreak = 0;

    // Pre-loop check: sometimes the goal is already satisfied (e.g.
    // tests already pass). Don't burn a model call to find that out.
    try {
      const pre = await goal.verify();
      if (pre.ok) {
        outcome = "verified";
        yield this.#mkStatusEvent(parentTraceId, "goal_done", {
          outcome: "verified",
          iterationCount: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          note: "verify() passed before any iteration ran",
        });
        return;
      }
      lastHint = pre.hint;
    } catch (e) {
      lastError = `verify() threw before first iteration: ${e instanceof Error ? e.message : String(e)}`;
      outcome = "error";
      yield this.#mkStatusEvent(parentTraceId, "goal_done", {
        outcome,
        iterationCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        lastError,
      });
      return;
    }

    while (iteration < this.#maxIterations) {
      iteration++;
      yield this.#mkStatusEvent(parentTraceId, "goal_iteration_start", {
        iteration,
        ...(lastHint ? { hint: lastHint } : {}),
      });

      // Build this iteration's prompt: the goal, plus the prior verify
      // hint if any. Each iteration is a fresh ToolCallingAgent run
      // (no carried history) — see file docstring for why.
      const prompt = this.#buildIterationPrompt(goal, lastHint, iteration);
      const sysPrompt = this.#systemPromptAddendum
        ? `${DEFAULT_GOAL_SYSTEM_PROMPT}\n\n${this.#systemPromptAddendum}`
        : DEFAULT_GOAL_SYSTEM_PROMPT;

      const agent = new ToolCallingAgent({
        model: this.#model,
        tools: this.#tools,
        maxSteps: this.#maxStepsPerIteration,
        systemPrompt: sysPrompt,
        ...(this.#enableToolSynthesis !== undefined
          ? { enableToolSynthesis: this.#enableToolSynthesis }
          : {}),
      });

      try {
        for await (const ev of agent.run(prompt, parentTraceId)) {
          // Re-yield the iteration's events. Track tokens for the
          // cross-iteration budget check.
          if (ev.event === "model_done") {
            const data = ev.data as { inputTokens?: number; outputTokens?: number };
            totalInput += data.inputTokens ?? 0;
            totalOutput += data.outputTokens ?? 0;
          }
          yield ev;
        }
      } catch (e) {
        lastError = `iteration ${iteration} threw: ${e instanceof Error ? e.message : String(e)}`;
        outcome = "error";
        break;
      }

      // Budget check happens AFTER iteration finishes. We don't
      // interrupt mid-iteration because the agent may have made
      // partial progress that we'd lose; tokens for the iteration
      // are already burned regardless.
      if (this.#tokenBudget !== undefined && totalInput + totalOutput >= this.#tokenBudget) {
        outcome = "budget";
        break;
      }

      // Verify after iteration. If it passes, we're done.
      let verifyResult: Awaited<ReturnType<Goal["verify"]>>;
      try {
        verifyResult = await goal.verify();
      } catch (e) {
        lastError = `verify() threw at iteration ${iteration}: ${e instanceof Error ? e.message : String(e)}`;
        outcome = "error";
        break;
      }

      if (verifyResult.ok) {
        outcome = "verified";
        lastHint = undefined;
        break;
      }
      // 2026-06-18 (axis 9, stop-loss): if the verifier returns the
      // SAME hint as the previous iteration, the agent is not making
      // progress — it's burning tokens reproducing the same output.
      // Common cause: the criterion is structurally unattainable
      // (asks for impossible quantity / forbidden artefact). Bail out
      // early instead of wasting maxIterations × tokens. The user-
      // reported case was a 50000-word floor that pinned Sonnet into
      // 369k output tokens on a single iteration before exhausting.
      // GoalDirectedAgent's L3 negotiation path picks this up via
      // lastHint and proposes a relaxation.
      if (verifyResult.hint && verifyResult.hint === lastHint) {
        noProgressStreak++;
        if (noProgressStreak >= this.#maxNoProgressIterations) {
          outcome = "exhausted";
          lastHint = verifyResult.hint;
          break;
        }
      } else {
        noProgressStreak = 0;
      }
      lastHint = verifyResult.hint;
    }

    const result: GoalRunResult = {
      outcome,
      iterationCount: iteration,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      ...(lastHint ? { lastHint } : {}),
      ...(lastError ? { lastError } : {}),
    };
    yield this.#mkStatusEvent(parentTraceId, "goal_done", result);
  }

  #buildIterationPrompt(goal: Goal, lastHint: string | undefined, iteration: number): string {
    if (iteration === 1) {
      return goal.describe;
    }
    const hintPart = lastHint
      ? `\n\nThe verifier from the previous attempt reports:\n${lastHint}\n\nAddress this specifically.`
      : "\n\nThe previous attempt did not satisfy the verifier. Try a different approach.";
    return `${goal.describe}\n\n[Iteration ${iteration} of at most ${this.#maxIterations}.]${hintPart}`;
  }

  #mkStatusEvent(parentTraceId: string | null, eventName: string, data: unknown): AgentEvent {
    return {
      traceId: `goal-${Date.now().toString(36)}-${eventName}`,
      parentTraceId,
      timestampMs: Date.now(),
      channel: "status",
      event: eventName as unknown as AgentEvent["event"],
      data: data as never,
    } as AgentEvent;
  }
}

const DEFAULT_GOAL_SYSTEM_PROMPT =
  "You are a goal-directed assistant working inside a verify-loop. " +
  "Each iteration you receive a goal description and (after the first) " +
  "feedback from a deterministic verifier that checked the previous " +
  "attempt. Your job is to use the available tools to drive the world " +
  "to the state the verifier accepts. Be precise; do not claim a goal " +
  "is met without evidence — the verifier will check, and false claims " +
  "waste an iteration.";
