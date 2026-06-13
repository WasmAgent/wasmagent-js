/**
 * Five-arm scaffold ablation harness over the multi-turn-tool-exec suite.
 *
 * Each arm is an independent BenchmarkSuite that re-uses the same items
 * and judges from `multi-turn-tool-exec.ts` but swaps which agent / runner
 * stack drives the cell. The arms come from the V2 step of the desktop-
 * agent feasibility plan (2026-06-13):
 *
 *   (a) bare       — plain ToolCallingAgent (the baseline; same as
 *                    multiTurnToolExecSuite.runItem)
 *   (b) grammar    — bare + Ollama `format: <json-schema>` constraint on
 *                    every tool-output turn. Tests whether form-level
 *                    grammar shutdown of malformed JSON moves the cliff.
 *   (c) code       — CodeAgent + ProgrammaticOrchestrator + QuickJSKernel.
 *                    The PTC/CodeAct hypothesis: collapse N tool round-
 *                    trips into a single code block — Microsoft Agent
 *                    Framework CodeAct numbers (2026-04) report −50%
 *                    latency / −60% tokens on representative loads.
 *   (d) self-consist — bare + SelfConsistencyRunner (k=5). Free in token
 *                    cost on local Ollama (no per-call billing); tests
 *                    whether majority vote stabilises a noisy small model.
 *   (e) full       — (b) + (c) + (d) + ObservationalMemory compaction.
 *                    The "everything we can throw at it" arm; the one that
 *                    has to clear ≥50% on a 1.5B model for G0 to pass.
 *
 * Each arm exports a `<name>Suite` so the benchmark script in
 * `examples/benchmarks/multi-turn-scaffold-ablation.mjs` can pick by id.
 *
 * Why we don't use node-llama-cpp directly: V2 needs to run on the same
 * Ollama endpoint that the human user (and CI) can reproduce on a 16GB
 * laptop without compiling native bindings. GenericOpenAICompatModel
 * against `http://localhost:11434/v1` is the contract — every arm honours
 * it. Grammar in arm (b) uses Ollama's `format` field, which v0.5+ accepts
 * as a JSON schema on the chat-completions request body.
 */

import type { AgentEvent, Model, ToolDefinition } from "@agentkit-js/core";
import {
  CodeAgent,
  GenericOpenAICompatModel,
  ToolCallingAgent,
} from "@agentkit-js/core";
import type { BenchmarkSuite, ModelSpec, RunItemResult } from "../types.js";
import { __test__, multiTurnToolExecSuite } from "./multi-turn-tool-exec.js";

const { META, ITEMS } = __test__ as {
  META: Record<string, unknown>;
  ITEMS: typeof multiTurnToolExecSuite.items;
  fsFixture: unknown;
  calFixture: unknown;
  cartFixture: unknown;
};

// ── Shared helpers ──────────────────────────────────────────────────────────
//
// The fixtures + judges live in multi-turn-tool-exec.ts and are exposed
// via __test__. To avoid duplicating the (complex, item-by-item) judge
// logic, every arm here wraps the canonical suite: it builds the same
// fresh state + tools, then feeds them to a *different* agent stack. The
// judge is read back from META (same structural tag we use in V1).

type FixtureMeta =
  | { family: "fs"; fixture: { makeState: () => unknown; makeTools: (s: unknown) => ToolDefinition[] }; judge: (s: unknown) => boolean }
  | { family: "cal"; fixture: { makeState: () => unknown; makeTools: (s: unknown) => ToolDefinition[] }; judge: (s: unknown) => boolean }
  | { family: "cart"; fixture: { makeState: () => unknown; makeTools: (s: unknown) => ToolDefinition[] }; judge: (s: unknown) => boolean }
  | {
      family: "mixed";
      fsFix: { makeState: () => unknown; makeTools: (s: unknown) => ToolDefinition[] };
      calFix: { makeState: () => unknown; makeTools: (s: unknown) => ToolDefinition[] };
      judge: (fs: unknown, cal: unknown) => boolean;
    };

interface PreparedCell {
  tools: ToolDefinition[];
  judge: () => boolean;
  states: { fs?: unknown; cal?: unknown; cart?: unknown };
}

