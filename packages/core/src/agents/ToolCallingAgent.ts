import { TOOL_SYNTHESIS_FRAGMENT } from "@wasmagent/agent-prompts";
import type { ZodSchema } from "zod";
import type { Checkpointer } from "../checkpoint/index.js";
import { BudgetForcingRunner } from "../enhancement/BudgetForcingRunner.js";
import { ParallelForkJoinRunner } from "../enhancement/ParallelForkJoinRunner.js";
import { ReflectRefineRunner } from "../enhancement/ReflectRefineRunner.js";
import { SelfConsistencyRunner } from "../enhancement/SelfConsistencyRunner.js";
import type { InputGuardrail, OutputGuardrail, ToolGuardrail } from "../guardrails/index.js";
import { runInputGuardrails, runOutputGuardrails, runToolGuardrails } from "../guardrails/index.js";
import { LazyObservationHandle } from "../memory/LazyObservationHandle.js";
import { MessageAssembler } from "../memory/MessageAssembler.js";
import { repairJson } from "../models/OpenAIModel.js";
import type { EnhancementPolicy, Model } from "../models/types.js";
import { TokenBudget } from "../models/types.js";
import { deriveDependencies } from "../scheduler/deriveDeps.js";
import type { IRNode } from "../scheduler/ir.js";
import { SimpleIR } from "../scheduler/ir.js";
import { Scheduler } from "../scheduler/Scheduler.js";
import { ToolRegistry, toStrictJsonSchema, zodToJsonSchema } from "../tools/ToolRegistry.js";
import type { ToolDefinition } from "../tools/types.js";
import type {
  AgentEvent,
  AgentRunConfig,
  ParallelToolUseCall,
  ParallelToolUseStep,
  ToolUseStep,
  UserMessageStep,
} from "../types/events.js";
import { randomUUID } from "../util/runtime.js";
import { runPlanningStep, TOOL_DEP_INSTRUCTIONS } from "./prompts.js";
import type { StopCondition } from "./stopConditions.js";
import { callFingerprint, parseStopPolicies } from "./stopConditions.js";

const DEFAULT_SYSTEM_PROMPT = `You are an expert assistant. Use the provided tools to answer questions.
When you have a final answer, respond with plain text (no tool call).
${TOOL_DEP_INSTRUCTIONS}`;

// 2026-06-18 (axis 9, L2) ── synthesis preamble + helpers ───────────────────
// When the user opts into tool synthesis, the system prompt gets a paragraph
// reframing the named code-execution tool as the *synthesis substrate*: the
// fallback the model can reach for when the registry has nothing that fits.
// Default off — the new content only appears when the user explicitly opts in.

/** Resolve `enableToolSynthesis` to a concrete code-tool name, or null when off. */
function resolveSynthesisCodeTool(
  opt: boolean | { codeToolName: string } | undefined
): string | null {
  if (opt === true) return "execute_code";
  if (opt && typeof opt === "object") return opt.codeToolName;
  return null;
}

/** Wrap the user's system prompt with a synthesis-substrate paragraph when enabled. */
function withSynthesisPreamble(systemPrompt: string, codeToolName: string | null): string {
  if (!codeToolName) return systemPrompt;
  return systemPrompt + TOOL_SYNTHESIS_FRAGMENT(codeToolName);
}

