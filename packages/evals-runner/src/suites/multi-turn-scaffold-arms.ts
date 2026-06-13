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
  GenericOpenAICompatModel,
  ProgrammaticOrchestrator,
  ToolCallingAgent,
  ToolRegistry,
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

// ── Arm (c) code — ProgrammaticOrchestrator + QuickJSKernel ─────────────────
//
// The PTC/CodeAct hypothesis: emit one program that calls multiple tools
// inside a sandbox; intermediate results stay inside the kernel and never
// re-enter the LLM context. Microsoft 2026-04 + Anthropic 2025-11 numbers
// show this is where the largest token + latency wins live.
//
// 2026-06-13 fix: Run B's arm (c) used CodeAgent + bare QuickJSKernel.
// That's wrong — `CodeAgent` runs `kernel.run(code)` directly, with NO
// `callTool()` injected; the kernel is just a JS sandbox. Tools are only
// reachable through `ProgrammaticOrchestrator`, which sets up the
// re-run-with-cached-results bridge that makes `await callTool(name,
// args)` actually do something. Run B's stderr full of "the sandbox
// can't move files" was the model correctly observing it had no tools.
//
// New shape: PO consumes the model's single program output. The arm
// becomes:
//
//   1. Build a CodeAct-style prompt that names every tool's signature
//      and tells the model to emit ONE async IIFE program.
//   2. Generate once (no agent loop, by design — that's what arm (a)
//      is for).
//   3. Extract code, hand to PO.run() — PO injects callTool, drives
//      the kernel, returns finalOutput.
//   4. Judge by terminal state of the fixture (same path as every
//      other arm).
//
// Why no agent loop here: CodeAct's whole point is "one shot, many
// tool calls". An agent loop on top of that is double-counting; if
// the program needs more than one round to plan, the V2 plan
// already has arm (a)/(d)/(e) for that.
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

  const result = await runOnePoProgram({
    item: args.item,
    cell,
    model: m,
    kernelFactory: () => new kernelMod.QuickJSKernel() as unknown,
  });
  result.wallMs = Date.now() - startMs;
  return result;
}

/**
 * Build a CodeAct-style system prompt that lists every tool with its
 * signature, examples, and the rule "emit ONE async IIFE that does the
 * whole task by awaiting callTool(...)". The shape is what
 * ProgrammaticOrchestrator's `await callTool(name, args)` bridge actually
 * accepts, written in a way small instruct models (≤2B) can follow.
 *
 * The crucial bits the prompt must contain (Run B post-mortem):
 *   - The word "callTool" — without seeing it, models invent tool-call
 *     conventions like `tools.move_file(...)` or `<tool_use>` JSON, and
 *     PO ignores all of them.
 *   - The wrapper signature `(async () => { ... })()` — small models
 *     omit the IIFE and emit raw await statements that fail to parse.
 *   - At least one full worked example. Run B's stderr showed many
 *     models writing valid-looking JS but with the wrong tool name
 *     casing or arg key names. A worked example pins both.
 */
function buildPoPrompt(tools: ToolDefinition[]): string {
  const toolDocs = tools
    .map((t) => {
      const schema = t.rawInputJsonSchema ?? safeZodToJsonSchema(t.inputSchema);
      const argShape = describeArgShape(schema);
      return `- \`callTool("${t.name}", ${argShape})\` — ${t.description}`;
    })
    .join("\n");

  return `You drive a sandbox by emitting ONE JavaScript program that calls tools.

The sandbox provides exactly one global: \`callTool(name, args)\`. It returns
a Promise that resolves to the tool's result (already JSON-parsed when the
tool returns an object). All tool calls MUST go through callTool — there is
no \`fs\`, no \`fetch\`, no DOM, no \`require\`, no other API. The tools you have:

${toolDocs}

REQUIRED OUTPUT SHAPE — one fenced JavaScript code block, structured as an
async IIFE so \`await\` parses:

\`\`\`js
(async () => {
  // ... your tool calls here ...
  return "DONE";
})();
\`\`\`

WORKED EXAMPLE. If the task were "rename old.txt to new.txt and confirm",
the program would be:

\`\`\`js
(async () => {
  await callTool("move_file", { from: "old.txt", to: "new.txt" });
  const after = await callTool("list_files", {});
  return JSON.stringify(after);
})();
\`\`\`

Notes:
  - Use the EXACT tool names listed above; casing matters.
  - The argument keys must match the schema — read each tool's signature.
  - The program runs once. Do all the steps in the same IIFE.
  - The return value of the IIFE is shown to the user; everything else
    stays inside the sandbox.
  - Do not write prose outside the code block. Do not say "I cannot run
    this in a sandbox" — you are IN the sandbox; callTool works.`;
}

function safeZodToJsonSchema(_schema: unknown): { type: string; properties?: Record<string, unknown>; required?: string[] } {
  // Small models do better with a hand-written description than with a full
  // JSON Schema; we fall through to a generic shape and rely on
  // describeArgShape() to render either path.
  return { type: "object" };
}

function describeArgShape(schema: { type?: string; properties?: Record<string, unknown>; required?: string[] }): string {
  if (!schema || schema.type !== "object" || !schema.properties) return "{}";
  const keys = Object.keys(schema.properties);
  if (keys.length === 0) return "{}";
  return `{ ${keys.map((k) => `${k}: ...`).join(", ")} }`;
}

/**
 * Single-shot CodeAct rollout: prompt the model once, extract the program,
 * hand it to ProgrammaticOrchestrator. Used by arm (c) (one rollout) and
 * arm (e) (k=5 rollouts inside a self-consistency wrapper).
 *
 * Errors at the model layer / extraction layer / kernel layer all surface
 * as `error` on the RunItemResult; the suite-level judge then runs against
 * whatever state the partial run left behind. (For most failure modes the
 * judge sees an unchanged fixture and returns false, which is correct.)
 */
