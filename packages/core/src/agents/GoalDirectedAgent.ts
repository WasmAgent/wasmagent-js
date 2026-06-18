/**
 * GoalDirectedAgent — high-level "user states a goal, agent figures out
 * how to verify, plan, execute, and report" loop.
 *
 * # Why this is a new layer rather than a flag on GoalAgent
 *
 * `GoalAgent` (this directory) is the stripped-down loop primitive:
 * caller hands it `{describe, verify}` and gets `verified | exhausted |
 * budget | error`. Every consumer hand-crafts a deterministic verifier
 * — that's the safety unblock from [[loop-engineering-deliverables-2026-06-15]]
 * (LLM-as-judge is reward-hacking risk).
 *
 * `GoalDirectedAgent` makes a different trade. The caller has only a
 * **task description** (not a verify function); it's the agent's job
 * to:
 *   1. **Scout** — list tools, snapshot workspace + memory
 *   2. **Synthesize criteria** — ask the model "what would success look
 *      like?", get back JSON Criterion[] (deterministic where possible,
 *      `llm_judge` for the rest)
 *   3. **Run GoalAgent** — execute with the synthesized criteria as
 *      `verify`, looping with hints until verified or exhausted
 *   4. **Summarize** — emit one final event with verdicts + iteration
 *      count + outcome
 *
 * The reward-hacking concern from `GoalAgent` doesn't disappear; we
 * meet it head-on with `LLMJudgeVerifier`'s adversarial defaults
 * (default-fail, k=3 voting, low temperature, separate judge model).
 *
 * # Events
 *
 * Yields `AgentEvent`s on the `status` channel for each phase, plus
 * everything the inner `GoalAgent` and `ToolCallingAgent` yield:
 *   - scout_done            — Phase 0
 *   - criteria_proposed     — Phase 1 (data: Criterion[])
 *   - goal_iteration_start  — from GoalAgent (per attempt)
 *   - tool_call / tool_result / model_done — from each iteration
 *   - goal_done             — terminal, from GoalAgent
 *
 * Consumers that want a UI timeline subscribe to the status channel
 * and pick up these named events.
 *
 * # Empty criteria
 *
 * If Phase 1 returns zero criteria (pathological case: model output
 * unparseable, OR the task genuinely has no verifiable goal — "say
 * hi"), GoalDirectedAgent runs a SINGLE ToolCallingAgent iteration
 * and returns its final answer. This avoids burning iterations on a
 * verifier that can never fail.
 */

import type { Model } from "../models/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentEvent } from "../types/events.js";
import { GoalAgent } from "./GoalAgent.js";
import { ToolCallingAgent } from "./ToolCallingAgent.js";
import {
  type Criterion,
  DeterministicVerifier,
  LLMJudgeVerifier,
  VerificationPipeline,
  type Verifier,
  type WorkspaceReader,
} from "./verifiers/index.js";

/**
 * Snapshot of the workspace + tools the agent will see during scouting.
 * Caller provides this — agentkit core stays product-agnostic, doesn't
 * touch the filesystem itself.
 */
export interface ScoutSnapshot {
  /**
   * Names + 1-line descriptions of every tool the agent has access to.
   * Used in the criteria-synthesis prompt so the LLM can ground its
   * plan on actual capabilities.
   */
  tools: { name: string; description?: string }[];
  /**
   * Top-level entries in the workspace (paths only; do NOT include
   * full contents — that's expensive and rarely informative for goal
   * synthesis). Empty array is allowed when there's no workspace.
   */
  workspaceEntries: string[];
  /**
   * Optional notes / memory the caller wants to surface to the
   * synthesis prompt. Keep it short (≤ a few hundred chars) — long
   * memory tanks Phase-1 token budget without proportional benefit.
   */
  memoryHints?: string;
}

