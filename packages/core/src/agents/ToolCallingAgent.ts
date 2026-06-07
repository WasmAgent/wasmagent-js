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
import { ParallelForkJoinRunner } from "../enhancement/ParallelForkJoinRunner.js";
import type { AgentEvent, FinalAnswerStep, ParallelToolUseCall, ParallelToolUseStep, ToolUseStep, UserMessageStep } from "../types/events.js";
import { runPlanningStep, TOOL_DEP_INSTRUCTIONS } from "./prompts.js";
import { Scheduler } from "../scheduler/Scheduler.js";
import { SimpleIR } from "../scheduler/ir.js";
import type { IRNode } from "../scheduler/ir.js";
import { deriveDependencies } from "../scheduler/deriveDeps.js";
import type { StopCondition } from "./stopConditions.js";
import { callFingerprint } from "./stopConditions.js";
import type { Checkpointer } from "../checkpoint/index.js";

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
    this.#toolsSchema = this.#tools.toJsonSchema();
    this.#assembler = opts.assembler ?? new MessageAssembler({
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

    for (let step = 1; step <= this.#maxSteps; step++) {
      // B2: external kill-switch — check before every step and abort if signalled.
      if (signal?.aborted) {
        if (this.#checkpointer) {
          await this.#checkpointer.save(traceId, {
            traceId, task, history: [], stepIndex: step, savedAtMs: Date.now(),
          });
        }
        yield {
          traceId, parentTraceId, channel: "text", event: "error",
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
        } else if (this.#policy?.parallelForkJoin?.enabled) {
          const fjOpts: { branches?: number; concurrency?: number; aggregation?: "summary" | "first" } = {};
          if (this.#policy.parallelForkJoin.branches !== undefined) fjOpts.branches = this.#policy.parallelForkJoin.branches;
          if (this.#policy.parallelForkJoin.concurrency !== undefined) fjOpts.concurrency = this.#policy.parallelForkJoin.concurrency;
          if (this.#policy.parallelForkJoin.aggregation !== undefined) fjOpts.aggregation = this.#policy.parallelForkJoin.aggregation;
          const result = await new ParallelForkJoinRunner(fjOpts).run(this.#model, messages);
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

      // C1: per-tool human approval (needsApproval).
      // Check each pending call; if any tool requires approval, pause and wait.
      if (this.#checkpointer) {
        for (const call of pendingCalls) {
          const toolDef = this.#tools.get(call.name);
          if (!toolDef?.needsApproval) continue;
          const needs = typeof toolDef.needsApproval === "function"
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
              approved = resp === "yes" || resp === "y" || resp === "approve" || resp === "approved";
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
          return {
            id: call.id,
            toolName: call.name,
            args: call.input,
            dependsOn: depMap.get(call.id) ?? [],
            readOnly: toolDef?.readOnly ?? false,
            idempotent: toolDef?.idempotent ?? false,
          };
        });
        const ir = new SimpleIR(nodes);
        const scheduler = new Scheduler(this.#tools);

        // Collect results from scheduler events, mapping node_done/node_error back
        // to resolvedCalls in the same order as pendingCalls.
        const resultMap = new Map<string, { output: string; isError: boolean; isUntrusted: boolean }>();
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
                output = toolResult?.output === undefined ? "null" : JSON.stringify(toolResult.output);
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
          const res = resultMap.get(call.id) ?? { output: "Tool execution failed with no output.", isError: true, isUntrusted: false };
          yield {
            traceId,
            parentTraceId,
            channel: "tool",
            event: "tool_result",
            data: res.isError
              ? { callId: call.id, toolName: call.name, output: null as unknown, error: { code: "execution_error" as const, message: res.output }, batchId, batchSize, stepIndex: step }
              : { callId: call.id, toolName: call.name, output: (() => { try { return JSON.parse(res.output); } catch { return res.output; } })(), batchId, batchSize, stepIndex: step },
            timestampMs: Date.now(),
          };
          resolvedCalls.push({ toolCallId: call.id, toolName: call.name, toolInput: call.input, toolOutput: res.output, isError: res.isError, ...(res.isUntrusted ? { isUntrusted: true } : {}) });
        }
      } else {
        // "parallel" mode: original Promise.all path.
        const handles = pendingCalls.map((call) => {
          let callIsError = false;
          const signal = this.#toolTimeoutMs ? AbortSignal.timeout(this.#toolTimeoutMs) : undefined;
          const settled = this.#tools
            .call({ toolName: call.name, args: call.input, callId: call.id, ...(signal ? { signal } : {}) })
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

        const outputs = await Promise.all(handles.map((h) => h.handle.resolve()));
        for (let i = 0; i < handles.length; i++) {
          const { call, getIsError } = handles[i]!;
          const toolOutput = outputs[i]!;
          const isError = getIsError();
          yield {
            traceId,
            parentTraceId,
            channel: "tool",
            event: "tool_result",
            data: isError
              ? { callId: call.id, toolName: call.name, output: null as unknown, error: { code: "execution_error" as const, message: toolOutput }, batchId, batchSize, stepIndex: step }
              : { callId: call.id, toolName: call.name, output: (() => { try { return JSON.parse(toolOutput); } catch { return toolOutput; } })(), batchId, batchSize, stepIndex: step },
            timestampMs: Date.now(),
          };
          resolvedCalls.push({ toolCallId: call.id, toolName: call.name, toolInput: call.input, toolOutput, isError });
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
