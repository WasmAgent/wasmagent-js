import { randomUUID } from "node:crypto";
import type { WasmKernel } from "../executor/types.js";
import { createKernel } from "../executor/factory.js";
import { MessageAssembler } from "../memory/MessageAssembler.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { Model } from "../models/types.js";
import type { AgentEvent, ActionStep, PlanningStep, FinalAnswerStep } from "../types/events.js";

const DEFAULT_SYSTEM_PROMPT = `You are an expert assistant who can solve any task using code.
To solve the task, you must plan forward to proceed in a series of steps.
Think about the current step to be executed, then generate the JS code to perform it.

To signal a final answer, set: __finalAnswer__ = <your answer>;

Code output is available as the return value of your code block.`;

const PLANNING_PROMPT = `Based on the task and observations so far, provide:
1. A structured plan for remaining steps (inside <plan>...</plan> tags)
2. Key facts established so far (inside <facts>...</facts> tags)`;

export interface CodeAgentOptions {
  tools: ToolDefinition[];
  model: Model;
  maxSteps?: number;
  planningInterval?: number;
  /** Default: 'js'. See D1 spike for 'micropython' and 'pyodide'. */
  actionLanguage?: "js" | "micropython" | "pyodide";
  systemPrompt?: string;
}

/**
 * CodeAgent (D5) — TypeScript equivalent of smolagents' CodeAgent.
 *
 * Constructor signature is intentionally close to smolagents:
 *   new CodeAgent({ tools, model, maxSteps, planningInterval })
 *
 * Differences from smolagents baseline:
 *  - Fully async streaming (AsyncGenerator<AgentEvent>)
 *  - Cache-friendly message assembly (B1)
 *  - Structured streaming events with traceId (C1)
 *  - Typed tools with side-effect metadata (D2)
 *  - Planning steps at configurable interval
 */
export class CodeAgent {
  readonly #tools: ToolRegistry;
  readonly #model: Model;
  readonly #maxSteps: number;
  readonly #planningInterval: number | undefined;
  readonly #kernelPromise: Promise<WasmKernel>;
  readonly #assembler: MessageAssembler;

  constructor(opts: CodeAgentOptions) {
    this.#tools = new ToolRegistry();
    for (const tool of opts.tools) {
      this.#tools.register(tool);
    }
    this.#model = opts.model;
    this.#maxSteps = opts.maxSteps ?? 20;
    this.#planningInterval = opts.planningInterval;
    // D1: route to the right kernel engine based on actionLanguage.
    this.#kernelPromise = createKernel({
      engine: "js",
      actionLanguage: opts.actionLanguage ?? "js",
    });
    this.#assembler = new MessageAssembler({
      systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      toolsSchema: this.#tools.toJsonSchema(),
    });
  }

  /**
   * Run the agent on a task, yielding structured events (C1 traceId contract).
   *
   * Equivalent to smolagents' MultiStepAgent._run_stream (agents.py:540)
   * but async, streaming, and with per-event tracing metadata.
   */
  async *run(
    task: string,
    parentTraceId: string | null = null
  ): AsyncGenerator<AgentEvent> {
    const traceId = `agent-${randomUUID()}`;
    const kernel = await this.#kernelPromise;

    yield {
      traceId,
      parentTraceId,
      channel: "text",
      event: "run_start",
      data: { task },
      timestampMs: Date.now(),
    };

    this.#assembler.reset();
    this.#assembler.addStep({
      type: "action",
      stepIndex: 0,
      thoughts: `Task: ${task}`,
      code: "",
      observations: "",
    });

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
      let fullResponse = "";

      for await (const event of this.#model.generate(messages, {
        stream: true,
      })) {
        if (event.type === "text_delta" && event.delta) {
          fullResponse += event.delta;
          yield {
            traceId,
            parentTraceId,
            channel: "thinking",
            event: "step_start",
            data: { delta: event.delta },
            timestampMs: Date.now(),
          };
        }
      }

      // Parse code from model response.
      const code = extractCode(fullResponse);
      if (!code) {
        // No code generated — treat as final answer.
        const answer = extractFinalAnswer(fullResponse) ?? fullResponse;
        yield* this.#emitFinalAnswer(traceId, parentTraceId, answer);
        return;
      }

      // Execute code in the kernel (A1 stateful execution).
      let kernelResult;
      try {
        kernelResult = await kernel.run(code);
      } catch (err) {
        yield {
          traceId,
          parentTraceId,
          channel: "text",
          event: "error",
          data: {
            step,
            error: err instanceof Error ? err.message : String(err),
          },
          timestampMs: Date.now(),
        };
        break;
      }

      const stepRecord: ActionStep = {
        type: "action",
        stepIndex: step,
        thoughts: extractThoughts(fullResponse),
        code,
        observations: String(kernelResult.output ?? kernelResult.logs.join("\n")),
      };
      this.#assembler.addStep(stepRecord);

      if (kernelResult.isFinalAnswer) {
        yield* this.#emitFinalAnswer(traceId, parentTraceId, kernelResult.output);
        return;
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

    const plan = extractTagContent(planResponse, "plan") ?? planResponse;
    const facts = extractTagContent(planResponse, "facts") ?? "";

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

  async *#emitFinalAnswer(
    traceId: string,
    parentTraceId: string | null,
    answer: unknown
  ): AsyncGenerator<AgentEvent> {
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
  }
}

function extractCode(response: string): string | null {
  const match = /<code>([\s\S]*?)<\/code>/.exec(response) ??
    /```(?:js|javascript)?\n([\s\S]*?)```/.exec(response);
  return match?.[1]?.trim() ?? null;
}

function extractThoughts(response: string): string {
  return extractTagContent(response, "thoughts") ?? "";
}

function extractTagContent(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(text);
  return match?.[1]?.trim() ?? null;
}

function extractFinalAnswer(response: string): string | null {
  const match = /(?:final answer|answer)[:\s]+(.+)/i.exec(response);
  return match?.[1]?.trim() ?? null;
}