export interface GoalDirectedAgentOptions {
  /** Model used for execution + (default) criteria synthesis. */
  model: Model;
  /**
   * Optional separate model for synthesis (typically a cheaper one —
   * e.g. haiku — since it just produces structured criteria). Defaults
   * to `model` if omitted.
   */
  synthModel?: Model;
  /**
   * Optional separate model for the LLM judge. Independent grader
   * reduces self-graded inflation. Defaults to `model`.
   */
  judgeModel?: Model;
  tools: ToolDefinition[];
  /**
   * Read-only access to the workspace verifiers will use to evaluate
   * criteria. The same WS the executor's tools mutate.
   */
  workspaceReader: WorkspaceReader;
  /**
   * Caller-supplied scout snapshot. If omitted, the agent runs without
   * grounded environment context — synthesis still works but criteria
   * may be less specific. Recommended for any non-trivial deployment.
   */
  scout?: ScoutSnapshot;
  /**
   * Goal-loop iteration cap. Default 5 (matches GoalAgent default).
   */
  maxIterations?: number;
  /**
   * Per-iteration ToolCallingAgent step cap. Default 15.
   */
  maxStepsPerIteration?: number;
  /**
   * Token budget across the whole loop. When exceeded, the loop
   * terminates with `outcome: "budget"`.
   */
  tokenBudget?: number;
  /**
   * Extra criterion verifiers to register alongside the built-in
   * `DeterministicVerifier` + `LLMJudgeVerifier`. Useful for product-
   * specific kinds (e.g. `tests_pass`, `lighthouse_score_min`).
   * Last-registered wins on duplicate `verify_method` strings.
   */
  extraVerifiers?: Verifier[];
  /**
   * Override LLMJudge configuration. Defaults to `samples=3,
   * requirePassMajority=false` (= unanimous pass to succeed). See
   * `LLMJudgeVerifierOptions` for full knobs.
   */
  judgeSamples?: number;
  judgeRequireMajority?: boolean;
  /**
   * Override the criteria-synthesis system prompt. The default one is
   * adversarially worded: it tells the model to favour mechanical
   * checks and to mark `llm_judge` only for criteria that genuinely
   * cannot be evaluated mechanically. Replace at your own risk.
   */
  synthSystemPrompt?: string;
}

/** Default criteria-synthesis system prompt — frozen here so tests can lock its wording. */
export const DEFAULT_CRITERIA_SYNTH_SYSTEM_PROMPT = `You write success criteria for an agent that is about to attempt a user-stated task.

Your job: enumerate what would make the task DEMONSTRABLY done, in a form a verifier program can check. Prefer mechanical checks; reach for "llm_judge" only when no mechanical check fits.

Reply with a strict JSON object:
{"criteria":[
  {"id":"<short_snake_case>","description":"<human readable>","verify_method":"<one of: file_exists | file_size_min | file_size_max | file_contains | file_matches | headings_count_min | word_count_min | llm_judge>","arg":<method-specific arg or null>,"path":"<file path if applicable, else omit>"}
]}

Rules:
- 3 to 8 criteria. Fewer is better when the task is simple.
- Each criterion is INDEPENDENTLY checkable — do not chain them.
- For "introduce / overview / explain" tasks asking for a written document, include explicit length criteria (file_size_min in bytes, or word_count_min) and structure criteria (headings_count_min). Use generous floors only if the task explicitly asks for a long document; otherwise stay modest.
- For coding tasks, include file_exists / file_contains for the artifact and llm_judge only for behaviours mechanical checks cannot verify (idiomatic style, etc.).
- "llm_judge" criteria MUST set "path" to the artifact the judge will read.
- Output ONLY the JSON object. No prose. No code fence.`;

/**
 * Outcome of a GoalDirectedAgent.run() loop.
 */
export type GoalDirectedOutcome = "verified" | "exhausted" | "budget" | "error" | "single-shot";

export interface GoalDirectedRunResult {
  outcome: GoalDirectedOutcome;
  criteria: Criterion[];
  iterationCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Final aggregated verdict hint, if any (last-iteration failures). */
  lastHint?: string;
  lastError?: string;
  /** True if Phase 1 produced zero criteria and the agent fell back to a single-shot run. */
  emptyCriteriaFallback?: boolean;
}

/**
 * Parse the model's reply from Phase 1. Returns `[]` when the reply is
 * unparseable; the caller treats empty criteria as the single-shot
 * fallback case.
 */