export interface ToolCallingAgentOptions {
  tools: ToolDefinition[];
  model: Model;
  maxSteps?: number;
  /** Emit a planning step every N action steps (mirrors CodeAgent planningInterval). */
  planningInterval?: number;
  systemPrompt?: string;
  /** Optional enhancement policy — gates self-consistency, reflect-refine, budget limits (P1). */
  enhancementPolicy?: EnhancementPolicy;
  /**
   * Per-tool execution timeout in milliseconds. If a tool's forward() does not settle
   * within this window, the call is aborted and the step receives an execution_error.
   * Default: no timeout (tool can run indefinitely).
   */
  toolTimeoutMs?: number;
  /** Inject a pre-configured MessageAssembler (e.g. for compaction tests). */
  assembler?: MessageAssembler;
  /** DAG scheduler mode for parallel tool dispatch. Default: "dag". */
  scheduler?: "dag" | "parallel";
  /**
   * Composable stop conditions checked before each step. The first condition
   * that returns true terminates the run with a "stop_condition" error event.
   * See stopConditions.ts for built-ins: stepCountIs, noProgress, costBudget.
   */
  stopWhen?: StopCondition[];
  /**
   * String descriptors resolved via parseStopPolicy and merged with stopWhen.
   * Accepted formats: "steps:N", "cost:N", "noProgress", "noProgress:K".
   * Unrecognised descriptors are silently dropped.
   */
  stopPolicies?: string[];
  /**
   * Optional checkpointer used for per-tool human approval (needsApproval).
   * Required when any tool has needsApproval set; the agent emits an
   * "await_human_input" event and polls the checkpointer until a response arrives.
   */
  checkpointer?: Checkpointer;
  /**
   * A1: Input guardrails run in parallel with the first model call.
   * A tripwire triggers fail-fast before any model output is consumed.
   */
  inputGuardrails?: InputGuardrail[];
  /**
   * A1: Output guardrails run before the final_answer event is emitted.
   * A tripwire prevents the answer from being delivered and emits guardrail_tripwire.
   */
  outputGuardrails?: OutputGuardrail[];
  /**
   * A1: Tool guardrails run before each tool invocation.
   * A tripwire blocks the tool call and emits guardrail_tripwire.
   */
  toolGuardrails?: ToolGuardrail[];
  /**
   * A2: Zod schema constraining the type of final_answer.data.answer.
   * When provided, the answer is validated after each candidate and
   * retried (with a fix prompt) up to outputSchemaRetries times on failure.
   */
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  outputSchema?: ZodSchema<any>;
  /**
   * A2: Maximum number of fix-prompt retries when outputSchema validation fails.
   * Default: 2.
   */
  outputSchemaRetries?: number;
  /**
   * Max output tokens per model call. Default: 8192.
   * Increase for framework/file-generation tasks where tool call JSON can be large.
   */
  maxTokensPerStep?: number;
  /**
   * 2026-06-18 (axis 9, L2 — adaptive execution).
   *
   * When true (or an object), the agent reframes a registered code-
   * execution tool as the **synthesis substrate** when no other tool
   * fits. Three things happen:
   *
   * 1. The system prompt gets a paragraph telling the model it may
   *    use the code tool to *synthesise* a one-off when the registry
   *    has nothing suitable.
   * 2. The L1 framework-hint on tool failure mentions the code tool
   *    by name (instead of the generic "execute_code" placeholder).
   * 3. Calls to the code tool emit a `tool_synthesised` event so
   *    observers can discriminate "synthesis on failure" from a
   *    routine code-mode call.
   *
   * Defaults to false (off). Pass `true` to use the conventional
   * `"execute_code"` tool name, or an object to override:
   *
   *   enableToolSynthesis: { codeToolName: "run_code" }
   *
   * The tool itself must already be registered in `tools` — this
   * option does not auto-register a kernel. See
   * `docs/strategy/2026-06-18-adaptive-execution.md` and
   * `docs/rfcs/adaptive-execution.md`.
   */
  enableToolSynthesis?: boolean | { codeToolName: string };
  /**
   * SI-7 — Pre-bound AbortSignal. When this signal fires, the agent
   * terminates at the start of the next step and emits an `error` event.
   * Useful when the signal is known at construction time (e.g. an HTTP
   * request's AbortSignal). A signal passed to `run()` opts takes
   * precedence; this acts as the fallback.
   */
  signal?: AbortSignal;
}

/**
 * ToolCallingAgent — uses structured model tool_use blocks instead of code.
 *
 * Each step the model may return one or more tool_use calls. Multiple calls in
 * a single step are dispatched in parallel using LazyObservationHandle (B3) and
 * stored as a ParallelToolUseStep so MessageAssembler produces the correct
 * one-assistant + one-user multi-turn format required by the Anthropic API.
 *
 * Single-call steps are stored as ToolUseStep (backward-compatible).
 */
export class ToolCallingAgent {
  readonly #tools: ToolRegistry;
  readonly #model: Model;
  readonly #maxSteps: number;
  readonly #planningInterval: number | undefined;
  readonly #assembler: MessageAssembler;
  readonly #policy: EnhancementPolicy | undefined;
  readonly #toolsSchema: object[];
  readonly #toolTimeoutMs: number | undefined;
  readonly #schedulerMode: "dag" | "parallel";
  readonly #stopWhen: StopCondition[];
  readonly #checkpointer: Checkpointer | undefined;
  readonly #inputGuardrails: InputGuardrail[];
  readonly #outputGuardrails: OutputGuardrail[];
  readonly #toolGuardrails: ToolGuardrail[];
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  readonly #outputSchema: ZodSchema<any> | undefined;
  readonly #outputSchemaRetries: number;
  readonly #maxTokensPerStep: number;
  /** 2026-06-18 (axis 9, L2) — name of the code tool to frame as synthesis substrate, or null when disabled. */
  readonly #synthesisCodeTool: string | null;
  /** SI-7 — pre-bound AbortSignal (optional; run() opts take precedence). */
  readonly #signal: AbortSignal | undefined;
  /** SI-6+8 — active config snapshot, built at construction and emitted at run_start. */
  readonly #runConfig: Omit<AgentRunConfig, "signal">;