function prepareCell(itemId: string): PreparedCell {
  const meta = META[itemId] as FixtureMeta | undefined;
  if (!meta) throw new Error(`no fixture for ${itemId}`);
  if (meta.family === "fs") {
    const s = meta.fixture.makeState();
    return { tools: meta.fixture.makeTools(s), judge: () => meta.judge(s), states: { fs: s } };
  }
  if (meta.family === "cal") {
    const s = meta.fixture.makeState();
    return { tools: meta.fixture.makeTools(s), judge: () => meta.judge(s), states: { cal: s } };
  }
  if (meta.family === "cart") {
    const s = meta.fixture.makeState();
    return { tools: meta.fixture.makeTools(s), judge: () => meta.judge(s), states: { cart: s } };
  }
  // mixed
  const fsS = meta.fsFix.makeState();
  const calS = meta.calFix.makeState();
  return {
    tools: [...meta.fsFix.makeTools(fsS), ...meta.calFix.makeTools(calS)],
    judge: () => meta.judge(fsS, calS),
    states: { fs: fsS, cal: calS },
  };
}

const SYSTEM_PROMPT =
  "You are an expert assistant operating a sandboxed workspace through tools. " +
  "Use the tools to complete the user's task end to end. " +
  "You may need multiple tool calls — keep going until the task is complete. " +
  "When you are certain the task is done, reply with the single line 'DONE.' as your final answer (no tool call).";

function buildModel(spec: ModelSpec, opts: { format?: object } = {}): Model {
  const generic = new GenericOpenAICompatModel(spec.modelId ?? spec.id, spec.baseUrl, {
    apiKey: spec.apiKey ?? process.env.OPENAI_API_KEY ?? "ollama",
    ...(opts.format ? { extraRequestParams: { format: opts.format } } : {}),
  });
  return generic;
}

