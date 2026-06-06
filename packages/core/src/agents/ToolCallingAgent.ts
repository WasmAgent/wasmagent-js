import { randomUUID } from "node:crypto";
import { MessageAssembler } from "../memory/MessageAssembler.js";
import { LazyObservationHandle } from "../memory/LazyObservationHandle.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { Model } from "../models/types.js";
import type { AgentEvent, FinalAnswerStep, PlanningStep, ToolUseStep, UserMessageStep } from "../types/events.js";

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
 * Mirrors smolagents' ToolCallingAgent: each step the model decides which
 * tool to invoke (via native tool_use), the agent executes it, and the
 * observation is fed back as a tool_result content block in the next turn.
 *
 * The conversation history is stored as ToolUseStep pairs so MessageAssembler
 * produces the correct assistant[tool_use] + user[tool_result] multi-turn
 * format required by the Anthropic and OpenAI tool APIs.
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
      // Emit a planning step at configured interval.
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
      let toolCallId: string | undefined;
      let toolCallName: string | undefined;
      let toolCallInput: Record<string, unknown> | undefined;

      for await (const event of this.#model.generate(messages, {
        stream: true,
        tools: this.#tools.toJsonSchema(),
      })) {
        if (event.type === "text_delta" && event.delta) {
          fullText += event.delta;
        } else if (event.type === "tool_call" && event.toolCall) {
          toolCallId = event.toolCall.id;
          toolCallName = event.toolCall.name;
          toolCallInput = event.toolCall.input;
        }
      }

      // No tool call → model responded with text — treat as final answer.
      if (!toolCallName || !toolCallId) {
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

      yield {
        traceId,
        parentTraceId,
        channel: "tool",
        event: "tool_call",
        data: { toolName: toolCallName, args: toolCallInput, callId: toolCallId },
        timestampMs: Date.now(),
      };

      // B3: use a LazyObservationHandle for readOnly tools — the call is
      // dispatched immediately and the handle is awaited only when needed.
      // For non-readOnly tools we await inline (side-effects must complete
      // before the agent proceeds).
      const toolDef = this.#tools.get(toolCallName);
      const isReadOnly = toolDef?.readOnly === true;

      const observationHandle = LazyObservationHandle.fromToolResult(
        this.#tools
          .call({ toolName: toolCallName, args: toolCallInput ?? {}, callId: toolCallId })
          .then((r) => {
            const err = r.error !== undefined;
            return err ? `Error: ${r.error!.message}` : JSON.stringify(r.output);
          })
      );

      // For non-readOnly tools, block until complete before the next model call.
      if (!isReadOnly) {
        await observationHandle.resolve();
      }

      const toolOutput = await observationHandle.resolve();
      const isError = toolOutput.startsWith("Error: ");

      const toolResultData = isError
        ? { callId: toolCallId, toolName: toolCallName, output: null, error: { code: "execution_error", message: toolOutput.slice(7) } }
        : { callId: toolCallId, toolName: toolCallName, output: JSON.parse(toolOutput), error: undefined };

      yield {
        traceId,
        parentTraceId,
        channel: "tool",
        event: "tool_result",
        data: toolResultData,
        timestampMs: Date.now(),
      };

      const toolUseStep: ToolUseStep = {
        type: "tool_use",
        stepIndex: step,
        thoughts: fullText.trim(),
        toolCallId,
        toolName: toolCallName,
        toolInput: toolCallInput ?? {},
        toolOutput,
        isError,
      };
      this.#assembler.addStep(toolUseStep);
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