async function runOnePoProgram(args: {
  item: typeof ITEMS[number];
  cell: PreparedCell;
  model: Model;
  kernelFactory: () => unknown;
}): Promise<RunItemResult> {
  const { item, cell, model, kernelFactory } = args;
  const systemPrompt = buildPoPrompt(cell.tools);

  // Generate the program. We use `model.generate` directly because we
  // don't want any agent-loop semantics — this is intentionally a
  // single LLM call, the program does the rest.
  let raw = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | null = null;
  try {
    for await (const ev of model.generate(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: item.task },
      ],
      { stream: true },
    )) {
      if (ev.type === "text_delta" && ev.delta) raw += ev.delta;
      else if (ev.type === "usage" && ev.usage) {
        inputTokens += ev.usage.inputTokens ?? 0;
        outputTokens += ev.usage.outputTokens ?? 0;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  let answer: string | null = null;

  if (!error) {
    const code = extractFencedJs(raw);
    if (!code) {
      error = `model returned no JS code block; raw head: ${raw.slice(0, 200)}`;
    } else {
      // Strip a trailing IIFE invocation if the model wrote `(async () => {
      // ... })()` AND a separate `;` — PO wraps the script itself, so the
      // model's IIFE is fine; we only need to extract its body. PO also
      // tolerates a top-level `await callTool(...)` directly because of
      // the IIFE wrapping it does internally.
      try {
        const reg = new ToolRegistry();
        for (const t of cell.tools) reg.register(t);
        const orchestrator = new ProgrammaticOrchestrator(
          kernelFactory() as never,
          reg,
        );
        const poResult = await orchestrator.run(code);
        answer = poResult.finalOutput;
      } catch (e) {
        error = `kernel/PO: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  let passed = false;
  try {
    passed = cell.judge();
  } catch {
    passed = false;
  }
  if (error) passed = false;

  return {
    answer,
    passed,
    wallMs: 0, // filled in by caller
    tokens: { input: inputTokens, output: outputTokens },
    error,
  };
}

/** Extract a fenced JS / JavaScript / TS code block; tolerates language tag absence. */
function extractFencedJs(response: string): string | null {
  // Same regex shape as CodeAgent's extractCode, restricted to JS-family.
  const m =
    /```(?:js|javascript|ts|typescript)?\n([\s\S]*?)(?:^|\n)```/m.exec(response) ??
    /```\n([\s\S]*?)(?:^|\n)```/m.exec(response);
  return m?.[1]?.trim() ?? null;
}

export const armCodeSuite: BenchmarkSuite = {
  name: "mt-tool-exec.arm-c-code",
  title: "Arm (c) ProgrammaticOrchestrator + QuickJSKernel (CodeAct)",
  description:
    "One model call → one async IIFE program → ProgrammaticOrchestrator drives the kernel and re-runs with cached tool results. Tests the compress-the-rounds hypothesis (CodeAct, MS Agent Framework 2026-04). 2026-06-13 fix: previous attempt used CodeAgent + bare kernel and had no tool injection; replaced.",
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

// ── Arm (e) full — CodeAct + SC k=5 (terminal-state majority) ────────────────
//
// The plan calls for "(b) + (c) + (d) + ObservationalMemory". But (b)
// grammar=json and (c) CodeAct are STRUCTURALLY INCOMPATIBLE: format=json
// forces the entire model output to be a JSON object, which means the
// fenced JS code block (c) needs is unreachable. Run B got 1/6 on arm
// (e) because SC k=5 happened to mask the contradiction in one rollout
// — that's noise, not signal.
//
// Resolution: arm (e) stacks the COMPATIBLE layers: CodeAct (one program
// that PO drives) + SC k=5 over fresh rollouts (terminal-state majority).
// Grammar is a tool-form constraint; CodeAct doesn't emit tool_use blocks
// to begin with, so grammar has no surface to apply to. We name this
// behaviour explicitly in the suite description so future runs don't
// re-introduce the contradiction.
//
// ObservationalMemory is what every rollout's PO already uses internally
// (the kernel's call cache between re-runs is exactly that pattern).
// There's no "off" knob to compare against, so we don't add a separate
// arm for it — same call as Run B.
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
  let lastAnswer: string | null = null;
  let passVotes = 0;
  for (let i = 0; i < k; i++) {
    const cell = prepareCell(args.item.id);
    const m = buildModel(args.model);
    const r = await runOnePoProgram({
      item: args.item,
      cell,
      model: m,
      kernelFactory: () => new kernelMod.QuickJSKernel() as unknown,
    });
    if (r.error) lastError = r.error;
    if (r.passed) passVotes++;
    totalIn += r.tokens?.input ?? 0;
    totalOut += r.tokens?.output ?? 0;
    lastAnswer = r.answer;
  }
  const passed = passVotes > k / 2;
  const wallMs = Date.now() - startMs;
  return {
    answer: lastAnswer,
    passed,
    wallMs,
    tokens: { input: totalIn, output: totalOut },
    error: passed ? null : lastError,
  };
}

export const armFullSuite: BenchmarkSuite = {
  name: "mt-tool-exec.arm-e-full",
  title: "Arm (e) full stack (CodeAct + SC k=5 terminal-state vote)",
  description:
    "G0 candidate arm. CodeAct (one program per rollout, PO drives the kernel) × 5 fresh rollouts × terminal-state majority. NOTE: grammar=json is intentionally OFF here because format=json (arm b) and JS-code-fence (arm c) are structurally incompatible — see comment in source. ≥50% on a 1.5B model is the G0 green-light threshold.",
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
