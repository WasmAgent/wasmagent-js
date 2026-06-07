import { randomUUID } from "node:crypto";
import { MessageAssembler } from "../memory/MessageAssembler.js";
import { LazyObservationHandle } from "../memory/LazyObservationHandle.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { Model, EnhancementPolicy } from "../models/types.js";
import { TokenBudget } from "../models/types.js";
import { SelfConsistencyRunner } from "../enhancement/SelfConsistencyRunner.js";
import { ReflectRefineRunner } from "../enhancement/ReflectRefineRunner.js";
import { BudgetForcingRunner } from "../enhancement/BudgetForcingRunner.js";
import type { AgentEvent, FinalAnswerStep, ParallelToolUseCall, ParallelToolUseStep, ToolUseStep, UserMessageStep } from "../types/events.js";
import { runPlanningStep } from "./prompts.js";

const DEFAULT_SYSTEM_PROMPT = `You are an expert assistant. Use the provided tools to answer questions.
When you have a final answer, respond with plain text (no tool call).`;

export interface ToolCallingAgentOptions {
  tools: ToolDefinition[];
  model: Model;
  maxSteps?: number;
  /** Emit a planning step every N action steps (mirrors CodeAgent planningInterval). */
  planningInterval?: number;
  systemPrompt?: string;
  /** Optional enhancement policy — gates self-consistency, reflect-refine, budget limits (P1). */
  enhancementPolicy?: EnhancementPolicy;
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

  constructor(opts: ToolCallingAgentOptions) {
    this.#tools = new ToolRegistry();
    for (const tool of opts.tools) {
      this.#tools.register(tool);
    }
    this.#model = opts.model;
    this.#maxSteps = opts.maxSteps ?? opts.enhancementPolicy?.budget?.maxSteps ?? 20;
    this.#planningInterval = opts.planningInterval;
    this.#policy = opts.enhancementPolicy;
    this.#toolsSchema = this.#tools.toJsonSchema();
    this.#assembler = new MessageAssembler({
      systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      toolsSchema: this.#toolsSchema,
    });
  }

  async *run(
    task: string,
    parentTraceId: string | null = null
  ): AsyncGenerator<AgentEvent> {
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

    for (let step = 1; step <= this.#maxSteps; step++) {
      // P1: enforce ResourceBudget limits before each step.
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
          data: { error: `Time budget exhausted (${Date.now() - runStartMs}ms >= ${budgetMaxDurationMs}ms)` },
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

      for await (const event of this.#model.generate(messages, {
        stream: true,
        tools: this.#toolsSchema,
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

      if (!receivedUsage) {
        budget.estimateFallback(messages, fullText);
      }

      // No tool calls → model responded with text — treat as final answer.
      if (pendingCalls.length === 0) {
        let answer = fullText.trim() || "No answer provided";

        // Apply enhancement runners when configured.
        // Budget-forcing takes priority (requires model support), then reflect-refine,
        // then self-consistency. Runners run in isolated contexts — they do not mutate
        // the assembler history or the main token budget tracking here.
        const messages = this.#assembler.build();
        if (this.#policy?.budgetForcing?.enabled && this.#model.capabilities?.supportsBudgetForcing) {
          const result = await new BudgetForcingRunner().run(this.#model, messages);
          answer = result.answer || answer;
        } else if (this.#policy?.reflectRefine?.enabled) {
          const reflectOpts = this.#policy.reflectRefine.maxCycles !== undefined
            ? { maxCycles: this.#policy.reflectRefine.maxCycles }
            : {};
          const result = await new ReflectRefineRunner(reflectOpts).run(this.#model, messages);
          answer = result.answer || answer;
        } else if (this.#policy?.selfConsistency?.enabled) {
          const scOpts: { n?: number; earlyStopThreshold?: number } = {};
          if (this.#policy.selfConsistency.n !== undefined) scOpts.n = this.#policy.selfConsistency.n;
          if (this.#policy.selfConsistency.earlyStopThreshold !== undefined) {
            scOpts.earlyStopThreshold = this.#policy.selfConsistency.earlyStopThreshold;
          }
          const result = await new SelfConsistencyRunner(scOpts).run(this.#model, messages);
          answer = result.answer || answer;
        }

        const finalStep: FinalAnswerStep = { type: "final_answer", answer };
        this.#assembler.addStep(finalStep);
        yield {
          traceId,
          parentTraceId,
          channel: "text",
          event: "final_answer",
          data: { answer },
          timestampMs: Date.now(),
        };
        return;
      }

      // Q8: batchId groups tool_call / tool_result events that belong to the same
      // parallel dispatch (single model response with N tool_use blocks).
      // Consumers can use batchId to distinguish "show N loaders simultaneously"
      // (same batch) from "sequential steps" (different batchIds).
      // Single-call steps also get a batchId (batchSize=1) for uniform consumer logic.
      const batchId = randomUUID();
      const batchSize = pendingCalls.length;

      for (const call of pendingCalls) {
        yield {
          traceId,
          parentTraceId,
          channel: "tool",
          event: "tool_call",
          data: { toolName: call.name, args: call.input, callId: call.id, batchId, batchSize, stepIndex: step },
          timestampMs: Date.now(),
        };
      }

      // U1: emit status events before dispatching tool calls, rescuing TTFT.
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

      // B3: dispatch ALL calls in parallel immediately using LazyObservationHandle.
      // Carry isError as a separate boolean so it is never inferred from string
      // content — startsWith("Error: ") would silently misclassify tools whose
      // successful output happens to start with that prefix.
      // Each promise must never reject — unexpected throws (e.g. JSON.stringify on
      // circular references) are caught and turned into structured error strings so
      // Promise.all always settles and every tool_call gets a paired tool_result.
      const handles = pendingCalls.map((call) => {
        let callIsError = false;
        const settled = this.#tools
          .call({ toolName: call.name, args: call.input, callId: call.id })
          .then(
            (r) => {
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
        return { call, handle, getIsError: () => callIsError };
      });

      // Await all results in parallel — wall-clock = slowest single call.
      const outputs = await Promise.all(handles.map((h) => h.handle.resolve()));

      // Emit tool_result events and build resolved call records.
      const resolvedCalls: ParallelToolUseCall[] = [];
      for (let i = 0; i < handles.length; i++) {
        const { call, getIsError } = handles[i]!;
        const toolOutput = outputs[i]!;
        const isError = getIsError();

        const resultData = isError
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
              output: (() => { try { return JSON.parse(toolOutput); } catch { return toolOutput; } })(),
              batchId,
              batchSize,
              stepIndex: step,
            };

        yield {
          traceId,
          parentTraceId,
          channel: "tool",
          event: "tool_result",
          data: resultData,
          timestampMs: Date.now(),
        };

        resolvedCalls.push({
          toolCallId: call.id,
          toolName: call.name,
          toolInput: call.input,
          toolOutput,
          isError,
        });
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