  constructor(opts: ToolCallingAgentOptions) {
    this.#tools = new ToolRegistry();
    for (const tool of opts.tools) {
      this.#tools.register(tool);
    }
    this.#model = opts.model;
    this.#maxSteps = opts.maxSteps ?? opts.enhancementPolicy?.budget?.maxSteps ?? 20;
    this.#planningInterval = opts.planningInterval;
    this.#policy = opts.enhancementPolicy;
    this.#toolTimeoutMs = opts.toolTimeoutMs;
    this.#schedulerMode = opts.scheduler ?? "dag";
    this.#stopWhen = [...(opts.stopWhen ?? []), ...parseStopPolicies(opts.stopPolicies ?? [])];
    this.#checkpointer = opts.checkpointer;
    this.#inputGuardrails = opts.inputGuardrails ?? [];
    this.#outputGuardrails = opts.outputGuardrails ?? [];
    this.#toolGuardrails = opts.toolGuardrails ?? [];
    this.#outputSchema = opts.outputSchema;
    this.#outputSchemaRetries = opts.outputSchemaRetries ?? 2;
    this.#maxTokensPerStep = opts.maxTokensPerStep ?? 8192;
    this.#toolsSchema = this.#tools.toJsonSchema();
    // 2026-06-18 (axis 9, L2) — opt-in synthesis substrate. Resolves
    // the user's enableToolSynthesis to a concrete code-tool name (or
    // null when off). Only the name matters at this point — the
    // actual tool registration is the user's responsibility.
    this.#synthesisCodeTool = resolveSynthesisCodeTool(opts.enableToolSynthesis);
    const systemPrompt = withSynthesisPreamble(
      opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      this.#synthesisCodeTool
    );
    this.#assembler =
      opts.assembler ??
      new MessageAssembler({
        systemPrompt,
        toolsSchema: this.#toolsSchema,
      });
    this.#signal = opts.signal;
    // SI-6+8: build config snapshot once; reused at run_start and each checkpoint.
    this.#runConfig = {
      model: this.#model.providerId,
      tools: this.#tools.names().sort(),
      maxSteps: this.#maxSteps,
      ...(opts.stopPolicies?.length ? { stopPolicies: opts.stopPolicies } : {}),
      toolSynthesis: this.#synthesisCodeTool,
    };
  }

  /** Read-only access to the underlying MessageAssembler for compaction. */
  get assembler(): MessageAssembler {
    return this.#assembler;
  }

  async *run(
    task: string,
    parentTraceId: string | null = null,
    opts: { signal?: AbortSignal } = {}
  ): AsyncGenerator<AgentEvent> {
    // SI-7: run() opts take precedence over the constructor-bound signal.
    const signal = opts.signal ?? this.#signal;
    const traceId = `agent-${randomUUID()}`;
    // SI-6: full config snapshot (signal flag resolved per-run).
    const agentConfig: AgentRunConfig = { ...this.#runConfig, signal: !!signal };

    yield {
      traceId,
      parentTraceId,
      channel: "text",
      event: "run_start",
      data: { task, agentConfig },
      timestampMs: Date.now(),
    };

    this.#assembler.reset();
    const seedStep: UserMessageStep = { type: "user_message", content: task };
    this.#assembler.addStep(seedStep);

    const budget = new TokenBudget();
    const budgetMaxTokens = this.#policy?.budget?.maxTokens;
    const runStartMs = Date.now();
    const budgetMaxDurationMs = this.#policy?.budget?.maxDurationMs;
    // C2: call fingerprint history for noProgress detection.
    const callHistory: string[][] = [];

    // A2: Build responseFormat for outputSchema if the model supports constrained decoding.
    const outputResponseFormat =
      this.#outputSchema && this.#model.capabilities?.supportsGrammar
        ? (() => {
            try {
              const isAnthropic = this.#model.providerId?.startsWith("anthropic/");
              const schema = isAnthropic
                ? zodToJsonSchema(this.#outputSchema)
                : toStrictJsonSchema(this.#outputSchema);
              return { type: "json_schema" as const, schema, name: "output", strict: true };
            } catch {
              return undefined;
            }
          })()
        : undefined;

    // A1: input guardrail check — runs concurrently with step 1's model invocation.
    // We kick it off here before the loop so it overlaps with the first model call.
    const inputGuardrailPromise = runInputGuardrails(
      this.#inputGuardrails,
      task,
      this.#assembler.build()
    );

    let inputGuardrailChecked = false;

    for (let step = 1; step <= this.#maxSteps; step++) {
      // B2: external kill-switch — check before every step and abort if signalled.
      if (signal?.aborted) {
        if (this.#checkpointer) {
          await this.#checkpointer.save(traceId, {
            traceId,
            task,
            history: [],
            stepIndex: step,
            savedAtMs: Date.now(),
            agentConfig,
          });
        }
        yield {
          traceId,
          parentTraceId,
          channel: "text",
          event: "error",
          data: { error: "Agent aborted by external signal", step },
          timestampMs: Date.now(),
        };
        return;
      }
      // C2: check composable stop conditions before each step.
      if (this.#stopWhen.length > 0) {
        const ctx = {
          step,
          totalTokens: budget.total,
          lastCallFingerprints: callHistory.at(-1) ?? [],
          callHistory,
        };
        for (const cond of this.#stopWhen) {
          if (cond(ctx)) {
            yield {
              traceId,
              parentTraceId,
              channel: "text",
              event: "error",
              data: { error: `Stop condition triggered at step ${step}` },
              timestampMs: Date.now(),
            };
            return;
          }
        }
      }
      // P1: enforce ResourceBudget limits before each step.
      // Note: budget.total is updated only when a usage event arrives (after the full
      // model response). A streaming response that exceeds the limit mid-stream will
      // not be interrupted — the check catches it at the START of the NEXT step.
      if (budgetMaxTokens && budget.total >= budgetMaxTokens) {
        yield {
          traceId,
          parentTraceId,
          channel: "text",
          event: "error",
          data: { error: `Token budget exhausted (${budget.total} >= ${budgetMaxTokens})` },
          timestampMs: Date.now(),
        };
        return;
      }
      if (budgetMaxDurationMs && Date.now() - runStartMs >= budgetMaxDurationMs) {
        yield {
          traceId,
          parentTraceId,
          channel: "text",
          event: "error",
          data: {
            error: `Time budget exhausted (${Date.now() - runStartMs}ms >= ${budgetMaxDurationMs}ms)`,
          },
          timestampMs: Date.now(),
        };
        return;
      }
      if (this.#planningInterval && step > 1 && (step - 1) % this.#planningInterval === 0) {
        yield* this.#runPlanningStep(traceId, parentTraceId, step, budget);
      }

      yield {
        traceId,
        parentTraceId,
        channel: "thinking",
        event: "step_start",
        data: { step },
        timestampMs: Date.now(),
      };

      const messages = this.#assembler.build();
      let fullText = "";

      // Collect ALL tool calls from one generate() pass.
      // Models may return multiple tool_use blocks in a single response
      // (parallel function calling). Three scalars would overwrite; use an array.
      const pendingCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
      let receivedUsage = false;

      // A1: on step 1, resolve input guardrails concurrently with model generation.
      // After step 1, input was already checked — skip the await.
      let inputGuardrailTripwire: Awaited<typeof inputGuardrailPromise> = null;
      if (!inputGuardrailChecked) {
        inputGuardrailChecked = true;
        // Start model generation — input guardrail runs concurrently.
        const generatePromise = (async () => {
          for await (const event of this.#model.generate(messages, {
            stream: true,
            tools: this.#toolsSchema,
            maxTokens: this.#maxTokensPerStep,
            disableParallelToolUse: true,
            ...(outputResponseFormat ? { responseFormat: outputResponseFormat } : {}),
          })) {
            if (event.type === "text_delta" && event.delta) {
              fullText += event.delta;
            } else if (event.type === "tool_call" && event.toolCall) {
              pendingCalls.push({
                id: event.toolCall.id,
                name: event.toolCall.name,
                input: event.toolCall.input,
              });
            } else if (event.type === "usage" && event.usage) {
              budget.recordUsage(event.usage);
              receivedUsage = true;
            }
          }
        })();
        [inputGuardrailTripwire] = await Promise.all([inputGuardrailPromise, generatePromise]);
      } else {
        for await (const event of this.#model.generate(messages, {
          stream: true,
          tools: this.#toolsSchema,
          maxTokens: this.#maxTokensPerStep,
          disableParallelToolUse: true,
          ...(outputResponseFormat ? { responseFormat: outputResponseFormat } : {}),
        })) {
          if (event.type === "text_delta" && event.delta) {
            fullText += event.delta;
          } else if (event.type === "tool_call" && event.toolCall) {
            pendingCalls.push({
              id: event.toolCall.id,
              name: event.toolCall.name,
              input: event.toolCall.input,
            });
          } else if (event.type === "usage" && event.usage) {
            budget.recordUsage(event.usage);
            receivedUsage = true;
          }
        }
      }

      // A1: check if input guardrail triggered (checked after generation to preserve concurrency).
      if (inputGuardrailTripwire) {
        yield {
          traceId,
          parentTraceId,
          channel: "status",
          event: "guardrail_tripwire",
          data: {
            guardrailName: inputGuardrailTripwire.guardrailName,
            layer: "input" as const,
            ...(inputGuardrailTripwire.result.metadata
              ? { metadata: inputGuardrailTripwire.result.metadata }
              : {}),
          },
          timestampMs: Date.now(),
        };
        yield {
          traceId,
          parentTraceId,
          channel: "text",
          event: "error",
          data: {
            error: `Input guardrail "${inputGuardrailTripwire.guardrailName}" triggered`,
            step,
          },
          timestampMs: Date.now(),
        };
        return;
      }

      if (!receivedUsage) {
        budget.estimateFallback(messages, fullText);
      }

      // Emit model_done so the frontend TokenMeter can display live token stats.
      const stats = budget.toStats();
      const modelId = (this.#model as { modelId?: string }).modelId ?? "unknown";
      yield {
        traceId,
        parentTraceId,
        channel: "model" as const,
        event: "model_done",
        data: {
          modelId,
          step,
          finishReason: "stop",
          inputTokens: stats.inputTokens,
          outputTokens: stats.outputTokens,
          cacheReadTokens: stats.cacheReadTokens,
          // Include derived metrics for richer frontend display
          cacheHitRate: budget.cacheHitRate,
          estimatedUsd: budget.estimatedUsdFor(modelId),
          calls: stats.calls,
        },
        timestampMs: Date.now(),
      };

      // No tool calls → model responded with text — treat as final answer.
      if (pendingCalls.length === 0) {
        let answer = fullText.trim() || "No answer provided";

        // Apply enhancement runners when configured.
        // Budget-forcing takes priority (requires model support), then reflect-refine,
        // then self-consistency. Runners run in isolated contexts — they do not mutate
        // the assembler history or the main token budget tracking here.
        const messages = this.#assembler.build();
        if (
          this.#policy?.budgetForcing?.enabled &&
          this.#model.capabilities?.supportsBudgetForcing
        ) {
          const result = await new BudgetForcingRunner().run(this.#model, messages);
          answer = result.answer || answer;
        } else if (this.#policy?.reflectRefine?.enabled) {
          const reflectOpts =
            this.#policy.reflectRefine.maxCycles !== undefined
              ? { maxCycles: this.#policy.reflectRefine.maxCycles }
              : {};
          const result = await new ReflectRefineRunner(reflectOpts).run(this.#model, messages);
          answer = result.answer || answer;
        } else if (this.#policy?.selfConsistency?.enabled) {
          const scOpts: { n?: number; earlyStopThreshold?: number } = {};
          if (this.#policy.selfConsistency.n !== undefined)
            scOpts.n = this.#policy.selfConsistency.n;
          if (this.#policy.selfConsistency.earlyStopThreshold !== undefined) {
            scOpts.earlyStopThreshold = this.#policy.selfConsistency.earlyStopThreshold;
          }
          const result = await new SelfConsistencyRunner(scOpts).run(this.#model, messages);
          answer = result.answer || answer;
        } else if (this.#policy?.parallelForkJoin?.enabled) {
          const fjOpts: {
            branches?: number;
            concurrency?: number;
            aggregation?: "summary" | "first";
          } = {};
          if (this.#policy.parallelForkJoin.branches !== undefined)
            fjOpts.branches = this.#policy.parallelForkJoin.branches;
          if (this.#policy.parallelForkJoin.concurrency !== undefined)
            fjOpts.concurrency = this.#policy.parallelForkJoin.concurrency;
          if (this.#policy.parallelForkJoin.aggregation !== undefined)
            fjOpts.aggregation = this.#policy.parallelForkJoin.aggregation;
          const result = await new ParallelForkJoinRunner(fjOpts).run(this.#model, messages);
          answer = result.answer || answer;
        }

        // A2: validate answer against outputSchema, retry on failure.
        // biome-ignore lint/suspicious/noExplicitAny: intentional
        let parsedAnswer: any = answer;
        if (this.#outputSchema) {
          // R3: first try deterministic JSON repair before going to model retries.
          const parseCandidate = (raw: string): unknown => {
            try {
              return JSON.parse(raw);
            } catch {
              /* fallthrough */
            }
            const repaired = repairJson(raw);
            try {
              return JSON.parse(repaired);
            } catch {
              return raw;
            }
          };
          let parseResult = this.#outputSchema.safeParse(
            typeof answer === "string" ? parseCandidate(answer) : answer
          );
          // Pre-compute schema description — it never changes across retries.
          const schemaDesc = JSON.stringify(zodToJsonSchema(this.#outputSchema));
          let retries = 0;
          while (!parseResult.success && retries < this.#outputSchemaRetries) {
            retries++;
            const fixMessages = [
              ...this.#assembler.build(),
              {
                role: "user" as const,
                content: `Your previous answer failed schema validation: ${parseResult.error.message}\nPlease respond with a valid JSON object matching this schema: ${schemaDesc}`,
              },
            ];
            let fixText = "";
            for await (const ev of this.#model.generate(fixMessages, {
              stream: true,
              ...(outputResponseFormat ? { responseFormat: outputResponseFormat } : {}),
            })) {
              if (ev.type === "text_delta" && ev.delta) fixText += ev.delta;
            }
            const candidate = fixText.trim();
            parseResult = this.#outputSchema.safeParse(parseCandidate(candidate));
            if (parseResult.success) {
              parsedAnswer = parseResult.data;
            }
          }
          if (!parseResult.success) {
            yield {
              traceId,
              parentTraceId,
              channel: "text",
              event: "error",
              data: {
                error: `Output schema validation failed after ${this.#outputSchemaRetries} retries: ${parseResult.error.message}`,
                step,
              },
              timestampMs: Date.now(),
            };
            return;
          }
          parsedAnswer = parseResult.data;
        }

        // A1: output guardrail check before emitting final_answer.
        const outputTripwire = await runOutputGuardrails(this.#outputGuardrails, parsedAnswer);
        if (outputTripwire) {
          yield {
            traceId,
            parentTraceId,
            channel: "status",
            event: "guardrail_tripwire",
            data: {
              guardrailName: outputTripwire.guardrailName,
              layer: "output" as const,
              ...(outputTripwire.result.metadata
                ? { metadata: outputTripwire.result.metadata }
                : {}),
            },
            timestampMs: Date.now(),
          };
          yield {
            traceId,
            parentTraceId,
            channel: "text",
            event: "error",
            data: { error: `Output guardrail "${outputTripwire.guardrailName}" triggered`, step },
            timestampMs: Date.now(),
          };
          return;
        }

        // Record the final step after all checks pass, using the coerced/validated value.
        this.#assembler.addStep({ type: "final_answer", answer: parsedAnswer });

        yield {
          traceId,
          parentTraceId,
          channel: "text",
          event: "final_answer",
          data: { answer: parsedAnswer },
          timestampMs: Date.now(),
        };
        return;
      }

      // Q8: batchId groups tool_call / tool_result events that belong to the same
      // parallel dispatch (single model response with N tool_use blocks).
      const batchId = randomUUID();
      const batchSize = pendingCalls.length;

      // F2: action_proposed events — Vercel AI SDK pattern for observability.
      // Emitted before tool_call so frontends can show "about to call X" indicators.
      for (const call of pendingCalls) {
        const proposedData: { actionId: string; type: string; path?: string; reason?: string } = {
          actionId: call.id,
          type: call.name,
        };
        const callPath = (call.input as Record<string, unknown>)?.path;
        if (typeof callPath === "string") proposedData.path = callPath;
        const reason = fullText.slice(0, 150);
        if (reason) proposedData.reason = reason;
        yield {
          traceId,
          parentTraceId,
          channel: "action",
          event: "action_proposed",
          data: proposedData,
          timestampMs: Date.now(),
        };
      }

      for (const call of pendingCalls) {
        yield {
          traceId,
          parentTraceId,
          channel: "tool",
          event: "tool_call",
          data: {
            toolName: call.name,
            args: call.input,
            callId: call.id,
            batchId,
            batchSize,
            stepIndex: step,
          },
          timestampMs: Date.now(),
        };
        // 2026-06-18 (axis 9, L2) — discriminate synthesis from routine
        // code-mode. Only emit when synthesis is enabled AND the call
        // hits the nominated code tool. Lets observers (devtools, OTel
        // exporter, eval grader) tell "agent reached for synthesis"
        // apart from "agent ran a known code-mode tool".
        if (this.#synthesisCodeTool && call.name === this.#synthesisCodeTool) {
          yield {
            traceId,
            parentTraceId,
            channel: "tool",
            event: "tool_synthesised",
            data: {
              codeToolName: this.#synthesisCodeTool,
              callId: call.id,
              stepIndex: step,
            },
            timestampMs: Date.now(),
          };
        }
      }

      // U1: emit status events before dispatching tool calls.
      for (const call of pendingCalls) {
        yield {
          traceId,
          parentTraceId,
          channel: "status" as const,
          event: "status" as const,
          data: { phase: "tool_executing", toolName: call.name, callId: call.id, step },
          timestampMs: Date.now(),
        };
        // F2: action_executing — records actual start time for latency tracking.
        yield {
          traceId,
          parentTraceId,
          channel: "action",
          event: "action_executing",
          data: { actionId: call.id, startedAtMs: Date.now() },
          timestampMs: Date.now(),
        };
      }

      // A1: tool guardrail check — runs before any tool is dispatched.
      // Calls are checked sequentially so we stop as soon as one trips,
      // avoiding unnecessary LLM-based guardrail work for later calls.
      if (this.#toolGuardrails.length > 0) {
        for (const call of pendingCalls) {
          const toolTripwire = await runToolGuardrails(
            this.#toolGuardrails,
            call.name,
            call.input,
            {
              originalTask: task,
              proposedAction: `Call tool "${call.name}" with args: ${JSON.stringify(call.input)}`,
            }
          );
          if (toolTripwire) {
            yield {
              traceId,
              parentTraceId,
              channel: "status",
              event: "guardrail_tripwire",
              data: {
                guardrailName: toolTripwire.guardrailName,
                layer: "tool" as const,
                toolName: call.name,
                ...(toolTripwire.result.metadata ? { metadata: toolTripwire.result.metadata } : {}),
              },
              timestampMs: Date.now(),
            };
            yield {
              traceId,
              parentTraceId,
              channel: "text",
              event: "error",
              data: {
                error: `Tool guardrail "${toolTripwire.guardrailName}" blocked tool "${call.name}"`,
                step,
              },
              timestampMs: Date.now(),
            };
            return;
          }
        }
      }

      // C1: per-tool human approval (needsApproval).
      // Check each pending call; if any tool requires approval, pause and wait.
      if (this.#checkpointer) {
        for (const call of pendingCalls) {
          const toolDef = this.#tools.get(call.name);
          if (!toolDef?.needsApproval) continue;
          const needs =
            typeof toolDef.needsApproval === "function"
              ? await toolDef.needsApproval(call.input as never)
              : toolDef.needsApproval;
          if (!needs) continue;

          const promptId = `approval-${call.id}`;
          const prompt = `Approve execution of tool "${call.name}" with args: ${JSON.stringify(call.input)}?`;

          // Save checkpoint so caller can resume after providing response.
          await this.#checkpointer.save(traceId, {
            traceId,
            task,
            history: [],
            stepIndex: step,
            savedAtMs: Date.now(),
            pendingHumanInput: { promptId, prompt },
            agentConfig,
          });

          yield {
            traceId,
            parentTraceId,
            channel: "status",
            event: "await_human_input",
            data: { promptId, prompt, step },
            timestampMs: Date.now(),
          };

          // Poll for response.
          let approved = false;
          for (let poll = 0; poll < 600; poll++) {
            await new Promise<void>((r) => setTimeout(r, 100));
            const snapshot = await this.#checkpointer.load(traceId);
            if (snapshot?.humanResponse?.promptId === promptId) {
              const resp = snapshot.humanResponse.response.trim().toLowerCase();
              approved =
                resp === "yes" || resp === "y" || resp === "approve" || resp === "approved";
              await this.#checkpointer.delete(traceId);
              break;
            }
          }

          if (!approved) {
            yield {
              traceId,
              parentTraceId,
              channel: "text",
              event: "error",
              data: { error: `Tool "${call.name}" execution denied by human reviewer`, step },
              timestampMs: Date.now(),
            };
            return;
          }
        }
      }

      // A1: build DAG IR and execute via Scheduler when scheduler="dag" (default).
      // Falls back to Promise.all when scheduler="parallel".
      const resolvedCalls: ParallelToolUseCall[] = [];

      if (this.#schedulerMode === "dag") {
        // Map tool_use blocks to IRNode[] using readOnly/idempotent from ToolDefinition.
        // Derive dependsOn edges from $<callId> placeholder references in call inputs.
        const depMap = deriveDependencies(pendingCalls.map((c) => ({ id: c.id, input: c.input })));
        const nodes: IRNode[] = pendingCalls.map((call) => {
          const toolDef = this.#tools.get(call.name);
          // A4: resolve resourceKey (may be a function of input).
          let resourceKey: string | undefined;
          if (toolDef?.resourceKey) {
            resourceKey =
              typeof toolDef.resourceKey === "function"
                ? toolDef.resourceKey(call.input as never)
                : toolDef.resourceKey;
          }
          return {
            id: call.id,
            toolName: call.name,
            args: call.input,
            dependsOn: depMap.get(call.id) ?? [],
            readOnly: toolDef?.readOnly ?? false,
            idempotent: toolDef?.idempotent ?? false,
            ...(resourceKey ? { resourceKey } : {}),
          };
        });
        const ir = new SimpleIR(nodes);
        const scheduler = new Scheduler(this.#tools);

        // Collect results from scheduler events, mapping node_done/node_error back
        // to resolvedCalls in the same order as pendingCalls.
        const resultMap = new Map<
          string,
          { output: string; isError: boolean; isUntrusted: boolean }
        >();
        for await (const evt of scheduler.execute(ir)) {
          if (evt.type === "node_done") {
            const toolResult = evt.result as import("../tools/types.js").ToolResult;
            let output: string;
            let isError = false;
            const isUntrusted = toolResult?.trust === "untrusted";
            if (toolResult?.error !== undefined) {
              isError = true;
              output = toolResult.error.message || "Tool execution failed with no output.";
            } else {
              try {
                output =
                  toolResult?.output === undefined ? "null" : JSON.stringify(toolResult.output);
              } catch (e) {
                isError = true;
                output = `Tool output could not be serialised: ${e instanceof Error ? e.message : String(e)}`;
              }
            }
            resultMap.set(evt.nodeId, { output, isError, isUntrusted });
          } else if (evt.type === "node_error") {
            const reason = evt.error;
            resultMap.set(evt.nodeId, {
              output: `Tool dispatch threw: ${reason instanceof Error ? reason.message : String(reason ?? "unknown error")}`,
              isError: true,
              isUntrusted: false,
            });
          }
        }

        for (const call of pendingCalls) {
          const res = resultMap.get(call.id) ?? {
            output: "Tool execution failed with no output.",
            isError: true,
            isUntrusted: false,
          };
          yield {
            traceId,
            parentTraceId,
            channel: "tool",
            event: "tool_result",
            data: res.isError
              ? {
                  callId: call.id,
                  toolName: call.name,
                  output: null as unknown,
                  error: { code: "execution_error" as const, message: res.output },
                  batchId,
                  batchSize,
                  stepIndex: step,
                }
              : {
                  callId: call.id,
                  toolName: call.name,
                  output: (() => {
                    try {
                      return JSON.parse(res.output);
                    } catch {
                      return res.output;
                    }
                  })(),
                  batchId,
                  batchSize,
                  stepIndex: step,
                },
            timestampMs: Date.now(),
          };
          // 2026-06-18 (axis 9, L1) — surface tool fallbacks on failure.
          // The framework offers candidates the registry says are
          // alternatives to the failed tool; the model picks. See
          // emitFallbacksIfAny for the cap/dedupe rules.
          if (res.isError) {
            yield* this.#emitFallbacksIfAny(call.name, res.output, traceId, parentTraceId, step);
          }
          // F2: action_completed — outcome for frontend/observability dashboards.
          yield {
            traceId,
            parentTraceId,
            channel: "action",
            event: "action_completed",
            data: {
              actionId: call.id,
              durationMs: 0, // caller can compute from action_executing.startedAtMs
              success: !res.isError,
              ...(res.isError ? { error: res.output } : {}),
            },
            timestampMs: Date.now(),
          };
          resolvedCalls.push({
            toolCallId: call.id,
            toolName: call.name,
            toolInput: call.input,
            toolOutput: res.isError
              ? this.#augmentErrorWithFallbacks(call.name, res.output)
              : res.output,
            isError: res.isError,
            ...(res.isUntrusted ? { isUntrusted: true } : {}),
          });
        }
      } else {
        // "parallel" mode: original Promise.all path.
        const handles = pendingCalls.map((call) => {
          let callIsError = false;
          let callIsUntrusted = false;
          const signal = this.#toolTimeoutMs ? AbortSignal.timeout(this.#toolTimeoutMs) : undefined;
          const settled = this.#tools
            .call({
              toolName: call.name,
              args: call.input,
              callId: call.id,
              ...(signal ? { signal } : {}),
            })
            .then(
              (r) => {
                if (r.trust === "untrusted") callIsUntrusted = true;
                if (r.error !== undefined) {
                  callIsError = true;
                  return r.error.message || "Tool execution failed with no output.";
                }
                try {
                  return r.output === undefined ? "null" : JSON.stringify(r.output);
                } catch (e) {
                  callIsError = true;
                  return `Tool output could not be serialised: ${e instanceof Error ? e.message : String(e)}`;
                }
              },
              (e) => {
                callIsError = true;
                return `Tool dispatch threw: ${e instanceof Error ? e.message : String(e)}`;
              }
            );
          const handle = LazyObservationHandle.fromToolResult(settled);
          return {
            call,
            handle,
            getIsError: () => callIsError,
            getIsUntrusted: () => callIsUntrusted,
          };
        });

        const outputs = await Promise.all(handles.map((h) => h.handle.resolve()));
        for (let i = 0; i < handles.length; i++) {
          const { call, getIsError, getIsUntrusted } = handles[i] as (typeof handles)[number];
          const toolOutput = outputs[i] as string;
          const isError = getIsError();
          const isUntrusted = getIsUntrusted();
          yield {
            traceId,
            parentTraceId,
            channel: "tool",
            event: "tool_result",
            data: isError
              ? {
                  callId: call.id,
                  toolName: call.name,
                  output: null as unknown,
                  error: { code: "execution_error" as const, message: toolOutput },
                  batchId,
                  batchSize,
                  stepIndex: step,
                }
              : {
                  callId: call.id,
                  toolName: call.name,
                  output: (() => {
                    try {
                      return JSON.parse(toolOutput);
                    } catch {
                      return toolOutput;
                    }
                  })(),
                  batchId,
                  batchSize,
                  stepIndex: step,
                },
            timestampMs: Date.now(),
          };
          // 2026-06-18 (axis 9, L1) — surface tool fallbacks on failure
          // (parallel-batch path; see the early-return path above).
          if (isError) {
            yield* this.#emitFallbacksIfAny(call.name, toolOutput, traceId, parentTraceId, step);
          }
          resolvedCalls.push({
            toolCallId: call.id,
            toolName: call.name,
            toolInput: call.input,
            toolOutput: isError
              ? this.#augmentErrorWithFallbacks(call.name, toolOutput)
              : toolOutput,
            isError,
            ...(isUntrusted ? { isUntrusted: true } : {}),
          });
        }
      }

      // Store in history: single call → ToolUseStep (backward compat);
      // multiple calls → ParallelToolUseStep (correct Anthropic multi-turn format).
      if (resolvedCalls.length === 1) {
        const c = resolvedCalls[0] as ParallelToolUseCall;
        const singleStep: ToolUseStep = {
          type: "tool_use",
          stepIndex: step,
          thoughts: fullText.trim(),
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          toolInput: c.toolInput,
          toolOutput: c.toolOutput,
          isError: c.isError,
          ...(c.isUntrusted ? { isUntrusted: true } : {}),
        };
        this.#assembler.addStep(singleStep);
      } else {
        const parallelStep: ParallelToolUseStep = {
          type: "parallel_tool_use",
          stepIndex: step,
          thoughts: fullText.trim(),
          calls: resolvedCalls,
        };
        this.#assembler.addStep(parallelStep);
      }
      // C2: record call fingerprints for noProgress detection.
      callHistory.push(resolvedCalls.map((c) => callFingerprint(c.toolName, c.toolInput)));
    }

    yield {
      traceId,
      parentTraceId,
      channel: "text",
      event: "error",
      data: { error: `Reached max steps (${this.#maxSteps}) without final answer` },
      timestampMs: Date.now(),
    };
  }

  async *#runPlanningStep(
    traceId: string,
    parentTraceId: string | null,
    step: number,
    budget: TokenBudget
  ): AsyncGenerator<AgentEvent> {
    yield* runPlanningStep(traceId, parentTraceId, step, this.#model, this.#assembler, budget);
  }

  // ── 2026-06-18 (axis 9, L1 — adaptive execution) ───────────────────────────
  // Two helpers that surface tool fallbacks on failure. Capped at 3
  // candidates per failure (token-budget hygiene from RFC §"Open
  // questions" #2). The framework does NOT auto-call the alternative —
  // it just makes them visible so the model can pick. See
  // `docs/strategy/2026-06-18-adaptive-execution.md`.

  #FALLBACK_CAP = 3;

  /** Emit a `tool_fallback_offered` event when the failed tool has alternatives. */
  async *#emitFallbacksIfAny(
    failedTool: string,
    errorMessage: string,
    traceId: string,
    parentTraceId: string | null,
    step: number
  ): AsyncGenerator<AgentEvent> {
    const candidates = this.#tools.fallbacksFor(failedTool).slice(0, this.#FALLBACK_CAP);
    if (candidates.length === 0) return;
    yield {
      traceId,
      parentTraceId,
      channel: "tool",
      event: "tool_fallback_offered",
      data: {
        failedTool,
        error: errorMessage,
        candidates: candidates.map((c) => ({ name: c.name, description: c.description })),
        stepIndex: step,
      },
      timestampMs: Date.now(),
    };
  }

  /**
   * Augment the failing tool_result string the model sees with a brief
   * fallback hint listing registered alternatives. The model still
   * decides what to do; this just removes the "did it occur to you to
   * check the registry?" failure mode for small models.
   */
  #augmentErrorWithFallbacks(failedTool: string, errorOutput: string): string {
    const candidates = this.#tools.fallbacksFor(failedTool).slice(0, this.#FALLBACK_CAP);
    // 2026-06-18 (axis 9, L2) — when synthesis is enabled, even a failing
    // tool with NO registered alternatives gets a hint pointing at the
    // synthesis substrate. Without this, L1+L2 don't compose: a tool
    // with empty `alternatives` would silently bypass the synthesis path.
    if (candidates.length === 0) {
      if (!this.#synthesisCodeTool) return errorOutput;
      return `${errorOutput}\n\n[framework hint] No registered alternatives to ${failedTool}. You may use \`${this.#synthesisCodeTool}\` to synthesise a one-off, or retry ${failedTool} with different args.`;
    }
    const lines = candidates.map((c) => `- ${c.name}: ${c.description}`).join("\n");
    const synthesisOption = this.#synthesisCodeTool
      ? `, or use \`${this.#synthesisCodeTool}\` to synthesise a one-off`
      : "";
    return `${errorOutput}\n\n[framework hint] The registry lists these alternatives to ${failedTool} — you may try one, retry ${failedTool} with different args${synthesisOption}:\n${lines}`;
  }
}
