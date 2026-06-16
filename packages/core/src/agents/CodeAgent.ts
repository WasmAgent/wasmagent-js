import { randomUUID } from "../util/runtime.js";
import { BudgetForcingRunner } from "../enhancement/BudgetForcingRunner.js";
import { ParallelForkJoinRunner } from "../enhancement/ParallelForkJoinRunner.js";
import { ReflectRefineRunner } from "../enhancement/ReflectRefineRunner.js";
import { SelfConsistencyRunner } from "../enhancement/SelfConsistencyRunner.js";
import {
  buildFixRetryMessage,
  classifyExecutionError,
  ErrorRecoveryStrategy,
  MAX_REFINEMENT_STEPS,
} from "../executor/ErrorClassifier.js";
import { createKernel } from "../executor/factory.js";
import type { KernelResult, WasmKernel } from "../executor/types.js";
import type { InputGuardrail, OutputGuardrail } from "../guardrails/index.js";
import { runInputGuardrails, runOutputGuardrails } from "../guardrails/index.js";
import { MessageAssembler } from "../memory/MessageAssembler.js";
import type { EnhancementPolicy, Model } from "../models/types.js";
import { TokenBudget } from "../models/types.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { ActionStep, AgentEvent, FinalAnswerStep } from "../types/events.js";
import { extractTagContent, runPlanningStep } from "./prompts.js";

