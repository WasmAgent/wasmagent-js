import { randomUUID } from "node:crypto";
import { MessageAssembler } from "../memory/MessageAssembler.js";
import { LazyObservationHandle } from "../memory/LazyObservationHandle.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { Model } from "../models/types.js";
import type {
  AgentEvent,
  FinalAnswerStep,
  ParallelToolUseCall,
  ParallelToolUseStep,
  PlanningStep,
  ToolUseStep,
  UserMessageStep,
} from "../types/events.js";

const DEFAULT_SYSTEM_PROMPT = `You are an expert assistant. Use the provided tools to answer questions.
When you have a final answer, respond with plain text (no tool call).`;

const PLANNING_PROMPT = `Based on the task and observations so far, provide:
1. A structured plan for remaining steps (inside <plan>...</plan> tags)
2. Key facts established so far (inside <facts>...</facts> tags)`;

export interface ToolCallingAgentOptions {
  tools: ToolDefinition[];
  model: Model;
  maxSteps?: number;
  /** Emit a planning step every N action steps (mirrors CodeAgent planningInterval). */
  planningInterval?: number;
  systemPrompt?: string;
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

  constructor(opts: ToolCallingAgentOptions) {
    this.#tools = new ToolRegistry();
    for (const tool of opts.tools) {
      this.#tools.register(tool);
    }
    this.#model = opts.model;
    this.#maxSteps = opts.maxSteps ?? 20;
    this.#planningInterval = opts.planningInterval;
    this.#assembler = new MessageAssembler({
      systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      toolsSchema: this.#tools.toJsonSchema(),
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

    for (let step = 1; step <= this.#maxSteps; step++) {
      if (this.#planningInterval && step > 1 && (step - 1) % this.#planningInterval === 0) {
        yield* this.#runPlanningStep(traceId, parentTraceId, step);
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

      for await (const event of this.#model.generate(messages, {
        stream: true,
        tools: this.#tools.toJsonSchema(),
      })) {
        if (event.type === "text_delta" && event.delta) {
          fullText += event.delta;
        } else if (event.type === "tool_call" && event.toolCall) {
          pendingCalls.push({
            id: event.toolCall.id,
            name: event.toolCall.name,
            input: event.toolCall.input,
          });
        }
      }

      // No tool calls → model responded with text — treat as final answer.
      if (pendingCalls.length === 0) {
        const answer = fullText.trim() || "No answer provided";
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

      // B3: dispatch ALL calls in parallel immediately using LazyObservationHandle.
      // Carry isError as a separate boolean so it is never inferred from string
      // content — startsWith("Error: ") would silently misclassify tools whose
      // successful output happens to start with that prefix.
      const handles = pendingCalls.map((call) => {
        let callIsError = false;
        const handle = LazyObservationHandle.fromToolResult(
          this.#tools
            .call({ toolName: call.name, args: call.input, callId: call.id })
            .then((r) => {
              callIsError = r.error !== undefined;
              return callIsError
                ? (r.error!.message || "Tool execution failed with no output.")
                : JSON.stringify(r.output);
            })
        );
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
              output: null,
              error: { code: "execution_error" as const, message: toolOutput },
            }
          : {
              callId: call.id,
              toolName: call.name,
              output: (() => { try { return JSON.parse(toolOutput); } catch { return toolOutput; } })(),
              error: undefined,
            };

        yield {
          traceId,
          parentTraceId,
          channel: "tool",
          event: "tool_result",
          data: { ...resultData, batchId, batchSize, stepIndex: step },
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
    step: number
  ): AsyncGenerator<AgentEvent> {
    const planningMessages = this.#assembler.build();
    planningMessages.push({ role: "user", content: PLANNING_PROMPT });

    let planResponse = "";
    for await (const event of this.#model.generate(planningMessages, { stream: true })) {
      if (event.type === "text_delta" && event.delta) {
        planResponse += event.delta;
      }
    }

    const planMatch = /<plan>([\s\S]*?)<\/plan>/.exec(planResponse);
    const factsMatch = /<facts>([\s\S]*?)<\/facts>/.exec(planResponse);
    const plan = planMatch?.[1]?.trim() ?? planResponse;
    const facts = factsMatch?.[1]?.trim() ?? "";

    const planningStep: PlanningStep = { type: "planning", plan, facts };
    this.#assembler.addStep(planningStep);

    yield {
      traceId,
      parentTraceId,
      channel: "thinking",
      event: "planning",
      data: { step, plan, facts },
      timestampMs: Date.now(),
    };
  }
}
