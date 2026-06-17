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

import type { AgentEvent, Model, ModelMessage, ToolDefinition } from "@agentkit-js/core";
import {
  GenericOpenAICompatModel,
  ProgrammaticOrchestrator,
  ToolCallingAgent,
  ToolRegistry,
  toStrictJsonSchema,
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
  | {
      family: "fs";
      fixture: { makeState: () => unknown; makeTools: (s: unknown) => ToolDefinition[] };
      judge: (s: unknown) => boolean;
    }
  | {
      family: "cal";
      fixture: { makeState: () => unknown; makeTools: (s: unknown) => ToolDefinition[] };
      judge: (s: unknown) => boolean;
    }
  | {
      family: "cart";
      fixture: { makeState: () => unknown; makeTools: (s: unknown) => ToolDefinition[] };
      judge: (s: unknown) => boolean;
    }
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

async function drainAgent(gen: AsyncGenerator<AgentEvent>): Promise<RunResult> {
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

function shapeResult(cell: PreparedCell, startMs: number, r: RunResult): RunItemResult {
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

async function runArmB(args: {
  item: (typeof ITEMS)[number];
  model: ModelSpec;
}): Promise<RunItemResult> {
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
async function runArmC(args: {
  item: (typeof ITEMS)[number];
  model: ModelSpec;
}): Promise<RunItemResult> {
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

function safeZodToJsonSchema(_schema: unknown): {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
} {
  // Small models do better with a hand-written description than with a full
  // JSON Schema; we fall through to a generic shape and rely on
  // describeArgShape() to render either path.
  return { type: "object" };
}

function describeArgShape(schema: {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}): string {
  if (schema?.type !== "object" || !schema.properties) return "{}";
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
  item: (typeof ITEMS)[number];
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
      { stream: true }
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
      // Normalise: PO wraps whatever it receives in an outer async IIFE
      // and awaits it, so a model-emitted IIFE becomes a no-op expression
      // statement (PO's __r is undefined, toolCallCount=0). Strip the
      // outer wrapper if the model wrote one — its body is what PO needs.
      // Verified 2026-06-13 by direct probe (Run C post-mortem).
      const body = stripIifeWrapper(code);
      try {
        const reg = new ToolRegistry();
        for (const t of cell.tools) reg.register(t);
        const orchestrator = new ProgrammaticOrchestrator(kernelFactory() as never, reg);
        const poResult = await orchestrator.run(body);
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

/**
 * Strip an outer `(async () => { ... })()` or `(async function() { ... })()`
 * wrapper if present, returning just the body. ProgrammaticOrchestrator
 * itself wraps whatever it receives in `(async function() { ${script} })()`
 * (see ProgrammaticOrchestrator.ts:190), so a model-provided IIFE becomes
 * an *expression statement that's never returned* — the kernel runs it but
 * the wrapper's `__r` ends up undefined and `toolCallCount: 0`.
 *
 * The CodeAct prompt teaches the model to emit IIFEs because that's the
 * natural authoring shape (it lets `await` parse), so we normalise here
 * rather than asking the model to emit body-only — which it tends to
 * forget on later items, and which fights the prompt's worked example.
 *
 * Confirmed by direct probe (2026-06-13, see Run C post-mortem):
 *   - IIFE-wrapped program → PO produces "" + 0 tool calls
 *   - Body-only program    → PO drives all tool calls, judge passes
 *
 * The matchers are deliberately permissive (allow `=>`, `function`,
 * trailing semicolon optional, leading whitespace) because small models
 * vary the wrapper shape; we strip whichever variant we see.
 */
function stripIifeWrapper(code: string): string {
  // Try arrow-IIFE first (the most common shape after our prompt).
  // Pattern: ( async ( ) => { <body> } ) ( ) ;?
  const arrowMatch = /^\s*\(\s*async\s*\(\s*\)\s*=>\s*\{([\s\S]*)\}\s*\)\s*\(\s*\)\s*;?\s*$/.exec(
    code
  );
  if (arrowMatch?.[1] !== undefined) return arrowMatch[1].trim();
  // function-IIFE variant.
  const fnMatch =
    /^\s*\(\s*async\s+function\s*\(\s*\)\s*\{([\s\S]*)\}\s*\)\s*\(\s*\)\s*;?\s*$/.exec(code);
  if (fnMatch?.[1] !== undefined) return fnMatch[1].trim();
  // Not an IIFE — return as-is (PO will wrap it itself).
  return code;
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
async function runArmD(args: {
  item: (typeof ITEMS)[number];
  model: ModelSpec;
}): Promise<RunItemResult> {
  const k = 5;
  const startMs = Date.now();
  const results: {
    passed: boolean;
    tokens: { input: number; output: number };
    events: AgentEvent[];
    finalAnswer: string | null;
  }[] = [];
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
    results.push({
      passed,
      tokens: { input: r.inputTokens, output: r.outputTokens },
      events: r.events,
      finalAnswer: r.finalAnswer,
    });
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
async function runArmE(args: {
  item: (typeof ITEMS)[number];
  model: ModelSpec;
}): Promise<RunItemResult> {
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

// ── Arm (f) param-only — model only fills tool args via grammar ─────────────
//
// Origin: Run E (n=90, 2026-06-13) settled the original five-arm V2 with a
// FAIL — order of magnitude verdict (1.5B × best stack = 7.8% acc, 33pp
// short of the 50% G0 floor). The plan's failure branch listed three unlock
// paths; this arm implements path 2 — "constrain the model further so it
// makes fewer decisions per call".
//
// Hypothesis: small models do not fail on JSON form (arm b grammar already
// pinned that) and do not fail on long-program planning (arm c CodeAct
// already shipped that). They fail on per-call wrong tool name + wrong arg
// names. If we use json_schema response_format to make those two things
// IMPOSSIBLE rather than discouraged, the failure mode changes — either
// passes go up, or the bottleneck moves to multi-step state tracking
// (which the grammar can't address and which validates the alternate
// hypothesis "1-2B can't do this regardless of scaffolding").
//
// Two flavours, run as separate sub-arms:
//
//   "param-only-1pass": grammar pins both tool name AND args in ONE call
//     per step. The schema is a oneOf where each branch is
//     { type: "tool_use", name: <const>, input: <strict schema> }, plus a
//     final_answer branch. Model emits structurally legal output every
//     time. Cheap (one round-trip per step).
//
//   "param-only" (two-pass): pass 1 pins ONLY a tool-name choice from a
//     closed enum; pass 2 (after we read the chosen name) pins ONLY the
//     args for that tool. The model sees the chosen tool name in pass 2's
//     prompt — the conjecture is that this gives small models a stronger
//     attention anchor on which schema applies. Costs 2× round-trips per
//     step.
//
// We ship both so the smoke directly measures whether the second pass is
// worth the round-trip cost. If arm-f-1pass already clears the threshold,
// arm-f doesn't need to ship to production; if 2pass beats 1pass by a
// margin > 2×-cost, the round-trip earns its keep.
//
// History rendering: each step's tool_use + tool_result is appended to the
// running ModelMessage[] as ContentBlock[] on assistant + tool roles. The
// existing OpenAICompatModel adapter (lines 469-477) already serializes
// these to OpenAI tool_calls / role:tool messages, so the on-the-wire
// shape is what every Ollama / OpenAI compat server expects.
//
// Ollama support (probe-confirmed 2026-06-13): /v1/chat/completions on
// localhost:11434 accepts response_format: {type: "json_schema",
// json_schema: {name, schema, strict:true}} and returns valid grammar-
// constrained JSON on qwen2.5:0.5b. Risk #1 from design ("Ollama
// enforcement is uneven") is empirically refuted for our specific stack.

const ARM_F_MAX_STEPS = 15;

interface StructuredCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

/**
 * Run a single grammar-pinned model.generate, drain the stream, return
 * the accumulated text + token usage. Same shape as `drainAgent` but
 * scoped to ONE call instead of an agent loop.
 *
 * `responseFormat` is forwarded as-is to the model; the
 * OpenAICompatModel adapter wraps it into the OpenAI-style
 * `response_format: {type:"json_schema", json_schema:{...}}` (lines
 * 182-195) when supportsGrammar is true.
 */
async function runOneStructuredCall(
  model: Model,
  messages: ModelMessage[],
  responseFormat: { type: "json_schema"; schema: object; name: string; strict?: boolean }
): Promise<StructuredCallResult> {
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | null = null;
  try {
    for await (const ev of model.generate(messages, {
      stream: true,
      responseFormat,
    })) {
      if (ev.type === "text_delta" && ev.delta) text += ev.delta;
      else if (ev.type === "usage" && ev.usage) {
        inputTokens += ev.usage.inputTokens ?? 0;
        outputTokens += ev.usage.outputTokens ?? 0;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { text, inputTokens, outputTokens, error };
}

/**
 * Pass-1 selection schema for the two-pass variant.
 *
 * Flat enum form: `{choice: "tool_name" | "final_answer"}`. The
 * conditional shape (`oneOf` with `answer: string` only when
 * choice=="final_answer") is the alternative; we start with the flat
 * form because (a) it's what the live Ollama probe confirmed working
 * on 0.5B, (b) it's simpler to debug, and (c) early termination is
 * recoverable — the loop runs the judge regardless and we'll
 * upgrade to the conditional form only if "premature final_answer"
 * shows up as a measurable failure mode in the smoke.
 */
function buildSelectionSchema(toolNames: string[]): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["choice"],
    properties: {
      choice: {
        type: "string",
        enum: [...toolNames, "final_answer"],
      },
    },
  };
}

/**
 * Pass-2 args schema for the two-pass variant — the strict JSON Schema
 * derived from the chosen tool's Zod input schema. Memoised per-tool so
 * we don't pay the recursive walk every step (R4 from the plan).
 */
function makeArgsSchemaCache(): (tool: ToolDefinition) => object {
  const cache = new Map<string, object>();
  return (tool: ToolDefinition) => {
    const cached = cache.get(tool.name);
    if (cached) return cached;
    const schema =
      tool.rawInputJsonSchema ?? (toStrictJsonSchema(tool.inputSchema as never) as object);
    cache.set(tool.name, schema);
    return schema;
  };
}

/**
 * One-pass schema: a oneOf where each branch fully pins the tool call
 * (name as const + input as the tool's strict args schema), plus a
 * final_answer branch. Mirrors the shape of
 * `packages/model-local/src/grammar.ts:69-95` (`buildToolCallSchema`)
 * but we re-derive here to keep dependency on model-local optional —
 * arm (f) runs against any OpenAI-compat endpoint without pulling in
 * the local-llama adapter.
 */
function buildOnePassSchema(
  tools: ToolDefinition[],
  argsSchema: (t: ToolDefinition) => object
): object {
  const toolBranches = tools.map((t) => ({
    type: "object",
    additionalProperties: false,
    required: ["type", "name", "input"],
    properties: {
      type: { type: "string", const: "tool_use" },
      name: { type: "string", const: t.name },
      input: argsSchema(t),
    },
  }));
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "answer"],
        properties: {
          type: { type: "string", const: "final_answer" },
          answer: { type: "string" },
        },
      },
      ...toolBranches,
    ],
  };
}

const ARM_F_SYSTEM_PROMPT =
  "You operate a sandboxed workspace by calling tools. " +
  "Each turn you will be asked to either call one tool or emit a final_answer. " +
  "Use the tools to drive the workspace state to satisfy the user's task. " +
  "When the task is complete, choose final_answer.\n\n" +
  "Path conventions: file paths in this workspace do NOT use a leading slash. " +
  "Day strings use ISO format (YYYY-MM-DD). When you receive an error like " +
  "'no such file', call list_files (or list_events) first to discover the " +
  "exact paths available; do not retry the same wrong path. " +
  "Calendar event times are minutes-from-midnight integers (e.g. 9:00 = 540).";

/**
 * Append a step's call + result to the running history as ContentBlock[]
 * on assistant + tool roles. The OpenAICompatModel adapter serializes
 * these to OpenAI tool_calls / role:tool messages (lines 469-477) — no
 * provider-specific code paths needed here.
 */
function appendToolUse(
  messages: ModelMessage[],
  toolUseId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: { output: unknown; isError: boolean }
): void {
  messages.push({
    role: "assistant",
    content: [{ type: "tool_use", id: toolUseId, name: toolName, input: args }],
  });
  const resultStr = result.isError
    ? `ERROR: ${typeof result.output === "string" ? result.output : JSON.stringify(result.output)}`
    : JSON.stringify(result.output ?? null);
  messages.push({
    role: "tool",
    content: [
      {
        type: "tool_result",
        toolUseId,
        content: resultStr,
        isError: result.isError,
      },
    ],
  });
}

/**
 * Two-pass param-only loop. Per step:
 *   pass 1: choose tool name (or final_answer)
 *   pass 2: fill args for the chosen tool
 *   exec:   tool runs against the cell's fixture, result appended to history
 *
 * Bounded by ARM_F_MAX_STEPS for parity with arms a/b/d.
 */
async function runArmF(args: {
  item: (typeof ITEMS)[number];
  model: ModelSpec;
}): Promise<RunItemResult> {
  const cell = prepareCell(args.item.id);
  const m = buildModel(args.model);
  const startMs = Date.now();

  const registry = new ToolRegistry();
  for (const t of cell.tools) registry.register(t);
  const toolByName = new Map<string, ToolDefinition>(cell.tools.map((t) => [t.name, t]));
  const toolNames = cell.tools.map((t) => t.name);
  const selectionSchema = buildSelectionSchema(toolNames);
  const argsSchema = makeArgsSchemaCache();

  const messages: ModelMessage[] = [
    { role: "system", content: ARM_F_SYSTEM_PROMPT },
    { role: "user", content: args.item.task },
  ];
  let totalIn = 0;
  let totalOut = 0;
  let lastError: string | null = null;
  let finalAnswer: string | null = null;

  for (let step = 1; step <= ARM_F_MAX_STEPS; step++) {
    // Pass 1: tool selection.
    const pickPrompt: ModelMessage = {
      role: "user",
      content:
        step === 1
          ? "Pick the next tool to call (or final_answer if the task is already complete)."
          : "Pick the next tool to call (or final_answer if the task is now complete).",
    };
    const pass1 = await runOneStructuredCall(m, [...messages, pickPrompt], {
      type: "json_schema",
      schema: selectionSchema,
      name: "tool_choice",
      strict: true,
    });
    totalIn += pass1.inputTokens;
    totalOut += pass1.outputTokens;
    if (pass1.error) {
      lastError = `pass1 step ${step}: ${pass1.error}`;
      break;
    }
    let choice: string;
    try {
      const parsed = JSON.parse(pass1.text) as { choice?: unknown };
      if (typeof parsed.choice !== "string")
        throw new Error(`pass1 returned no .choice: ${pass1.text}`);
      choice = parsed.choice;
    } catch (e) {
      lastError = `pass1 parse step ${step}: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
    if (choice === "final_answer") {
      finalAnswer = "DONE";
      break;
    }
    const tool = toolByName.get(choice);
    if (!tool) {
      // Should be unreachable under strict grammar, but defend against it.
      lastError = `pass1 step ${step}: enum returned unknown tool ${choice}`;
      break;
    }

    // Pass 2: arg fill for the chosen tool.
    const argPrompt: ModelMessage = {
      role: "user",
      content: `Provide arguments for ${choice} as a JSON object matching its input schema.`,
    };
    const pass2 = await runOneStructuredCall(m, [...messages, argPrompt], {
      type: "json_schema",
      schema: argsSchema(tool),
      name: `${choice}_args`,
      strict: true,
    });
    totalIn += pass2.inputTokens;
    totalOut += pass2.outputTokens;
    if (pass2.error) {
      lastError = `pass2 step ${step}: ${pass2.error}`;
      break;
    }
    let toolArgs: Record<string, unknown>;
    try {
      const parsed = JSON.parse(pass2.text);
      if (typeof parsed !== "object" || parsed === null)
        throw new Error(`pass2 not an object: ${pass2.text}`);
      toolArgs = parsed as Record<string, unknown>;
    } catch (e) {
      lastError = `pass2 parse step ${step}: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }

    // Execute.
    const callId = `f-${step}-${choice}`;
    const callResult = await registry.call({ toolName: choice, args: toolArgs, callId });
    appendToolUse(messages, callId, choice, toolArgs, {
      output: callResult.error ? callResult.error.message : callResult.output,
      isError: !!callResult.error,
    });
  }

  // Judge against the cell's terminal state.
  let passed = false;
  try {
    passed = cell.judge();
  } catch {
    passed = false;
  }
  if (lastError) passed = false;

  return {
    answer: finalAnswer,
    passed,
    wallMs: Date.now() - startMs,
    tokens: { input: totalIn, output: totalOut },
    error: lastError,
  };
}

export const armParamOnlySuite: BenchmarkSuite = {
  name: "mt-tool-exec.arm-f-param-only",
  title: "Arm (f) param-only two-pass (grammar-pinned name + args)",
  description:
    "Per step: pass 1 grammar-pins tool-name choice from a closed enum; pass 2 grammar-pins args for that exact tool. The model never makes both decisions in the same call. Tests whether wrong-name + wrong-arg-name is the failure mode that scaffold can address; if it is, accuracy lifts and the bottleneck moves elsewhere.",
  items: ITEMS,
  scorers: [],
  runItem: runArmF,
};

/**
 * One-pass comparator: same idea but combines name + args into ONE
 * grammar-pinned call per step. Cheaper; lets us measure whether the
 * second pass is worth the round-trip cost.
 */
async function runArmFOnePass(args: {
  item: (typeof ITEMS)[number];
  model: ModelSpec;
}): Promise<RunItemResult> {
  const cell = prepareCell(args.item.id);
  const m = buildModel(args.model);
  const startMs = Date.now();

  const registry = new ToolRegistry();
  for (const t of cell.tools) registry.register(t);
  const toolByName = new Map<string, ToolDefinition>(cell.tools.map((t) => [t.name, t]));
  const argsSchema = makeArgsSchemaCache();
  const onePassSchema = buildOnePassSchema(cell.tools, argsSchema);

  const messages: ModelMessage[] = [
    { role: "system", content: ARM_F_SYSTEM_PROMPT },
    { role: "user", content: args.item.task },
  ];
  let totalIn = 0;
  let totalOut = 0;
  let lastError: string | null = null;
  let finalAnswer: string | null = null;

  for (let step = 1; step <= ARM_F_MAX_STEPS; step++) {
    const pickPrompt: ModelMessage = {
      role: "user",
      content: "Emit ONE tool_use object (or final_answer) matching the schema.",
    };
    const result = await runOneStructuredCall(m, [...messages, pickPrompt], {
      type: "json_schema",
      schema: onePassSchema,
      name: "tool_use_or_final",
      strict: true,
    });
    totalIn += result.inputTokens;
    totalOut += result.outputTokens;
    if (result.error) {
      lastError = `step ${step}: ${result.error}`;
      break;
    }
    let parsed: { type?: unknown; name?: unknown; input?: unknown; answer?: unknown };
    try {
      parsed = JSON.parse(result.text);
    } catch (e) {
      lastError = `step ${step} parse: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
    if (parsed.type === "final_answer") {
      finalAnswer = typeof parsed.answer === "string" ? parsed.answer : "DONE";
      break;
    }
    if (parsed.type !== "tool_use" || typeof parsed.name !== "string") {
      lastError = `step ${step}: unrecognised structure ${result.text.slice(0, 100)}`;
      break;
    }
    const tool = toolByName.get(parsed.name);
    if (!tool) {
      lastError = `step ${step}: unknown tool ${parsed.name}`;
      break;
    }
    const toolArgs =
      typeof parsed.input === "object" && parsed.input !== null
        ? (parsed.input as Record<string, unknown>)
        : {};
    const callId = `f1-${step}-${parsed.name}`;
    const callResult = await registry.call({ toolName: parsed.name, args: toolArgs, callId });
    appendToolUse(messages, callId, parsed.name, toolArgs, {
      output: callResult.error ? callResult.error.message : callResult.output,
      isError: !!callResult.error,
    });
  }

  let passed = false;
  try {
    passed = cell.judge();
  } catch {
    passed = false;
  }
  if (lastError) passed = false;

  return {
    answer: finalAnswer,
    passed,
    wallMs: Date.now() - startMs,
    tokens: { input: totalIn, output: totalOut },
    error: lastError,
  };
}

export const armParamOnlyOnePassSuite: BenchmarkSuite = {
  name: "mt-tool-exec.arm-f-param-only-1pass",
  title: "Arm (f-1pass) param-only single-call (grammar-pinned tool_use)",
  description:
    "Same hypothesis as arm (f) but one model call per step instead of two: a oneOf grammar pins both name (const) and args (strict schema) per branch. Comparator for arm (f) — measures whether the second pass earns its round-trip.",
  items: ITEMS,
  scorers: [],
  runItem: runArmFOnePass,
};

// ── Arm (g) batch-grammar — single LLM call emits the FULL plan ──────────────
//
// Origin: 2026-06-17 ablation showed v7f arm-f 41.1% vs bare 12.2%, but
// `bare-wins=3` revealed that bare's rare wins came from a behavior arm-f
// can't replicate: emitting *multiple tool_calls in one turn* (cart-3step-
// add-remove `add×2 → add×1 → remove → checkout`). Pick/Provide loops
// dispose of that global plan because each step only sees a single tool
// decision. ToolCallingAgent (used by bare) supports multi-call emission
// natively via the OpenAI tools[] interface, but the 1.7B model elects
// not to use it 65/90 cells. We need a third path: grammar-strict
// *multi-call* output in ONE turn, no final_answer escape hatch.
//
// Hypothesis: if we let the model write the full plan upfront and pin it
// to a strict schema (oneOf branches × N items), v7f's accuracy on cart-
// with-undo / mixed-N-step / cal-4step recovers the gap that Pick/Provide
// gives up. The schema is `{plan: [<tool_use branch>, ...]}` with
// minItems=1 and maxItems=8 (>= 2× longest 4-step task).
//
// Why this isn't already arm-f-1pass: arm-f-1pass emits ONE tool_use per
// model call and loops; this emits the WHOLE plan in ONE call and does
// not loop. The model commits the entire trajectory before any tool runs.
// That's strictly weaker on tasks needing observe-then-decide (no feedback
// from intermediate tool results), but for tasks that ARE one-shot plans
// (most cart, cal-batch, file-rename) it removes the in-loop forgetting.
//
// Risk: 1.7B might emit a syntactically valid but semantically wrong plan
// (e.g. forgets the remove step too). If arm-batch ≤ arm-f, we've shown
// failure isn't "Pick/Provide losing global view" but "1.7B can't plan
// even when given the chance". That's an equally valuable null result.

const ARM_BATCH_MAX_PLAN = 8; // >= 2× longest 4-step task

function buildBatchPlanSchema(
  tools: ToolDefinition[],
  argsSchema: (t: ToolDefinition) => object
): object {
  const toolBranches = tools.map((t) => ({
    type: "object",
    additionalProperties: false,
    required: ["name", "input"],
    properties: {
      name: { type: "string", const: t.name },
      input: argsSchema(t),
    },
  }));
  return {
    type: "object",
    additionalProperties: false,
    required: ["plan"],
    properties: {
      plan: {
        type: "array",
        minItems: 1,
        maxItems: ARM_BATCH_MAX_PLAN,
        items: { oneOf: toolBranches },
      },
    },
  };
}

const ARM_BATCH_SYSTEM_PROMPT =
  "You operate a sandboxed workspace by calling tools. " +
  "You will receive ONE task and must respond with the COMPLETE PLAN of " +
  "tool calls needed to accomplish it, as a single JSON object: " +
  '{"plan": [{"name": "<tool>", "input": {...}}, ...]}. ' +
  "List every tool call you intend to make, in order. The runtime executes " +
  "them sequentially; you will NOT see intermediate results. Plan accordingly: " +
  "if the task requires inspecting state before acting, include both the " +
  "inspection call and the action calls in your plan up front.\n\n" +
  "Path conventions: file paths in this workspace do NOT use a leading slash. " +
  "Day strings use ISO format (YYYY-MM-DD). " +
  "Calendar event times are minutes-from-midnight integers (e.g. 9:00 = 540).";

async function runArmBatchGrammar(args: {
  item: (typeof ITEMS)[number];
  model: ModelSpec;
}): Promise<RunItemResult> {
  const cell = prepareCell(args.item.id);
  const m = buildModel(args.model);
  const startMs = Date.now();

  const registry = new ToolRegistry();
  for (const t of cell.tools) registry.register(t);
  const toolByName = new Map<string, ToolDefinition>(cell.tools.map((t) => [t.name, t]));
  const argsSchema = makeArgsSchemaCache();
  const planSchema = buildBatchPlanSchema(cell.tools, argsSchema);

  const messages: ModelMessage[] = [
    { role: "system", content: ARM_BATCH_SYSTEM_PROMPT },
    { role: "user", content: args.item.task },
  ];

  let totalIn = 0;
  let totalOut = 0;
  let lastError: string | null = null;
  let finalAnswer: string | null = null;

  const result = await runOneStructuredCall(m, messages, {
    type: "json_schema",
    schema: planSchema,
    name: "tool_plan",
    strict: true,
  });
  totalIn += result.inputTokens;
  totalOut += result.outputTokens;

  if (result.error) {
    lastError = `plan: ${result.error}`;
  } else {
    let plan: Array<{ name: string; input: Record<string, unknown> }>;
    try {
      const parsed = JSON.parse(result.text) as { plan?: unknown };
      if (!Array.isArray(parsed.plan))
        throw new Error(`plan field is not an array: ${result.text.slice(0, 200)}`);
      plan = parsed.plan as Array<{ name: string; input: Record<string, unknown> }>;
    } catch (e) {
      lastError = `plan parse: ${e instanceof Error ? e.message : String(e)}`;
      plan = [];
    }

    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      if (!step || typeof step.name !== "string") {
        lastError = `plan step ${i}: missing name`;
        break;
      }
      const tool = toolByName.get(step.name);
      if (!tool) {
        lastError = `plan step ${i}: unknown tool ${step.name}`;
        break;
      }
      const stepArgs =
        typeof step.input === "object" && step.input !== null
          ? (step.input as Record<string, unknown>)
          : {};
      const callId = `g-${i}-${step.name}`;
      try {
        await registry.call({ toolName: step.name, args: stepArgs, callId });
      } catch (e) {
        // Tool execution failures (e.g. file-not-found) are recoverable —
        // record but continue executing the rest of the plan; the judge
        // still runs against the terminal state. This mirrors how arm-f
        // handles per-step tool errors (treats them as in-loop content).
        lastError = `plan step ${i} exec: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    finalAnswer = "DONE";
  }

  let passed = false;
  try {
    passed = cell.judge();
  } catch {
    passed = false;
  }
  // Plan-level structural errors (parse / unknown tool / missing name)
  // void the run; per-step exec errors do NOT (judge is the truth).
  if (lastError && !lastError.startsWith("plan step ") /* exec */) {
    if (
      !lastError.startsWith("plan step ") ||
      lastError.includes("missing name") ||
      lastError.includes("unknown tool")
    ) {
      passed = false;
    }
  }

  return {
    answer: finalAnswer,
    passed,
    wallMs: Date.now() - startMs,
    tokens: { input: totalIn, output: totalOut },
    error: lastError,
  };
}

export const armBatchGrammarSuite: BenchmarkSuite = {
  name: "mt-tool-exec.arm-g-batch-grammar",
  title: "Arm (g) batch-grammar (single-call full plan)",
  description:
    "Single LLM call emits the COMPLETE plan as {plan: [{name, input}, ...]} under a strict json_schema (oneOf per tool, minItems=1, maxItems=8). Tools run sequentially after the call returns; model sees no intermediate results. Tests whether 1.7B's bare-wins behavior (multi-call in one turn) survives when grammar pins schema legality without sacrificing global plan view.",
  items: ITEMS,
  scorers: [],
  runItem: runArmBatchGrammar,
};

// ── Suite registry for the ablation script ──────────────────────────────────
export const ABLATION_ARMS: Record<string, BenchmarkSuite> = {
  bare: armBareSuite,
  grammar: armGrammarSuite,
  code: armCodeSuite,
  "self-consist": armSelfConsistencySuite,
  full: armFullSuite,
  "param-only": armParamOnlySuite,
  "param-only-1pass": armParamOnlyOnePassSuite,
  "batch-grammar": armBatchGrammarSuite,
};