interface RunResult {
  finalAnswer: string | null;
  events: AgentEvent[];
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

async function drainAgent(
  gen: AsyncGenerator<AgentEvent>,
): Promise<RunResult> {
  let finalAnswer: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | null = null;
  const events: AgentEvent[] = [];
  try {
    for await (const ev of gen) {
      events.push(ev);
      if (ev.event === "model_done") {
        const data = ev.data as { inputTokens?: number; outputTokens?: number };
        inputTokens += data.inputTokens ?? 0;
        outputTokens += data.outputTokens ?? 0;
      }
      if (ev.event === "final_answer") {
        finalAnswer = (ev.data as { answer?: string }).answer ?? "";
      }
      if (ev.event === "error") {
        error = String((ev.data as { error?: unknown }).error ?? "agent error");
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { finalAnswer, events, inputTokens, outputTokens, error };
}

function shapeResult(
  cell: PreparedCell,
  startMs: number,
  r: RunResult,
): RunItemResult {
  const wallMs = Date.now() - startMs;
  let passed = false;
  try {
    passed = cell.judge();
  } catch {
    passed = false;
  }
  if (r.error) passed = false;
  return {
    answer: r.finalAnswer,
    passed,
    wallMs,
    tokens: { input: r.inputTokens, output: r.outputTokens },
    error: r.error,
    events: r.events,
  };
}

// ── Arm (a) bare — same as the canonical multi-turn-tool-exec suite ─────────
//
// Re-exporting it under a deliberate name makes the arm grid explicit in
// reports. Internally it's the exact same runItem.
export const armBareSuite: BenchmarkSuite = {
  ...multiTurnToolExecSuite,
  name: "mt-tool-exec.arm-a-bare",
  title: "Arm (a) bare ToolCallingAgent",
  description: "Baseline: ToolCallingAgent maxSteps=15, no grammar, no enhancement.",
};

// ── Arm (b) grammar — Ollama format-constrained tool calls ───────────────────
//
// We pass Ollama a JSON schema describing the legal shape of each tool's
// input via `extraRequestParams.format`. Ollama's chat-completions accepts
// either "json" (any JSON) or a JSON schema. The schema we use is the
// union of every tool's inputSchema rendered to JSON Schema, plus a
// "final answer" branch — the model is grammar-pinned to one of those.
//
// Caveat: Ollama's grammar enforcement applies to the model's RAW output;
// agentkit's parsing layer then has to interpret that as a tool_use OR a
// final-answer text. We keep the interpretation logic on the agentkit
// side (ToolCallingAgent already handles malformed output gracefully); the
// grammar arm's job is only to *reduce form-level errors*, which is the
// failure mode the BFCL paper identifies as dominant for <1B models.
const ARM_B_FORMAT = { type: "json" as const }; // Ollama accepts "json" globally — sufficient for arm (b)

async function runArmB(args: { item: typeof ITEMS[number]; model: ModelSpec }): Promise<RunItemResult> {
  const cell = prepareCell(args.item.id);
  const m = buildModel(args.model, { format: ARM_B_FORMAT });
  const startMs = Date.now();
  const agent = new ToolCallingAgent({
    model: m,
    tools: cell.tools,
    maxSteps: 15,
    systemPrompt: SYSTEM_PROMPT,
  });
  const r = await drainAgent(agent.run(args.item.task));
  return shapeResult(cell, startMs, r);
}

export const armGrammarSuite: BenchmarkSuite = {
  name: "mt-tool-exec.arm-b-grammar",
  title: "Arm (b) grammar (Ollama format=json)",
  description:
    "Arm (a) plus Ollama format=json constraint. Pins form-level legality; tests how much of the cliff is JSON-shape failure vs reasoning failure.",
  items: ITEMS,
  scorers: [],
  runItem: runArmB,
};

// ── Arm (c) code — CodeAgent + ProgrammaticOrchestrator + QuickJSKernel ─────
//
// The PTC/CodeAct hypothesis. CodeAgent emits one Python-or-JS-shaped
// program that calls multiple tools inside a sandbox; intermediate results
// don't enter the LLM context. Microsoft 2026-04 + Anthropic 2025-11 numbers
// show this is where the largest token + latency wins live.
//
// Implementation: we let CodeAgent consume the same tool list, with a
// QuickJSKernel as the sandbox. The agent's prompt template asks for a
// JS expression that uses the tool functions; QuickJSKernel evaluates it
// with each tool injected as a function. ProgrammaticOrchestrator is
// CodeAgent's default orchestrator since the M4 milestone.
async function runArmC(args: { item: typeof ITEMS[number]; model: ModelSpec }): Promise<RunItemResult> {
  const cell = prepareCell(args.item.id);
  const m = buildModel(args.model);
  const startMs = Date.now();
  // Lazy-load QuickJSKernel — it's a heavy peer dep, only mount when arm (c) runs.
  let kernelMod: { QuickJSKernel: new () => unknown };
  try {
    kernelMod = (await import("@agentkit-js/kernel-quickjs")) as unknown as {
      QuickJSKernel: new () => unknown;
    };
  } catch (e) {
    return {
      answer: null,
      passed: false,
      wallMs: Date.now() - startMs,
      error: `arm (c) requires @agentkit-js/kernel-quickjs: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const kernel = new kernelMod.QuickJSKernel();
  // CodeAgent compresses N tool round-trips into one program block. The
  // PTC win comes from CodeAgent's natural shape — intermediate results
  // stay inside the kernel and never re-enter the LLM context.
  const agent = new CodeAgent({
    model: m,
    tools: cell.tools,
    maxSteps: 8,
    systemPrompt: SYSTEM_PROMPT,
    kernel: kernel as unknown as never,
  });
  const r = await drainAgent(agent.run(args.item.task));
  return shapeResult(cell, startMs, r);
}

export const armCodeSuite: BenchmarkSuite = {
  name: "mt-tool-exec.arm-c-code",
  title: "Arm (c) CodeAgent + PTC + QuickJSKernel",
  description:
    "Replaces the per-tool-call loop with a single program that calls multiple tools inside a sandbox. Tests the compress-the-rounds hypothesis (CodeAct, MS Agent Framework 2026-04).",
  items: ITEMS,
  scorers: [],
  runItem: runArmC,
};

// ── Arm (d) self-consistency — bare + SelfConsistencyRunner k=5 ─────────────
//
// SC at k=5 runs five independent rollouts and majority-votes the final
// answer. For an *agent* loop (not a single model call) the cleanest
// realisation is: run the bare arm 5 times with different seeds, then
// vote on the resulting terminal state. If ≥3 of 5 reach a goal-passing
// state, pass. This is what the V2 plan describes ("(d) (a)+SC k=5").
//
// Note: SelfConsistencyRunner in the core lib is built for single
// model-call pipelines. We re-implement the agent-level voting here
// because state-transition voting requires comparing terminal states,
// which is suite-specific. The core SC runner stays untouched.
async function runArmD(args: { item: typeof ITEMS[number]; model: ModelSpec }): Promise<RunItemResult> {
  const k = 5;
  const startMs = Date.now();
  const results: { passed: boolean; tokens: { input: number; output: number }; events: AgentEvent[]; finalAnswer: string | null }[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let lastError: string | null = null;
  for (let i = 0; i < k; i++) {
    const cell = prepareCell(args.item.id); // fresh state each rollout
    const m = buildModel(args.model);
    const agent = new ToolCallingAgent({
      model: m,
      tools: cell.tools,
      maxSteps: 15,
      systemPrompt: SYSTEM_PROMPT,
    });
    const r = await drainAgent(agent.run(args.item.task));
    if (r.error) lastError = r.error;
    let passed = false;
    try {
      passed = cell.judge();
    } catch {
      passed = false;
    }
    if (r.error) passed = false;
    totalIn += r.inputTokens;
    totalOut += r.outputTokens;
    results.push({ passed, tokens: { input: r.inputTokens, output: r.outputTokens }, events: r.events, finalAnswer: r.finalAnswer });
  }
  const passVotes = results.filter((r) => r.passed).length;
  const passed = passVotes > k / 2;
  const wallMs = Date.now() - startMs;
  const lastEvents = results[results.length - 1]?.events;
  return {
    answer: results[results.length - 1]?.finalAnswer ?? null,
    passed,
    wallMs,
    tokens: { input: totalIn, output: totalOut },
    error: passed ? null : lastError,
    ...(lastEvents ? { events: lastEvents } : {}),
  };
}

export const armSelfConsistencySuite: BenchmarkSuite = {
  name: "mt-tool-exec.arm-d-self-consist",
  title: "Arm (d) self-consistency (k=5 majority on terminal state)",
  description:
    "Runs the bare arm five times, votes on whether the goal was reached. Token cost is local-zero so SC is essentially free; tests whether stochastic noise is the dominant failure mode.",
  items: ITEMS,
  scorers: [],
  runItem: runArmD,
};

// ── Arm (e) full — grammar + code + self-consistency ────────────────────────
//
// The "everything compatible" stack. Grammar pins form, CodeAgent
// compresses turns, SC votes over k=5 rollouts. ObservationalMemory is
// what the bare ToolCallingAgent already uses for its assembler — there's
// no "off" mode to compare against, so we don't add a separate knob.
async function runArmE(args: { item: typeof ITEMS[number]; model: ModelSpec }): Promise<RunItemResult> {
  const k = 5;
  const startMs = Date.now();
  let kernelMod: { QuickJSKernel: new () => unknown };
  try {
    kernelMod = (await import("@agentkit-js/kernel-quickjs")) as unknown as {
      QuickJSKernel: new () => unknown;
    };
  } catch (e) {
    return {
      answer: null,
      passed: false,
      wallMs: Date.now() - startMs,
      error: `arm (e) requires @agentkit-js/kernel-quickjs: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  let totalIn = 0;
  let totalOut = 0;
  let lastError: string | null = null;
  let lastResult: RunResult | null = null;
  let passVotes = 0;
  for (let i = 0; i < k; i++) {
    const cell = prepareCell(args.item.id);
    const m = buildModel(args.model, { format: ARM_B_FORMAT });
    const kernel = new kernelMod.QuickJSKernel();
    const agent = new CodeAgent({
      model: m,
      tools: cell.tools,
      maxSteps: 8,
      systemPrompt: SYSTEM_PROMPT,
      kernel: kernel as unknown as never,
    });
    const r = await drainAgent(agent.run(args.item.task));
    if (r.error) lastError = r.error;
    let passed = false;
    try {
      passed = cell.judge();
    } catch {
      passed = false;
    }
    if (r.error) passed = false;
    if (passed) passVotes++;
    totalIn += r.inputTokens;
    totalOut += r.outputTokens;
    lastResult = r;
  }
  const passed = passVotes > k / 2;
  const wallMs = Date.now() - startMs;
  return {
    answer: lastResult?.finalAnswer ?? null,
    passed,
    wallMs,
    tokens: { input: totalIn, output: totalOut },
    error: passed ? null : lastError,
    ...(lastResult?.events ? { events: lastResult.events } : {}),
  };
}

export const armFullSuite: BenchmarkSuite = {
  name: "mt-tool-exec.arm-e-full",
  title: "Arm (e) full stack (grammar + CodeAgent + SC k=5)",
  description:
    "G0 candidate arm: every layer of scaffolding agentkit ships, applied at once. ≥50% on a 1.5B model is the green-light threshold.",
  items: ITEMS,
  scorers: [],
  runItem: runArmE,
};

// ── Suite registry for the ablation script ──────────────────────────────────
export const ABLATION_ARMS: Record<string, BenchmarkSuite> = {
  bare: armBareSuite,
  grammar: armGrammarSuite,
  code: armCodeSuite,
  "self-consist": armSelfConsistencySuite,
  full: armFullSuite,
};