const DEFAULT_SYSTEM_PROMPT = `You are an expert assistant who solves tasks using code.
When given a task, immediately write executable JavaScript code to solve it.
Do not ask clarifying questions. Do not introduce yourself. Just solve the task with code.

To signal a final answer, set: __finalAnswer__ = <your answer>;

Code output is available as the return value of your code block.`;

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
  /** Inject a pre-configured MessageAssembler (e.g. for compaction tests or custom chunking). */
  assembler?: MessageAssembler;
  /**
   * S3: Input guardrails run before the agent accepts the task.
   * Also used for code scanning — add codeGuardrail() to scan generated code pre-execution.
   */
  inputGuardrails?: InputGuardrail[];
  /**
   * S3: Output guardrails run before the final_answer event is emitted.
   */
  outputGuardrails?: OutputGuardrail[];
  /**
   * S3: Input guardrails that are applied specifically to generated code before kernel execution.
   * Use codeGuardrail() here to block dangerous patterns.
   */
  codeGuardrails?: InputGuardrail[];
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
  readonly #inputGuardrails: InputGuardrail[];
  readonly #outputGuardrails: OutputGuardrail[];
  readonly #codeGuardrails: InputGuardrail[];

  constructor(opts: CodeAgentOptions) {
    this.#tools = new ToolRegistry();
    for (const tool of opts.tools) {
      this.#tools.register(tool);
    }
    this.#model = opts.model;
    this.#maxSteps = opts.maxSteps ?? opts.enhancementPolicy?.budget?.maxSteps ?? 20;
    this.#planningInterval = opts.planningInterval;
    this.#policy = opts.enhancementPolicy;
    this.#inputGuardrails = opts.inputGuardrails ?? [];
    this.#outputGuardrails = opts.outputGuardrails ?? [];
    this.#codeGuardrails = opts.codeGuardrails ?? [];
    // D1: use provided kernel or create one via factory.
    this.#kernelPromise = opts.kernel
      ? Promise.resolve(opts.kernel)
      : createKernel({ engine: "js", actionLanguage: opts.actionLanguage ?? "js" });
    this.#assembler =
      opts.assembler ??
      new MessageAssembler({
        systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        toolsSchema: this.#tools.toJsonSchema(),
      });
  }

  /** Read-only access to the underlying MessageAssembler for compaction. */
  get assembler(): MessageAssembler {
    return this.#assembler;
  }

  /**
   * Run the agent on a task, yielding structured events (C1 traceId contract).
   *
   * Equivalent to smolagents' MultiStepAgent._run_stream (agents.py:540)
   * but async, streaming, and with per-event tracing metadata.
   */
  async *run(task: string, parentTraceId: string | null = null): AsyncGenerator<AgentEvent> {
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
    // Use a user_message step so the task appears as the first user-role message,
    // giving the model a clear instruction to respond to with code.
    this.#assembler.addStep({ type: "user_message", content: task });

    // S3: input guardrail check on the task before any model call.
    if (this.#inputGuardrails.length > 0) {
      const inputTripwire = await runInputGuardrails(
        this.#inputGuardrails,
        task,
        this.#assembler.build()
      );
      if (inputTripwire) {
        yield {
          traceId,
          parentTraceId,
          channel: "status",
          event: "guardrail_tripwire",
          data: {
            guardrailName: inputTripwire.guardrailName,
            layer: "input" as const,
            ...(inputTripwire.result.metadata ? { metadata: inputTripwire.result.metadata } : {}),
          },
          timestampMs: Date.now(),
        };
        yield {
          traceId,
          parentTraceId,
          channel: "text",
          event: "error",
          data: { error: `Input guardrail "${inputTripwire.guardrailName}" triggered` },
          timestampMs: Date.now(),
        };
        return;
      }
    }

    const budget = new TokenBudget();
    const budgetMaxTokens = this.#policy?.budget?.maxTokens;
    const runStartMs = Date.now();
    const budgetMaxDurationMs = this.#policy?.budget?.maxDurationMs;

    for (let step = 1; step <= this.#maxSteps; step++) {
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

      try {
        for await (const event of this.#model.generate(messages, {
          stream: true,
        })) {
          if (event.type === "text_delta" && event.delta) {
            fullResponse += event.delta;
            yield {
              traceId,
              parentTraceId,
              channel: "thinking",
              event: "thinking_delta", // Q6: dedicated event for streaming token deltas
              data: { delta: event.delta, step },
              timestampMs: Date.now(),
            };
          } else if (event.type === "usage" && event.usage) {
            budget.recordUsage(event.usage);
            receivedUsage = true;
          }
        }
      } catch (err) {
        yield {
          traceId,
          parentTraceId,
          channel: "text",
          event: "error",
          data: {
            error: `Model generation failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          timestampMs: Date.now(),
        };
        return;
      }

      if (!receivedUsage) {
        budget.estimateFallback(messages, fullResponse);
      }

      // Emit model_done so the frontend TokenMeter can display live token stats.
      const stats = budget.toStats();
      const modelId = (this.#model as { modelId?: string }).modelId ?? "unknown";
      yield {
        traceId,
        parentTraceId,
        channel: "model",
        event: "model_done",
        data: {
          modelId,
          step,
          finishReason: "stop",
          inputTokens: stats.inputTokens,
          outputTokens: stats.outputTokens,
          cacheReadTokens: stats.cacheReadTokens,
          cacheHitRate: budget.cacheHitRate,
          estimatedUsd: budget.estimatedUsdFor(modelId),
          calls: stats.calls,
        },
        timestampMs: Date.now(),
      };

      // Parse code from model response.
      const code = extractCode(fullResponse);
      if (!code) {
        // Check if the model already provided a final answer without code.
        const directAnswer = extractFinalAnswer(fullResponse);
        if (directAnswer) {
          yield* this.#emitFinalAnswer(traceId, parentTraceId, directAnswer);
          return;
        }
        // After the first step, a prose-only response (no code, no explicit marker) means
        // the model has finished — treat it as the final answer rather than retrying.
        // This handles cases like large file generation where the model writes code via
        // a write_file tool call and then summarises in plain text.
        if (step > 1 && isProseSummary(fullResponse)) {
          yield* this.#emitFinalAnswer(traceId, parentTraceId, fullResponse.trim());
          return;
        }
        // No code and no final answer — ask the model once more to produce code.
        // GPT-Engineer pattern: provide structured error context in retry, not just a generic prompt.
        // This gives the model specific information about what was missing, improving retry success.
        const isPython =
          this.#assembler.build()[0]?.content?.toString().includes("Python") ?? false;
        const langHint = isPython
          ? "Please provide your answer as executable Python inside ```python ... ``` or set __finalAnswer__ = <value>."
          : "Please provide your answer as executable JavaScript inside ```js ... ``` or set __finalAnswer__ = <value>.";
        const previousResponseSnippet =
          fullResponse.length > 0
            ? `\n\nYour previous response did not contain a code block:\n---\n${fullResponse.slice(0, 300)}\n---`
            : "";
        const retryMessages = this.#assembler.build();
        retryMessages.push({ role: "user", content: `${langHint}${previousResponseSnippet}` });
        let retryResponse = "";
        let retryReceivedUsage = false;
        try {
          for await (const event of this.#model.generate(retryMessages, { stream: true })) {
            if (event.type === "text_delta" && event.delta) {
              retryResponse += event.delta;
            } else if (event.type === "usage" && event.usage) {
              budget.recordUsage(event.usage);
              retryReceivedUsage = true;
            }
          }
        } catch (err) {
          yield {
            traceId,
            parentTraceId,
            channel: "text",
            event: "error",
            data: {
              error: `Model generation failed: ${err instanceof Error ? err.message : String(err)}`,
            },
            timestampMs: Date.now(),
          };
          return;
        }
        if (!retryReceivedUsage) budget.estimateFallback(retryMessages, retryResponse);
        const retryCode = extractCode(retryResponse);
        if (retryCode) {
          // Use the retry code for kernel execution below.
          fullResponse = retryResponse;
        } else {
          const fallbackAnswer = extractFinalAnswer(retryResponse);
          if (fallbackAnswer) {
            yield* this.#emitFinalAnswer(traceId, parentTraceId, fallbackAnswer);
          } else {
            yield {
              traceId,
              parentTraceId,
              channel: "text",
              event: "error",
              data: {
                error: "Retry response contained neither executable code nor a final answer.",
              },
              timestampMs: Date.now(),
            };
          }
          return;
        }
      }

      // Execute code in the kernel (A1 stateful execution).
      let codeToRun = extractCode(fullResponse) as string;

      // S3: code guardrail scan before kernel execution.
      if (this.#codeGuardrails.length > 0) {
        const codeTripwire = await runInputGuardrails(this.#codeGuardrails, codeToRun, []);
        if (codeTripwire) {
          yield {
            traceId,
            parentTraceId,
            channel: "status",
            event: "guardrail_tripwire",
            data: {
              guardrailName: codeTripwire.guardrailName,
              layer: "tool" as const,
              ...(codeTripwire.result.metadata ? { metadata: codeTripwire.result.metadata } : {}),
            },
            timestampMs: Date.now(),
          };
          yield {
            traceId,
            parentTraceId,
            channel: "text",
            event: "error",
            data: {
              error: `Code guardrail "${codeTripwire.guardrailName}" blocked code execution at step ${step}`,
            },
            timestampMs: Date.now(),
          };
          return;
        }
      }

      let kernelResult: KernelResult;
      let kernelAttempt = 0;
      // GPT-Engineer improve_loop: bounded retry for INFRASTRUCTURE errors.
      // User code errors are passed as observations; bounded by MAX_REFINEMENT_STEPS break.
      while (true) {
        try {
          kernelResult = await kernel.run(codeToRun);
          break; // success
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const classification = classifyExecutionError(
            err instanceof Error ? err : new Error(errMsg)
          );

          // User-code throws are infrastructure errors when the kernel wraps them.
          // We distinguish: if the error looks like deliberate user code (contains "Error:")
          // we treat it as an observation for the agent, not an infrastructure failure.
          // This preserves the existing test contract: "kernel error does not prevent step 2"
          const isUserCodeError = /^(KernelError:|PyodideKernelError:)/.test(errMsg);
          if (isUserCodeError) {
            // Synthesize a failed KernelResult — agent sees it as an observation and can recover
            kernelResult = {
              output: errMsg,
              logs: [errMsg],
              isFinalAnswer: false,
            };
            break;
          }

          kernelAttempt++;

          // Emit error_recovery event for observability
          yield {
            traceId,
            parentTraceId,
            channel: "status",
            event: "error_recovery",
            data: {
              strategy: classification.strategy as "retry" | "backoff" | "fail_fast",
              errorType: classification.errorType,
              attempt: kernelAttempt,
              maxAttempts: MAX_REFINEMENT_STEPS,
              ...(classification.fixHint ? { fixHint: classification.fixHint } : {}),
            },
            timestampMs: Date.now(),
          };

          // FAIL_FAST: surface immediately and stop
          if (
            classification.strategy === ErrorRecoveryStrategy.FAIL_FAST ||
            kernelAttempt >= MAX_REFINEMENT_STEPS
          ) {
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

          // RETRY: inject fix context and ask model for a corrected code block
          const fixMessage = buildFixRetryMessage(classification, codeToRun, kernelAttempt);
          const fixMessages = this.#assembler.build();
          fixMessages.push({ role: "user", content: fixMessage });
          let fixResponse = "";
          for await (const event of this.#model.generate(fixMessages, { stream: true })) {
            if (event.type === "text_delta" && event.delta) fixResponse += event.delta;
          }
          const fixedCode = extractCode(fixResponse);
          if (fixedCode) {
            codeToRun = fixedCode; // retry with the corrected code
          } else {
            // Model couldn't produce code — fail
            yield {
              traceId,
              parentTraceId,
              channel: "text",
              event: "error",
              data: {
                step,
                error: `Could not recover: ${err instanceof Error ? err.message : String(err)}`,
              },
              timestampMs: Date.now(),
            };
            return;
          }
        }
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
    yield* runPlanningStep(traceId, parentTraceId, step, this.#model, this.#assembler, budget);
  }

  async *#emitFinalAnswer(
    traceId: string,
    parentTraceId: string | null,
    answer: unknown
  ): AsyncGenerator<AgentEvent> {
    // Apply enhancement runners when configured (mirrors ToolCallingAgent).
    let refined: unknown = answer;
    const messages = this.#assembler.build();
    // String() on a plain object gives "[object Object]" — never useful as
    // a final answer to render. Coerce non-strings via JSON instead so the
    // user sees real content. Strings pass through unchanged.
    const answerStr =
      typeof answer === "string"
        ? answer
        : ((): string => {
            try {
              return JSON.stringify(answer, null, 2) ?? String(answer);
            } catch {
              return String(answer);
            }
          })();
    if (this.#policy?.budgetForcing?.enabled && this.#model.capabilities?.supportsBudgetForcing) {
      const result = await new BudgetForcingRunner().run(this.#model, messages);
      refined = result.answer || answerStr;
    } else if (this.#policy?.reflectRefine?.enabled) {
      const reflectOpts =
        this.#policy.reflectRefine.maxCycles !== undefined
          ? { maxCycles: this.#policy.reflectRefine.maxCycles }
          : {};
      const result = await new ReflectRefineRunner(reflectOpts).run(this.#model, messages);
      refined = result.answer || answerStr;
    } else if (this.#policy?.selfConsistency?.enabled) {
      const scOpts: { n?: number; earlyStopThreshold?: number } = {};
      if (this.#policy.selfConsistency.n !== undefined) scOpts.n = this.#policy.selfConsistency.n;
      if (this.#policy.selfConsistency.earlyStopThreshold !== undefined) {
        scOpts.earlyStopThreshold = this.#policy.selfConsistency.earlyStopThreshold;
      }
      const result = await new SelfConsistencyRunner(scOpts).run(this.#model, messages);
      refined = result.answer || answerStr;
    } else if (this.#policy?.parallelForkJoin?.enabled) {
      const fjOpts: { branches?: number; concurrency?: number; aggregation?: "summary" | "first" } =
        {};
      if (this.#policy.parallelForkJoin.branches !== undefined)
        fjOpts.branches = this.#policy.parallelForkJoin.branches;
      if (this.#policy.parallelForkJoin.concurrency !== undefined)
        fjOpts.concurrency = this.#policy.parallelForkJoin.concurrency;
      if (this.#policy.parallelForkJoin.aggregation !== undefined)
        fjOpts.aggregation = this.#policy.parallelForkJoin.aggregation;
      const result = await new ParallelForkJoinRunner(fjOpts).run(this.#model, messages);
      refined = result.answer || answerStr;
    }

    const finalStep: FinalAnswerStep = { type: "final_answer", answer: refined };
    this.#assembler.addStep(finalStep);

    // S3: output guardrail check before emitting final_answer.
    if (this.#outputGuardrails.length > 0) {
      const outputTripwire = await runOutputGuardrails(this.#outputGuardrails, refined);
      if (outputTripwire) {
        yield {
          traceId,
          parentTraceId,
          channel: "status",
          event: "guardrail_tripwire",
          data: {
            guardrailName: outputTripwire.guardrailName,
            layer: "output" as const,
            ...(outputTripwire.result.metadata ? { metadata: outputTripwire.result.metadata } : {}),
          },
          timestampMs: Date.now(),
        };
        yield {
          traceId,
          parentTraceId,
          channel: "text",
          event: "error",
          data: { error: `Output guardrail "${outputTripwire.guardrailName}" triggered` },
          timestampMs: Date.now(),
        };
        return;
      }
    }

    yield {
      traceId,
      parentTraceId,
      channel: "text",
      event: "final_answer",
      data: { answer: refined },
      timestampMs: Date.now(),
    };
  }
}

function extractThoughts(response: string): string {
  return extractTagContent(response, "thoughts") ?? "";
}

function extractCode(response: string): string | null {
  // Match fenced code blocks where the closing ``` appears at the START of a line.
  // This prevents false matches when template literals inside the code contain backticks.
  // Also supports bolt.new-style <boltAction type="file"> and <code> tags.
  const match =
    // bolt.new artifact format: <boltAction type="file" filePath="...">code</boltAction>
    /<boltAction[^>]*type="file"[^>]*>\s*([\s\S]*?)\s*<\/boltAction>/.exec(response) ??
    // XML <code> tag
    /<code>([\s\S]*?)<\/code>/.exec(response) ??
    // Standard fenced code block (closing ``` must be on its own line)
    /```(?:js|javascript|python|py|ts|typescript)?\n([\s\S]*?)(?:^|\n)```/m.exec(response) ??
    // Unlabelled code block as fallback
    /```\n([\s\S]*?)(?:^|\n)```/m.exec(response);
  if (!match) {
    // Log a truncated snippet to aid debugging without flooding output with large responses.
    const snippet = response.length > 200 ? `${response.slice(0, 200)}…` : response;
    console.debug(`[CodeAgent] extractCode: no code block found in response: ${snippet}`);
  }
  return match?.[1]?.trim() ?? null;
}

function extractFinalAnswer(response: string): string | null {
  // Pattern 1: explicit "Final Answer: value" text
  const explicitMatch = /^\s*final answer\s*[:=]\s*(.+)/im.exec(response);
  if (explicitMatch?.[1]) return explicitMatch[1].trim();

  // Pattern 2: __finalAnswer__ = value in plain text (model wrote sentinel outside code block)
  const sentinelMatch = /__(?:final[Aa]nswer|finalAnswer)__\s*=\s*([^;\n]+)/m.exec(response);
  if (sentinelMatch?.[1]) return sentinelMatch[1].trim().replace(/^['"]|['"]$/g, "");

  return null;
}

/**
 * Returns true when the response is a prose summary with no executable code —
 * i.e. the model has finished and is explaining what it did rather than doing more.
 * Used to treat a no-code response as an implicit final answer after prior steps.
 */
function isProseSummary(response: string): boolean {
  const t = response.trim();
  if (!t) return false;
  // Must not contain any code fences or XML code tags
  if (/```|<code>/i.test(t)) return false;
  // Reject generic greeting/intro/request phrases — model didn't understand the task
  if (
    /\b(ready to help|provide a task|what (would you like|can i help)|please (provide|give|tell|share)|how can i (help|assist)|hello!|hi!|sure!|of course|i'd be happy|i can help|let me know)\b/i.test(
      t
    )
  )
    return false;
  // Heuristic: completion phrases the model uses when summarising finished work
  return /\b(here['']?s|here is|i['']?ve (created|written|built|implemented|completed|finished)|the (game|code|file|function|implementation|solution|output) (is|has been|was)|done|complete|finished|created successfully)\b/i.test(
    t
  );
}