export function parseCriteriaReply(text: string): Criterion[] {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  // Match the first JSON object — synth model may add stray prose despite the prompt.
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { criteria?: unknown };
    if (!Array.isArray(parsed.criteria)) return [];
    const out: Criterion[] = [];
    for (const c of parsed.criteria) {
      if (
        c &&
        typeof c === "object" &&
        typeof (c as Criterion).id === "string" &&
        typeof (c as Criterion).description === "string" &&
        typeof (c as Criterion).verify_method === "string"
      ) {
        const cc = c as Record<string, unknown>;
        const item: Criterion = {
          id: String(cc.id),
          description: String(cc.description),
          verify_method: String(cc.verify_method) as Criterion["verify_method"],
        };
        if (cc.arg !== undefined && cc.arg !== null) item.arg = cc.arg;
        if (typeof cc.path === "string") item.path = cc.path;
        out.push(item);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export class GoalDirectedAgent {
  readonly #model: Model;
  readonly #synthModel: Model;
  readonly #judgeModel: Model;
  readonly #tools: ToolDefinition[];
  readonly #ws: WorkspaceReader;
  readonly #scout: ScoutSnapshot | undefined;
  readonly #maxIterations: number;
  readonly #maxStepsPerIteration: number;
  readonly #tokenBudget: number | undefined;
  readonly #extraVerifiers: Verifier[];
  readonly #judgeSamples: number;
  readonly #judgeRequireMajority: boolean;
  readonly #synthSystemPrompt: string;

  constructor(opts: GoalDirectedAgentOptions) {
    this.#model = opts.model;
    this.#synthModel = opts.synthModel ?? opts.model;
    this.#judgeModel = opts.judgeModel ?? opts.model;
    this.#tools = opts.tools;
    this.#ws = opts.workspaceReader;
    this.#scout = opts.scout;
    this.#maxIterations = opts.maxIterations ?? 5;
    this.#maxStepsPerIteration = opts.maxStepsPerIteration ?? 15;
    this.#tokenBudget = opts.tokenBudget;
    this.#extraVerifiers = opts.extraVerifiers ?? [];
    this.#judgeSamples = opts.judgeSamples ?? 3;
    this.#judgeRequireMajority = opts.judgeRequireMajority ?? false;
    this.#synthSystemPrompt = opts.synthSystemPrompt ?? DEFAULT_CRITERIA_SYNTH_SYSTEM_PROMPT;
  }

  async *run(
    task: string,
    parentTraceId: string | null = null
  ): AsyncGenerator<AgentEvent> {
    let totalInput = 0;
    let totalOutput = 0;

    // ── Phase 0: scout ──────────────────────────────────────────────
    if (this.#scout) {
      yield this.#mkStatusEvent(parentTraceId, "scout_done", {
        toolCount: this.#scout.tools.length,
        tools: this.#scout.tools.map((t) => t.name),
        workspaceEntries: this.#scout.workspaceEntries,
        ...(this.#scout.memoryHints ? { memoryHints: this.#scout.memoryHints } : {}),
      });
    }

    // ── Phase 1: synthesize criteria ────────────────────────────────
    const criteria = await this.#synthesizeCriteria(task);
    yield this.#mkStatusEvent(parentTraceId, "criteria_proposed", { criteria });

    if (criteria.length === 0) {
      // Empty-criteria fallback — single-shot ToolCallingAgent run.
      // The user's task may genuinely lack verifiable success conditions
      // ("say hi"), or synthesis may have failed; either way running
      // GoalAgent with an always-passing verifier wastes a turn while
      // an always-failing one wastes maxIterations.
      const agent = new ToolCallingAgent({
        model: this.#model,
        tools: this.#tools,
        maxSteps: this.#maxStepsPerIteration,
      });
      try {
        for await (const ev of agent.run(task, parentTraceId)) {
          if (ev.event === "model_done") {
            const data = ev.data as { inputTokens?: number; outputTokens?: number };
            totalInput += data.inputTokens ?? 0;
            totalOutput += data.outputTokens ?? 0;
          }
          yield ev;
        }
      } catch (e) {
        yield this.#mkStatusEvent(parentTraceId, "goal_directed_done", {
          outcome: "error",
          criteria,
          iterationCount: 0,
          totalInputTokens: totalInput,
          totalOutputTokens: totalOutput,
          lastError: e instanceof Error ? e.message : String(e),
          emptyCriteriaFallback: true,
        } satisfies GoalDirectedRunResult);
        return;
      }
      yield this.#mkStatusEvent(parentTraceId, "goal_directed_done", {
        outcome: "single-shot",
        criteria,
        iterationCount: 1,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        emptyCriteriaFallback: true,
      } satisfies GoalDirectedRunResult);
      return;
    }

    // ── Phase 2-5: GoalAgent with the synthesized criteria ──────────
    const pipeline = new VerificationPipeline({
      ws: this.#ws,
      verifiers: [
        new DeterministicVerifier(),
        new LLMJudgeVerifier({
          model: this.#judgeModel,
          samples: this.#judgeSamples,
          requirePassMajority: this.#judgeRequireMajority,
        }),
        ...this.#extraVerifiers,
      ],
    });

    const goalAgent = new GoalAgent({
      model: this.#model,
      tools: this.#tools,
      maxIterations: this.#maxIterations,
      maxStepsPerIteration: this.#maxStepsPerIteration,
      ...(this.#tokenBudget !== undefined ? { tokenBudget: this.#tokenBudget } : {}),
      systemPromptAddendum: `Success criteria you must satisfy (a verifier will check):\n${JSON.stringify(criteria, null, 2)}`,
    });

    let goalDoneCaptured: { data: unknown; iter: number } | null = null;
    try {
      for await (const ev of goalAgent.run(
        { describe: task, verify: pipeline.asGoalVerify(criteria) },
        parentTraceId
      )) {
        if (ev.event === "model_done") {
          const data = ev.data as { inputTokens?: number; outputTokens?: number };
          totalInput += data.inputTokens ?? 0;
          totalOutput += data.outputTokens ?? 0;
        }
        if (ev.event === ("goal_done" as unknown as AgentEvent["event"])) {
          goalDoneCaptured = {
            data: ev.data,
            iter: (ev.data as { iterationCount?: number }).iterationCount ?? 0,
          };
          // Don't re-yield the inner goal_done — we'll emit our own
          // goal_directed_done with richer fields below.
          continue;
        }
        yield ev;
      }
    } catch (e) {
      yield this.#mkStatusEvent(parentTraceId, "goal_directed_done", {
        outcome: "error",
        criteria,
        iterationCount: goalDoneCaptured?.iter ?? 0,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        lastError: e instanceof Error ? e.message : String(e),
      } satisfies GoalDirectedRunResult);
      return;
    }

    // Translate inner goal_done into our richer goal_directed_done.
    const inner = (goalDoneCaptured?.data ?? {}) as {
      outcome?: GoalDirectedOutcome;
      iterationCount?: number;
      lastHint?: string;
      lastError?: string;
    };
    const result: GoalDirectedRunResult = {
      outcome: inner.outcome ?? "exhausted",
      criteria,
      iterationCount: inner.iterationCount ?? 0,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      ...(inner.lastHint ? { lastHint: inner.lastHint } : {}),
      ...(inner.lastError ? { lastError: inner.lastError } : {}),
    };
    yield this.#mkStatusEvent(parentTraceId, "goal_directed_done", result);
  }

  async #synthesizeCriteria(task: string): Promise<Criterion[]> {
    const scoutBlock = this.#scout
      ? [
          "Available tools (you may reference these by name in your criteria):",
          ...this.#scout.tools.map(
            (t) => `  - ${t.name}${t.description ? `: ${t.description}` : ""}`
          ),
          "",
          "Top-level workspace entries:",
          ...this.#scout.workspaceEntries.slice(0, 40).map((p) => `  - ${p}`),
          ...(this.#scout.workspaceEntries.length > 40
            ? [`  …and ${this.#scout.workspaceEntries.length - 40} more`]
            : []),
          ...(this.#scout.memoryHints ? ["", "Memory hints:", this.#scout.memoryHints] : []),
        ].join("\n")
      : "(no scout snapshot supplied)";

    const userMessage = `Task from user:\n"""\n${task}\n"""\n\n${scoutBlock}\n\nProduce the criteria JSON now.`;

    let buffer = "";
    for await (const ev of this.#synthModel.generate(
      [
        { role: "system", content: this.#synthSystemPrompt },
        { role: "user", content: userMessage },
      ],
      { stream: true, temperature: 0.1, maxTokens: 1200 }
    )) {
      if (ev.type === "text_delta" && ev.delta) buffer += ev.delta;
    }
    return parseCriteriaReply(buffer);
  }

  #mkStatusEvent(parentTraceId: string | null, eventName: string, data: unknown): AgentEvent {
    return {
      traceId: `gda-${Date.now().toString(36)}-${eventName}`,
      parentTraceId,
      timestampMs: Date.now(),
      channel: "status",
      event: eventName as unknown as AgentEvent["event"],
      data: data as never,
    } as AgentEvent;
  }
}
