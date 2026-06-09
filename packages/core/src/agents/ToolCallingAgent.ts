import { randomUUID } from "node:crypto";
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
  ParallelToolUseCall,
  ParallelToolUseStep,
  ToolUseStep,
  UserMessageStep,
} from "../types/events.js";
import { runPlanningStep, TOOL_DEP_INSTRUCTIONS } from "./prompts.js";
import type { StopCondition } from "./stopConditions.js";
import { callFingerprint } from "./stopConditions.js";

const DEFAULT_SYSTEM_PROMPT = `You are an expert assistant. Use the provided tools to answer questions.
When you have a final answer, respond with plain text (no tool call).
${TOOL_DEP_INSTRUCTIONS}`;

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
    this.#stopWhen = opts.stopWhen ?? [];
    this.#checkpointer = opts.checkpointer;
    this.#inputGuardrails = opts.inputGuardrails ?? [];
    this.#outputGuardrails = opts.outputGuardrails ?? [];
    this.#toolGuardrails = opts.toolGuardrails ?? [];
    this.#outputSchema = opts.outputSchema;
    this.#outputSchemaRetries = opts.outputSchemaRetries ?? 2;
    this.#toolsSchema = this.#tools.toJsonSchema();
    this.#assembler =
      opts.assembler ??
      new MessageAssembler({
        systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        toolsSchema: this.#toolsSchema,
      });
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
    const { signal } = opts;
    const traceId = `agent-${randomUUID()}`;

    yield {
      traceId,
      parentTraceId,
      channel: "text",
      event: "run_start",
      data: { task },
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
      yield {
        traceId,
        parentTraceId,
        channel: "model" as const,
        event: "model_done",
        data: {
          modelId: (this.#model as { modelId?: string }).modelId ?? "unknown",
          step,
          finishReason: "stop",
          inputTokens: stats.inputTokens,
          outputTokens: stats.outputTokens,
          cacheReadTokens: stats.cacheReadTokens,
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
          resolvedCalls.push({
            toolCallId: call.id,
            toolName: call.name,
            toolInput: call.input,
            toolOutput: res.output,
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
          const { call, getIsError, getIsUntrusted } = handles[i]!;
          const toolOutput = outputs[i]!;
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
          resolvedCalls.push({
            toolCallId: call.id,
            toolName: call.name,
            toolInput: call.input,
            toolOutput,
            isError,
            ...(isUntrusted ? { isUntrusted: true } : {}),
          });
        }
      }

      // Store in history: single call → ToolUseStep (backward compat);
      // multiple calls → ParallelToolUseStep (correct Anthropic multi-turn format).
      if (resolvedCalls.length === 1) {
        const c = resolvedCalls[0]!;
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
}
