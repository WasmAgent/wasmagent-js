import { randomUUID } from "node:crypto";
import type { WasmKernel } from "../executor/types.js";
import { createKernel } from "../executor/factory.js";
import { MessageAssembler } from "../memory/MessageAssembler.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { Model, EnhancementPolicy } from "../models/types.js";
import { TokenBudget } from "../models/types.js";
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
  /** Action language for code execution. "js" (default). For Python, pass kernel directly. */
  actionLanguage?: "js";
  /**
   * Custom kernel instance. Use this to inject a PyodideKernel:
   *   import { PyodideKernel } from "@agentkit-js/kernel-pyodide";
   *   new CodeAgent({ kernel: new PyodideKernel(), ... })
   */
  kernel?: import("../executor/types.js").WasmKernel;
  systemPrompt?: string;
  /** Optional enhancement policy — gates budget limits (P1). */
  enhancementPolicy?: EnhancementPolicy;
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
  readonly #policy: EnhancementPolicy | undefined;

  constructor(opts: CodeAgentOptions) {
    this.#tools = new ToolRegistry();
    for (const tool of opts.tools) {
      this.#tools.register(tool);
    }
    this.#model = opts.model;
    this.#maxSteps = opts.maxSteps ?? 20;
    this.#planningInterval = opts.planningInterval;
    this.#policy = opts.enhancementPolicy;
    // D1: use provided kernel or create one via factory.
    // For PyodideKernel: import { PyodideKernel } from "@agentkit-js/kernel-pyodide"
    // and pass new PyodideKernel() as opts.kernel.
    this.#kernelPromise = opts.kernel
      ? Promise.resolve(opts.kernel)
      : createKernel({ engine: "js", actionLanguage: opts.actionLanguage ?? "js" });
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

    const budget = new TokenBudget();
    const budgetMaxTokens = this.#policy?.budget?.maxTokens;
    const runStartMs = Date.now();
    const budgetMaxDurationMs = this.#policy?.budget?.maxDurationMs;

    for (let step = 1; step <= this.#maxSteps; step++) {
      // P1: enforce ResourceBudget limits before each step.
      if (budgetMaxTokens && budget.total >= budgetMaxTokens) {
        yield {
          traceId, parentTraceId, channel: "text", event: "error",
          data: { error: `Token budget exhausted (${budget.total} >= ${budgetMaxTokens})` },
          timestampMs: Date.now(),
        };
        return;
      }
      if (budgetMaxDurationMs && Date.now() - runStartMs >= budgetMaxDurationMs) {
        yield {
          traceId, parentTraceId, channel: "text", event: "error",
          data: { error: `Time budget exhausted (${Date.now() - runStartMs}ms >= ${budgetMaxDurationMs}ms)` },
          timestampMs: Date.now(),
        };
        return;
      }

      // Emit a planning step at configured interval.
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
      let fullResponse = "";
      let receivedUsage = false;

      for await (const event of this.#model.generate(messages, {
        stream: true,
      })) {
        if (event.type === "text_delta" && event.delta) {
          fullResponse += event.delta;
          yield {
            traceId,
            parentTraceId,
            channel: "thinking",
            event: "thinking_delta",   // Q6: dedicated event for streaming token deltas
            data: { delta: event.delta, step },
            timestampMs: Date.now(),
          };
        } else if (event.type === "usage" && event.usage) {
          budget.recordUsage(event.usage);
          receivedUsage = true;
        }
      }

      if (!receivedUsage) {
        budget.estimateFallback(messages, fullResponse);
      }

      // Parse code from model response.
      const code = extractCode(fullResponse);
      if (!code) {
        // Check if the model already provided a final answer without code.
        const directAnswer = extractFinalAnswer(fullResponse);
        if (directAnswer) {
          yield* this.#emitFinalAnswer(traceId, parentTraceId, directAnswer);
          return;
        }
        // No code and no final answer — ask the model once more to produce code.
        const retryMessages = this.#assembler.build();
        retryMessages.push({
          role: "user",
          content: "Please provide your answer as executable JavaScript inside ```js ... ``` or set __finalAnswer__ = <value>.",
        });
        let retryResponse = "";
        let retryReceivedUsage = false;
        for await (const event of this.#model.generate(retryMessages, { stream: true })) {
          if (event.type === "text_delta" && event.delta) {
            retryResponse += event.delta;
          } else if (event.type === "usage" && event.usage) {
            budget.recordUsage(event.usage);
            retryReceivedUsage = true;
          }
        }
        if (!retryReceivedUsage) budget.estimateFallback(retryMessages, retryResponse);
        const retryCode = extractCode(retryResponse);
        if (retryCode) {
          // Use the retry code for kernel execution below.
          fullResponse = retryResponse;
        } else {
          yield* this.#emitFinalAnswer(traceId, parentTraceId, extractFinalAnswer(retryResponse) ?? retryResponse);
          return;
        }
      }

      // Execute code in the kernel (A1 stateful execution).
      const codeToRun = extractCode(fullResponse)!;
      let kernelResult;
      try {
        kernelResult = await kernel.run(codeToRun);
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
        return;
      }

      const stepRecord: ActionStep = {
        type: "action",
        stepIndex: step,
        thoughts: extractThoughts(fullResponse),
        code: codeToRun,
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
    step: number,
    budget: TokenBudget
  ): AsyncGenerator<AgentEvent> {
    const planningMessages = this.#assembler.build();
    planningMessages.push({ role: "user", content: PLANNING_PROMPT });

    let planResponse = "";
    let planReceivedUsage = false;
    for await (const event of this.#model.generate(planningMessages, { stream: true })) {
      if (event.type === "text_delta" && event.delta) {
        planResponse += event.delta;
      } else if (event.type === "usage" && event.usage) {
        budget.recordUsage(event.usage);
        planReceivedUsage = true;
      }
    }
    if (!planReceivedUsage) budget.estimateFallback(planningMessages, planResponse);

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
  const match = /^\s*final answer\s*[:=]\s*(.+)/im.exec(response);
  return match?.[1]?.trim() ?? null;
}
