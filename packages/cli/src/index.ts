#!/usr/bin/env node

/**
 * wasmagent CLI (D6)
 *
 * Usage:
 *   wasmagent run "<task>" [--model claude-sonnet-4-6] [--max-steps 20]
 *                         [--stream] [--events run_start,step_start,...]
 *   wasmagent init-tool --name <name> [--output <dir>]
 *
 * Mirrors smolagents' `smolagent` CLI (cli.py:294).
 */

import { readFile as fsReadFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve as pathResolve } from "node:path";
import { parseArgs } from "node:util";
import type {
  AdaptationDecision,
  AdaptationProposal,
  AgentEvent,
  AnthropicModelId,
  AnthropicModelOptions,
  Criterion,
  RankedBranch,
  ToolDefinition,
  WorkspaceReader,
} from "@wasmagent/core";
import {
  AnthropicModel,
  AnthropicModels,
  CodeAgent,
  DeterministicVerifier,
  GoalDirectedAgent,
  toDpoRecord,
  toJsonl,
  toPpoRecords,
  VerificationPipeline,
} from "@wasmagent/core";

/**
 * Build an `AnthropicModel` from CLI flags + env vars.
 *
 * The official `@anthropic-ai/sdk` honors `ANTHROPIC_BASE_URL` directly when
 * the user constructs the SDK client themselves, but `AnthropicModel` only
 * forwards `baseURL` if it is passed in `AnthropicModelOptions`. CLI users
 * setting `ANTHROPIC_BASE_URL` (e.g. to point at a local proxy) would
 * otherwise be silently ignored — so we wire the env var through here, in
 * one place shared by `wasmagent run` and `wasmagent goal`.
 *
 * Precedence: explicit `--base-url` flag > `ANTHROPIC_BASE_URL` env > unset.
 */
export function buildAnthropicModel(
  opts: Record<string, string | boolean | undefined>,
  apiKey: string
): AnthropicModel {
  const modelId =
    typeof opts.model === "string"
      ? (opts.model as AnthropicModelId)
      : AnthropicModels.SONNET_LATEST;
  const baseURL =
    typeof opts["base-url"] === "string" ? opts["base-url"] : process.env.ANTHROPIC_BASE_URL;
  const modelOpts: AnthropicModelOptions = { apiKey };
  if (baseURL) modelOpts.baseURL = baseURL;
  return new AnthropicModel(modelId, modelOpts);
}

// Source-of-truth for the CLI version. Synced manually from
// packages/cli/package.json's "version" field on each release. We
// don't `import "../package.json" with { type: "json" }` because
// that's a TypeScript 5.4+ flag and the published `dist/` JS lives
// next to dist/index.js, not the package.json — runtime path
// resolution of "../package.json" depends on whether the user
// installed via npm (works) or runs from a workspace symlink (also
// works, but with a different relative depth). A literal avoids both
// surprises.
const CLI_VERSION = "0.2.0";

const ROLLOUT_BRANCH_REQUIRED_FIELDS = [
  "rollout_id",
  "task",
  "branch_index",
  "temperature",
  "session_id",
  "tool_call_sequence",
  "final_answer",
] as const;

// Only run CLI dispatch when executed as the entry point, not when imported by tests.
const isMain =
  process.argv[1] != null &&
  new URL(import.meta.url).pathname.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").at(-1) ?? ""
  );

if (isMain) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string", default: AnthropicModels.SONNET_LATEST },
      "max-steps": { type: "string", default: "20" },
      "api-key": { type: "string" },
      stream: { type: "boolean", default: false },
      events: { type: "string" },
      name: { type: "string" },
      output: { type: "string", default: "." },
      lang: { type: "string", default: "ts" },
      // A4 (S3, 2026-06): `wasmagent devtools` flags. `events` doubles as both
      // the run-command filter and the devtools NDJSON input path.
      "events-file": { type: "string" },
      // D5 (2026-06): framework-agnostic GenAI semconv ingest. Either NDJSON
      // (one span per line) or OTLP/JSON (`{resourceSpans: …}`). When set,
      // takes precedence over --events-file so users can compare a Vercel
      // AI SDK or Mastra trace in the same Studio view.
      "otel-events-file": { type: "string" },
      port: { type: "string", default: "4317" },
      // 2026-06-12: `wasmagent evals` flags. `--suite` accepts comma-separated
      // names; `--models` is comma-separated `id@baseUrl#modelId` triples;
      // `--seeds` is comma-separated integers.
      suite: { type: "string" },
      models: { type: "string" },
      seeds: { type: "string", default: "0,1,2" },
      "base-url": { type: "string" },
      "report-file": { type: "string" },
      // 2026-06-12: `wasmagent model` (L6) flags. Loaded lazily via
      // @wasmagent/model-local — no impact on `wasmagent run` users who
      // don't install the local-model peer.
      mirror: { type: "string" },
      "cache-dir": { type: "string" },
      // 2026-06-18: `wasmagent goal` (G2 of cli-gap-analysis-2026-06-18.md)
      // and `wasmagent verify` (G3) flags. Goal-directed loop: max
      // iterations + judge sample count. Verify: a JSON file of
      // Criterion[].
      "max-iterations": { type: "string", default: "5" },
      "judge-samples": { type: "string", default: "3" },
      "judge-majority": { type: "boolean", default: false },
      // 2026-06-18 (axis 9, L3) — opt into goal adaptation negotiation.
      // CI users with --from-criteria should leave this off (the
      // determinism is the point); humans iterating in a UI/REPL benefit.
      "allow-negotiate": { type: "boolean", default: false },
      workspace: { type: "string", default: "." },
      criteria: { type: "string" },
      // 2026-06-18: Skip Phase 1 synthesis and load Criterion[] from a
      // JSON file. CI-friendly — the same input always produces the
      // same grader. The file is the same shape `wasmagent verify`
      // accepts: either a top-level array, or `{criteria: [...]}`.
      "from-criteria": { type: "string" },
      // Note: --base-url flag is already declared above for `wasmagent evals`
      // (it falls back to http://localhost:11434/v1 there). buildAnthropicModel
      // reuses the same flag for `wasmagent run` / `wasmagent goal`, falling back
      // to ANTHROPIC_BASE_URL env var instead of a hardcoded ollama URL.
      // 2026-06-23: `wasmagent validate-rollouts` / `wasmagent export-rollouts`
      // flags. --in is the input JSONL path; --format selects DPO vs PPO;
      // --out is the output path (stdout if absent).
      in: { type: "string" },
      format: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
  });

  if (values.version) {
    // Print just the version (parse-friendly for CI scripts).
    // The literal is replaced by the published package version at
    // build time; the placeholder below matches the source-of-truth in
    // packages/cli/package.json.
    console.log(CLI_VERSION);
    process.exit(0);
  }

  if (values.help || positionals.length === 0) {
    printHelp();
    process.exit(0);
  }

  const [command, ...rest] = positionals;

  switch (command) {
    case "run":
      await runCommand(rest.join(" "), values);
      break;
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: intentional fallthrough to init-tool for backwards compat
    case "init":
      // `init <project-name>` → scaffold a new agent project directory.
      // `init` with no positional falls through to init-tool for backwards compat.
      if (rest.length > 0) {
        await initProjectCommand(rest[0] as string, values);
        break;
      }
    // falls through
    case "init-tool":
      await initToolCommand(values);
      break;
    case "devtools":
      await devtoolsCommand(values);
      break;
    case "evals":
      await evalsCommand(rest, values);
      break;
    case "model":
      await modelCommand(rest, values);
      break;
    case "goal":
      await goalCommand(rest.join(" "), values);
      break;
    case "verify":
      await verifyCommand(values);
      break;
    case "validate-rollouts":
      await validateRolloutsCommand(positionals[1] as string | undefined, values);
      break;
    case "export-rollouts":
      await exportRolloutsCommand(values);
      break;
    case "version":
    case "--version":
      console.log(CLI_VERSION);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

// ── run command ───────────────────────────────────────────────────────────────

export async function runCommand(
  task: string,
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  if (!task) {
    console.error('Error: no task provided. Usage: wasmagent run "<task>"');
    process.exit(1);
  }

  const apiKey =
    typeof opts["api-key"] === "string" ? opts["api-key"] : process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY env var or --api-key flag required");
    process.exit(1);
  }

  const streamMode = opts.stream === true;
  const eventsFilter = parseEventsFilter(
    typeof opts.events === "string" ? opts.events : undefined,
    streamMode
  );

  const model = buildAnthropicModel(opts, apiKey);
  const maxSteps = parseInt(typeof opts["max-steps"] === "string" ? opts["max-steps"] : "20", 10);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) {
    console.error("Error: --max-steps must be a whole number between 1 and 1000");
    process.exit(1);
  }
  const agent = new CodeAgent({ tools: [], model, maxSteps });

  if (!streamMode) console.log(`Running: ${task}\n`);

  let stepCount = 0;

  for await (const event of agent.run(task)) {
    if (!eventsFilter.has(event.event)) continue;

    if (streamMode) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      continue;
    }

    switch (event.event) {
      case "run_start":
        break;
      case "step_start": {
        stepCount = event.data.step;
        process.stderr.write(`\n[step ${stepCount}] `);
        break;
      }
      case "thinking_delta":
        process.stdout.write(event.data.delta);
        break;
      case "planning": {
        const { step, plan, facts } = event.data;
        console.log(`\n\n[planning @ step ${step ?? stepCount}]`);
        console.log(`Plan: ${plan}`);
        if (facts) console.log(`Facts: ${facts}`);
        break;
      }
      case "tool_call":
        console.log(`\n[tool_call] ${event.data.toolName}(${JSON.stringify(event.data.args)})`);
        break;
      case "tool_result":
        if (event.data.error) {
          console.log(`[tool_result] ERROR: ${JSON.stringify(event.data.error)}`);
        } else {
          console.log(
            `[tool_result] ${event.data.toolName} → ${JSON.stringify(event.data.output)}`
          );
        }
        break;
      case "final_answer":
        console.log("\n\nFinal answer:", event.data.answer);
        break;
      case "error":
        console.error("\nError:", event.data.error);
        break;
    }
  }
}

// ── init project command ──────────────────────────────────────────────────────

async function initProjectCommand(
  projectName: string,
  _opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const kebab = projectName.replace(/\s+/g, "-").toLowerCase();
  const dir = pathResolve(kebab);
  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: kebab,
        version: "0.1.0",
        type: "module",
        scripts: { start: "node --input-type=module < agent.mjs" },
        dependencies: {
          "@wasmagent/core": "latest",
          "@wasmagent/aisdk": "latest",
          "@wasmagent/kernel-quickjs": "latest",
          "@anthropic-ai/sdk": "latest",
        },
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    join(dir, "agent.mjs"),
    `// Minimal wasmagent starter — generated by: npx @wasmagent/cli init ${kebab}
import { AnthropicModel, ToolCallingAgent } from "@wasmagent/core";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { sandboxedJsTool } from "@wasmagent/aisdk";

const kernel = new QuickJSKernel();
const agent = new ToolCallingAgent({
  model: new AnthropicModel({ model: "claude-haiku-4-5-20251001" }),
  tools: [sandboxedJsTool({ kernel })],
  systemPrompt: "You are a coding assistant with a safe JS sandbox.",
});

const result = await agent.run("Calculate the first 10 Fibonacci numbers.");
console.log(result.finalAnswer);
`,
    "utf8"
  );

  await writeFile(join(dir, ".env.example"), "ANTHROPIC_API_KEY=your-key-here\n", "utf8");

  console.log(`✓ Created ${kebab}/`);
  console.log(`\nNext steps:`);
  console.log(`  cd ${kebab}`);
  console.log(`  npm install`);
  console.log(`  export ANTHROPIC_API_KEY=<your-key>`);
  console.log(`  npm start`);
}

// ── init-tool command ─────────────────────────────────────────────────────────

async function initToolCommand(opts: Record<string, string | boolean | undefined>): Promise<void> {
  const rawName = typeof opts.name === "string" ? opts.name.trim() : "";
  if (!rawName) {
    console.error("Error: --name <tool-name> is required");
    console.error("  Example: wasmagent init-tool --name web-search");
    process.exit(1);
  }

  const lang = typeof opts.lang === "string" ? opts.lang : "ts";
  if (lang !== "ts" && lang !== "rust") {
    console.error(`Error: --lang must be "ts" or "rust", got "${lang}"`);
    process.exit(1);
  }

  // Normalise name: kebab-case file, PascalCase class.
  const kebabName = rawName.replace(/\s+/g, "-").toLowerCase();
  const pascalName = kebabName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  const snakeName = kebabName.replace(/-/g, "_");

  const outputDir = typeof opts.output === "string" ? opts.output : ".";
  await mkdir(outputDir, { recursive: true });

  if (lang === "rust") {
    await initToolRust(kebabName, snakeName, pascalName, outputDir);
  } else {
    await initToolTs(kebabName, pascalName, outputDir);
  }
}

async function initToolTs(kebabName: string, pascalName: string, outputDir: string): Promise<void> {
  const toolFile = join(outputDir, `${kebabName}.ts`);
  const testFile = join(outputDir, `${kebabName}.test.ts`);
  await writeFile(toolFile, generateToolTemplate(kebabName, pascalName), "utf8");
  await writeFile(testFile, generateTestTemplate(kebabName, pascalName), "utf8");
  console.log(`✓ Created ${toolFile}`);
  console.log(`✓ Created ${testFile}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Fill in forward() in ${toolFile}`);
  console.log(`  2. Run: bun test ${testFile}`);
}

async function initToolRust(
  kebabName: string,
  snakeName: string,
  pascalName: string,
  outputDir: string
): Promise<void> {
  const rustDir = join(outputDir, kebabName);
  const srcDir = join(rustDir, "src");
  await mkdir(srcDir, { recursive: true });

  const cargoToml = join(rustDir, "Cargo.toml");
  const libRs = join(srcDir, "lib.rs");
  const wrapperTs = join(rustDir, `${kebabName}.ts`);

  await writeFile(cargoToml, generateCargoTemplate(kebabName, snakeName), "utf8");
  await writeFile(libRs, generateRustLibTemplate(snakeName, pascalName), "utf8");
  await writeFile(wrapperTs, generateRustWrapperTemplate(kebabName, pascalName, snakeName), "utf8");

  console.log(`✓ Created ${cargoToml}`);
  console.log(`✓ Created ${libRs}`);
  console.log(`✓ Created ${wrapperTs}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Install wasm-pack: cargo install wasm-pack`);
  console.log(`  2. Build: cd ${rustDir} && wasm-pack build --target nodejs`);
  console.log(`  3. Import the generated JS wrapper from ${wrapperTs}`);
}

export function generateToolTemplate(kebabName: string, pascalName: string): string {
  return `import { z } from "zod";
import type { ToolDefinition } from "@wasmagent/core";

/**
 * ${pascalName} tool.
 * Generated by: wasmagent init-tool --name ${kebabName}
 */
export const ${camelCase(pascalName)}Tool: ToolDefinition<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: "${kebabName}",
  description: "FILL IN: describe what this tool does",
  inputSchema: z.object({
    // FILL IN: define input fields
    query: z.string().describe("The input query"),
  }),
  outputSchema: z.string(),
  readOnly: true,    // FILL IN: set to false if this tool has side effects
  idempotent: true,  // FILL IN: set to false if repeated calls produce different results
  async forward(input) {
    // FILL IN: implement the tool logic
    throw new Error(\`${pascalName}: not yet implemented (input: \${JSON.stringify(input)})\`);
  },
};

const inputSchema = ${camelCase(pascalName)}Tool.inputSchema;
const outputSchema = ${camelCase(pascalName)}Tool.outputSchema;
`;
}

export function generateTestTemplate(kebabName: string, pascalName: string): string {
  return `import { describe, it, expect } from "bun:test";
import { ${camelCase(pascalName)}Tool } from "./${kebabName}.js";

describe("${pascalName} tool", () => {
  it("is registered with correct metadata", () => {
    expect(${camelCase(pascalName)}Tool.name).toBe("${kebabName}");
    expect(typeof ${camelCase(pascalName)}Tool.description).toBe("string");
    expect(${camelCase(pascalName)}Tool.description.length).toBeGreaterThan(0);
    expect(typeof ${camelCase(pascalName)}Tool.readOnly).toBe("boolean");
    expect(typeof ${camelCase(pascalName)}Tool.idempotent).toBe("boolean");
  });

  it("validates input schema", () => {
    const result = ${camelCase(pascalName)}Tool.inputSchema.safeParse({ query: "test" });
    expect(result.success).toBe(true);
  });

  it("forward() returns a string", async () => {
    // FILL IN: replace this with a real test once forward() is implemented
    await expect(
      ${camelCase(pascalName)}Tool.forward({ query: "test" } as never)
    ).rejects.toThrow("not yet implemented");
  });
});
`;
}

export function camelCase(pascal: string): string {
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function generateCargoTemplate(kebabName: string, _snakeName: string): string {
  return `[package]
name = "${kebabName}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
serde = { version = "1", features = ["derive"] }
serde-wasm-bindgen = "0.6"
`;
}

function generateRustLibTemplate(snakeName: string, pascalName: string): string {
  return `use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct ${pascalName}Input {
    // FILL IN: define input fields
    pub query: String,
}

#[derive(Serialize)]
pub struct ${pascalName}Output {
    pub result: String,
}

/// ${pascalName} — main entry point called from the wasmagent TypeScript wrapper.
#[wasm_bindgen]
pub fn ${snakeName}(input_json: &str) -> Result<String, JsValue> {
    let input: ${pascalName}Input = serde_json::from_str(input_json)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    // FILL IN: implement tool logic
    let output = ${pascalName}Output {
        result: format!("${pascalName} received: {}", input.query),
    };

    serde_json::to_string(&output)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
`;
}

function generateRustWrapperTemplate(
  kebabName: string,
  pascalName: string,
  snakeName: string
): string {
  return `/**
 * ${pascalName} — TypeScript wrapper around the compiled WASM module.
 * Generated by: wasmagent init-tool --name ${kebabName} --lang rust
 *
 * Build the WASM first: wasm-pack build --target nodejs
 * Then this file imports from the generated ./pkg/ directory.
 */
import { z } from "zod";
import type { ToolDefinition } from "@wasmagent/core";

// Lazy-loaded WASM module — initialised on first call.
let _wasmModule: { ${snakeName}: (input: string) => string } | null = null;

async function loadWasm() {
  if (!_wasmModule) {
    // Adjust path if wasm-pack builds to a different location.
    _wasmModule = await import("./${kebabName}/pkg/${kebabName}.js" as string);
  }
  return _wasmModule;
}

export const ${camelCase(pascalName)}Tool: ToolDefinition<
  { query: string },
  string
> = {
  name: "${kebabName}",
  description: "FILL IN: describe what this tool does",
  inputSchema: z.object({
    query: z.string().describe("The input query"),
  }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: true,
  async forward(input) {
    const wasm = await loadWasm();
    const result = wasm.${snakeName}(JSON.stringify(input));
    const parsed = JSON.parse(result) as { result: string };
    return parsed.result;
  },
};
`;
}

// ── shared helpers ────────────────────────────────────────────────────────────

type EventType = AgentEvent["event"];

const ALL_EVENT_TYPES: EventType[] = [
  "run_start",
  "step_start",
  "thinking_delta",
  "tool_call",
  "tool_result",
  "planning",
  "final_answer",
  "error",
];

export function parseEventsFilter(raw: string | undefined, streamMode: boolean): Set<EventType> {
  if (raw) {
    const requested = raw.split(",").map((s) => s.trim()) as EventType[];
    return new Set(
      requested.filter((e): e is EventType => (ALL_EVENT_TYPES as string[]).includes(e))
    );
  }
  if (streamMode) return new Set(ALL_EVENT_TYPES);
  return new Set<EventType>([
    "step_start",
    "thinking_delta",
    "planning",
    "tool_call",
    "tool_result",
    "final_answer",
    "error",
  ]);
}

function printHelp(): void {
  console.log(`
wasmagent — TypeScript agent runtime (wasmagent-js v0.1.0)

Usage:
  wasmagent run "<task>" [options]
  wasmagent goal "<task>" [options]
  wasmagent verify --criteria <path.json> [--workspace .]
  wasmagent init-tool --name <tool-name> [options]
  wasmagent devtools --events-file <ndjson> [--port 4317]
  wasmagent devtools --otel-events-file <ndjson|otlp.json> [--port 4317]
  wasmagent evals list
  wasmagent evals run --suite=<names> --models=<id@url[#modelId],...> [--seeds=0,1,2]
  wasmagent model list
  wasmagent model pull <alias> [--mirror=<huggingface|hf-mirror|modelscope|<url>>] [--cache-dir=<path>]
  wasmagent model verify <alias> [--cache-dir=<path>]
  wasmagent model rm <alias> [--cache-dir=<path>]
  wasmagent validate-rollouts <path.jsonl>
  wasmagent export-rollouts --in <path.jsonl> --format dpo|ppo [--out <output.jsonl>]

Commands:
  run "<task>"              Run a single-shot CodeAgent loop on a task
  goal "<task>"             Run a GoalDirectedAgent — synthesises success criteria,
                            executes, verifies, retries until verified or capped
  verify                    Run deterministic verifier checks against a workspace
                            (no LLM); criteria from a JSON file. CI-friendly.
  init-tool                 Scaffold a new ToolDefinition file (TypeScript or Rust/WASM)
  devtools                  Start the local Studio (zero-deploy runs overview)
  evals list                List the reference benchmark suites
  evals run                 Run a multi-model multi-suite evaluation; output a Pareto report
  model list                List registered local models (Qwen/Gemma/Llama 1B-class)
  model pull <alias>        Download a registered local model with sha256 verification
  model verify <alias>      Recompute sha256 of the cached file and compare
  model rm <alias>          Delete the cached model file
  validate-rollouts         Validate a JSONL file of rollout branch records against
                            the rollout wire schema (field presence checks)
  export-rollouts           Convert rollout branch records to DPO or PPO training records

run options:
  --model <id>             Model ID (default: claude-sonnet-4-6)
  --max-steps <n>          Maximum agent steps (default: 20)
  --api-key <key>          Anthropic API key (or set ANTHROPIC_API_KEY)
  --base-url <url>         Override Anthropic base URL — useful for local proxies
                           (or set ANTHROPIC_BASE_URL; e.g. an in-house gateway)
  --stream                 Output all events as NDJSON (pipe-friendly)
  --events <types>         Comma-separated event types to include
  -h, --help               Show this help

goal options:
  --model <id>             Executor model ID (default: claude-sonnet-4-6)
  --workspace <dir>        Workspace root for read_file/write_file (default: .)
  --max-iterations <n>     Goal-loop iteration cap (default: 5, max 20)
  --judge-samples <n>      LLMJudge calls per llm_judge criterion (default: 3)
  --judge-majority         Pass criterion on majority vote instead of unanimous
  --from-criteria <path>   Skip Phase 1 synthesis; load Criterion[] from JSON
                           (CI-friendly; same shape as wasmagent verify accepts)
  --allow-negotiate        On exhausted iterations, ask the synth model to
                           propose a relaxed criteria set; prompts y/N on stdin.
                           No-op when --from-criteria is set (CI determinism).
  --api-key <key>          Anthropic API key (or set ANTHROPIC_API_KEY)
  --base-url <url>         Override Anthropic base URL (or set ANTHROPIC_BASE_URL)
  --stream                 Output all events as NDJSON (pipe-friendly)

verify options:
  --criteria <path>        JSON file with Criterion[] or {criteria: Criterion[]}
  --workspace <dir>        Workspace root (default: .)

init-tool options:
  --name <name>            Tool name in kebab-case (required)
  --lang <lang>            Template language: "ts" (default) or "rust" (WASM)
  --output <dir>           Output directory (default: current directory)

devtools options:
  --events-file <path>     NDJSON event log file produced by EventLog.exportNdjson()
                           or any file with one LoggedEvent JSON per line.
  --otel-events-file <p>   GenAI semconv source — NDJSON of spans, or OTLP/JSON
                           ({resourceSpans:…}). Lets you point the Studio at a
                           Vercel AI SDK / Mastra / OpenAI Agents JS trace.
  --port <port>            HTTP port (default: 4317)

evals options:
  --suite <names>          Comma-separated suite names. Try \`evals list\` for the catalogue.
  --models <list>          Comma-separated id@baseUrl[#modelId] specs.
                           Example: --models="qwen2.5:0.5b@http://localhost:11434/v1"
  --base-url <url>         Default base URL for models that omit '@' (default: http://localhost:11434/v1)
  --seeds <list>           Comma-separated seeds (default: 0,1,2 — matches the ≥3-seed paired-stats discipline)
  --report-file <path>     Write the markdown report to this file instead of stdout

validate-rollouts options:
  <path.jsonl>             JSONL file of RolloutBranchRecord objects to validate

export-rollouts options:
  --in <path.jsonl>        Input JSONL file of RolloutBranchRecord objects (required)
  --format dpo|ppo         Output training record format (required)
  --out <output.jsonl>     Output file path (default: stdout)

Examples:
  wasmagent run "What is 2+2?"
  wasmagent run "Analyse data" --stream | jq .
  wasmagent run "Search AI news" --events final_answer,error
  wasmagent goal "Write a 1500-word intro to OAuth in oauth.md" --workspace ./tmp
  wasmagent goal "Write the intro" --from-criteria ./criteria.json --workspace ./tmp
  wasmagent verify --criteria criteria.json --workspace ./tmp
  wasmagent init-tool --name web-search --output ./tools
  wasmagent devtools --events-file ./events.ndjson
  wasmagent evals list
  wasmagent evals run --suite=multi-turn-memory --models=qwen2.5:0.5b@http://localhost:11434/v1
  wasmagent validate-rollouts ./rollouts.jsonl
  wasmagent export-rollouts --in rollouts.jsonl --format dpo --out dpo.jsonl
  wasmagent export-rollouts --in rollouts.jsonl --format ppo
`);
}

// ── A4: devtools command — local Studio, zero-deploy ─────────────────────────

/**
 * A4 (S3, 2026-06): start a local "Studio" HTTP server on the supplied
 * NDJSON event log. The server serves:
 *
 *   - GET  /                  static HTML overview page (vanilla, no React)
 *   - GET  /api/runs          per-run summaries from RunsAggregator
 *   - GET  /api/rollup        corpus rollup (cost / tokens / median+p95 / errors)
 *
 * Why an HTML+JSON server and not a desktop GUI: per the S3 brief, Studio
 * must stay zero-deploy and runtime-agnostic. Plain HTML lets us serve from
 * Node, Bun, Workers; the React overlay (in `@wasmagent/devtools/react`)
 * is opt-in for callers who already have a Vite/Next pipeline.
 */
export async function devtoolsCommand(
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  // Lazy import — devtools is its own peer with React types; we don't want
  // run/init-tool callers to load it.
  const dt = (await import("@wasmagent/devtools")) as {
    groupByTraceId: (e: unknown[]) => Map<string, unknown[]>;
    rollupRuns: (s: unknown[]) => unknown;
    summariseRun: (e: unknown[]) => unknown;
    parseGenAiInput: (raw: string) => unknown[];
    convertGenAiSpansToEvents: (spans: unknown[]) => {
      events: unknown[];
      skipped: number;
      tracesSeen: number;
    };
  };
  const { groupByTraceId, rollupRuns, summariseRun, parseGenAiInput, convertGenAiSpansToEvents } =
    dt;

  const eventsPath = opts["events-file"] as string | undefined;
  const otelPath = opts["otel-events-file"] as string | undefined;
  if (!eventsPath && !otelPath) {
    console.error("Error: --events-file <path> or --otel-events-file <path> is required.");
    console.error("  wasmagent devtools --events-file ./events.ndjson");
    console.error(
      "  wasmagent devtools --otel-events-file ./trace.ndjson  # any GenAI semconv source"
    );
    process.exit(1);
  }
  const port = Number.parseInt((opts.port as string) ?? "4317", 10);

  // Read once on startup; the file is small (event logs for a single agent
  // run rarely exceed a few MB) and re-reading on every request would
  // surprise users who expect "this view reflects the file at startup".
  // Re-running the CLI is the refresh story; explicit > magic.
  let events: unknown[] = [];
  let sourceLabel = "";
  if (otelPath) {
    const raw = await readFile(otelPath, "utf8");
    const spans = parseGenAiInput(raw);
    const conv = convertGenAiSpansToEvents(spans);
    events = conv.events;
    sourceLabel = `${otelPath} (GenAI semconv: ${spans.length} spans → ${conv.events.length} events, ${conv.tracesSeen} trace(s)${conv.skipped ? `, ${conv.skipped} skipped` : ""})`;
  } else {
    const raw = await readFile(eventsPath as string, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines but report once at startup so the user knows
        // there's noise in their file.
        console.error(`Skipping malformed NDJSON line: ${trimmed.slice(0, 80)}…`);
      }
    }
    sourceLabel = eventsPath as string;
  }

  const grouped = groupByTraceId(events);
  const summaries = [...grouped.values()].map(summariseRun);
  const rollup = rollupRuns(summaries);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname === "/api/runs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(summaries));
      return;
    }
    if (url.pathname === "/api/rollup") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rollup));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderStudioHtml());
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`wasmagent Studio: http://localhost:${port} (source: ${sourceLabel})`);
  console.log(
    `Tracking ${summaries.length} run${summaries.length === 1 ? "" : "s"} ` +
      `(${(rollup as { totalCostUsd: number }).totalCostUsd.toFixed(4)} USD total).`
  );
  console.log("Press Ctrl-C to stop.");
}

function renderStudioHtml(): string {
  // Inline page so the CLI binary stays single-file. The page fetches
  // /api/rollup + /api/runs once and renders a metric card + a runs table.
  // No React, no build step — runs in Bun, Node 20+, plain browsers.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>wasmagent Studio</title>
  <style>
    body{font:14px/1.5 system-ui,Segoe UI,Helvetica,Arial,sans-serif;margin:24px;color:#222;}
    h1{margin:0 0 4px;font-size:18px;}
    .sub{color:#666;font-size:12px;margin-bottom:16px;}
    .cards{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:12px;margin-bottom:24px;}
    .card{border:1px solid #ddd;border-radius:8px;padding:12px;background:#fafafa;}
    .card h3{margin:0;font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.5px;}
    .card .v{font-size:22px;font-weight:600;margin-top:4px;}
    table{width:100%;border-collapse:collapse;font-size:13px;}
    th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left;}
    th{background:#f5f5f5;font-weight:600;}
    .ok{color:#0a7;}
    .fail{color:#c00;}
    .num{text-align:right;font-variant-numeric:tabular-nums;}
  </style>
</head>
<body>
  <h1>wasmagent Studio</h1>
  <div class="sub">A4 — local runs overview · pure-logic aggregator from <code>@wasmagent/devtools</code></div>
  <div id="cards" class="cards"></div>
  <table>
    <thead><tr>
      <th>Trace</th><th>Outcome</th><th class="num">Wall (ms)</th><th class="num">Steps</th>
      <th class="num">Tokens</th><th class="num">USD</th><th>Final answer</th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <script>
    function fmtMs(n){return Math.round(n).toLocaleString();}
    function fmtUsd(n){return '$'+n.toFixed(4);}
    function fmtTokens(t){return (t.input+t.output).toLocaleString();}
    Promise.all([fetch('/api/rollup').then(r=>r.json()),fetch('/api/runs').then(r=>r.json())])
      .then(([rollup,runs])=>{
        const cards=document.getElementById('cards');
        const cardData=[
          ['Total runs', rollup.totalRuns],
          ['Total cost', fmtUsd(rollup.totalCostUsd)],
          ['Median wall', fmtMs(rollup.medianWallMs)+' ms'],
          ['p95 wall', fmtMs(rollup.p95WallMs)+' ms'],
          ['Error rate', (rollup.errorRate*100).toFixed(1)+'%'],
          ['Input tokens', rollup.totalInputTokens.toLocaleString()],
          ['Output tokens', rollup.totalOutputTokens.toLocaleString()],
          ['Cache-read tokens', rollup.totalCacheReadTokens.toLocaleString()],
        ];
        cards.style.gridTemplateColumns='repeat('+Math.min(cardData.length,4)+',minmax(180px,1fr))';
        for(const [h,v] of cardData){
          const c=document.createElement('div');c.className='card';
          c.innerHTML='<h3>'+h+'</h3><div class="v">'+v+'</div>';
          cards.appendChild(c);
        }
        const tb=document.getElementById('rows');
        runs.sort((a,b)=>b.startTs-a.startTs);
        for(const r of runs){
          const tr=document.createElement('tr');
          tr.innerHTML=
            '<td>'+r.traceId+'</td>'+
            '<td class="'+(r.outcome==='complete'?'ok':r.outcome==='failed'?'fail':'')+'">'+r.outcome+'</td>'+
            '<td class="num">'+fmtMs(r.wallMs)+'</td>'+
            '<td class="num">'+r.steps+'</td>'+
            '<td class="num">'+fmtTokens(r.tokens)+'</td>'+
            '<td class="num">'+fmtUsd(r.costUsd)+'</td>'+
            '<td>'+(r.finalAnswer?String(r.finalAnswer).slice(0,60):'')+'</td>';
          tb.appendChild(tr);
        }
      })
      .catch(e=>{document.body.innerHTML+='<pre style="color:#c00">'+e.message+'</pre>';});
  </script>
</body>
</html>`;
}

// ── 2026-06-12: evals command ────────────────────────────────────────────────

/**
 * `wasmagent evals run --suite=<name,name> --models=<id@url#modelId,...> --seeds=0,1,2`
 *
 * Wraps `@wasmagent/evals-runner` so users can fire a multi-model
 * multi-suite evaluation without writing TypeScript. Maps to the same
 * runEvaluation()/REFERENCE_SUITES API surface — nothing CLI-specific.
 *
 * Models string format: `id@baseUrl#modelId` (modelId optional, defaults
 * to id). Comma-separated. Example:
 *   --models=qwen2.5:0.5b@http://localhost:11434/v1,gpt4o@https://api.openai.com/v1#gpt-4o-mini
 *
// ── goal command (G2 of cli-gap-analysis-2026-06-18.md) ──────────────────────

/**
 * `wasmagent goal "<task>"` — instantiate a `GoalDirectedAgent` against a
 * cwd-rooted workspace and stream its 5-phase loop (scout → criteria →
 * execute → verify → done) to the terminal.
 *
 * Why this is at the CLI layer (not just a library import): the
 * GoalDirectedAgent is the new "eighth axis" of wasmagent-js
 * differentiation (see docs/guides/goal-directed.md). A flagship
 * primitive that ships only as a library has zero discovery surface;
 * `wasmagent --help` users won't know it exists. This subcommand makes
 * `wasmagent goal "write a 1500-word intro to OAuth in oauth.md"` a
 * one-liner anyone can try.
 *
 * The toolset is intentionally minimal — `read_file` + `write_file`
 * scoped to `--workspace`. Anyone needing a richer surface (web,
 * shell, MCP) can layer on top of the same `GoalDirectedAgent` with
 * their own tools; this command's job is to make the loop discoverable,
 * not to be the all-in-one production agent.
 */
async function buildLocalFsWorkspace(rootDir: string): Promise<{
  ws: WorkspaceReader;
  tools: ToolDefinition[];
  scoutEntries: string[];
  rootAbs: string;
}> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { z } = await import("zod");
  const rootAbs = pathResolve(rootDir);
  const safeJoin = (rel: string): string => {
    // Reject absolute / parent-traversal paths. Any tool call that
    // tries to write outside the workspace is rejected with a clear
    // error rather than silently escaping.
    const joined = path.resolve(rootAbs, rel);
    if (!joined.startsWith(`${rootAbs}${path.sep}`) && joined !== rootAbs) {
      throw new Error(`path '${rel}' escapes workspace ${rootAbs}`);
    }
    return joined;
  };

  const ws: WorkspaceReader = {
    async readFile(rel) {
      return await fs.readFile(safeJoin(rel), "utf8");
    },
    async fileExists(rel) {
      try {
        await fs.access(safeJoin(rel));
        return true;
      } catch {
        return false;
      }
    },
    async fileSize(rel) {
      const stat = await fs.stat(safeJoin(rel));
      return stat.size;
    },
  };

  // Top-level scout snapshot. We only list the *top-level* entries to
  // keep the synth prompt bounded; agents that need deeper traversal
  // can issue list-style tool calls (not implemented here on purpose —
  // `wasmagent goal` is a thin discovery surface).
  let scoutEntries: string[] = [];
  try {
    scoutEntries = (await fs.readdir(rootAbs)).slice(0, 60);
  } catch {
    scoutEntries = [];
  }

  const writeFileTool: ToolDefinition<{ path: string; content: string }, { ok: true }> = {
    name: "write_file",
    description: "Create or overwrite a file at the given workspace-relative path.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    outputSchema: z.object({ ok: z.literal(true) }),
    readOnly: false,
    idempotent: true,
    async forward({ path: rel, content }: { path: string; content: string }) {
      const abs = safeJoin(rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      return { ok: true as const };
    },
  };
  const readFileTool: ToolDefinition<{ path: string }, { content: string } | { error: string }> = {
    name: "read_file",
    description: "Read a file relative to the workspace root.",
    inputSchema: z.object({ path: z.string() }),
    outputSchema: z.union([z.object({ content: z.string() }), z.object({ error: z.string() })]),
    readOnly: true,
    idempotent: true,
    async forward({ path: rel }: { path: string }) {
      try {
        return { content: await fs.readFile(safeJoin(rel), "utf8") };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  };

  return { ws, tools: [writeFileTool, readFileTool], scoutEntries, rootAbs };
}

/**
 * Load `Criterion[]` from a JSON file path.
 *
 * Accepts both `[Criterion, ...]` (bare array) and `{criteria: [...]}`
 * — the same shape `GoalDirectedAgent` emits in its `criteria_proposed`
 * event payload, so a frozen-criteria run can be re-checked or replayed
 * offline. Used by both `wasmagent goal --from-criteria` (skip Phase 1
 * synthesis) and `wasmagent verify --criteria` (deterministic gate).
 *
 * Exits the process with a non-zero code on any failure (file missing,
 * unreadable, not JSON, no `criteria` field, empty list). The CLI
 * surface is the only caller, so process.exit is the right shape.
 */
export async function loadCriteriaFromFile(filePath: string): Promise<Criterion[]> {
  let raw: string;
  try {
    raw = await fsReadFile(filePath, "utf8");
  } catch (e) {
    console.error(`Error: cannot read ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(
      `Error: ${filePath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
    process.exit(1);
  }
  const criteriaArr: Criterion[] = Array.isArray(parsed)
    ? (parsed as Criterion[])
    : ((parsed as { criteria?: Criterion[] }).criteria ?? []);
  if (!Array.isArray(criteriaArr) || criteriaArr.length === 0) {
    console.error(`Error: ${filePath} contains no Criterion entries`);
    process.exit(1);
  }
  return criteriaArr;
}

/**
 * 2026-06-18 (axis 9, L3) — interactive adaptation decision over stdin.
 *
 * Renders the proposal (kept / relaxed / dropped criteria) to stderr,
 * then reads a single line ("y" / "n" / empty=reject) from stdin.
 * Streams mode skips the UI entirely and treats it as auto-reject —
 * piped/CI invocations should use `--from-criteria` instead and leave
 * --allow-negotiate off.
 */
export function makeStdinAdaptationHandler(
  streamMode: boolean
): (proposal: AdaptationProposal) => Promise<AdaptationDecision> {
  return async (proposal) => {
    if (streamMode) return { decision: "reject" };
    process.stderr.write("\n[goal-directed] adaptation proposed:\n");
    process.stderr.write(`  keep:    ${proposal.keepCriteria.length} criteria\n`);
    for (const r of proposal.relaxCriteria) {
      process.stderr.write(`  relax:   ${r.original.id} — ${r.reasoning}\n`);
    }
    for (const d of proposal.droppedCriteria) {
      process.stderr.write(`  drop:    ${d.original.id} — ${d.reasoning}\n`);
    }
    process.stderr.write("Accept? [y/N] ");
    const reply = await new Promise<string>((resolve) => {
      const onData = (chunk: Buffer) => {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(chunk.toString("utf8").trim().toLowerCase());
      };
      process.stdin.resume();
      process.stdin.once("data", onData);
    });
    return reply === "y" || reply === "yes" ? { decision: "accept" } : { decision: "reject" };
  };
}

export async function goalCommand(
  task: string,
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  if (!task) {
    console.error('Error: no task provided. Usage: wasmagent goal "<task>"');
    process.exit(1);
  }

  const apiKey =
    typeof opts["api-key"] === "string" ? opts["api-key"] : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY env var or --api-key flag required");
    process.exit(1);
  }

  const maxIterations = parseInt(
    typeof opts["max-iterations"] === "string" ? opts["max-iterations"] : "5",
    10
  );
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 20) {
    console.error("Error: --max-iterations must be a whole number between 1 and 20");
    process.exit(1);
  }
  const judgeSamples = parseInt(
    typeof opts["judge-samples"] === "string" ? opts["judge-samples"] : "3",
    10
  );
  if (!Number.isInteger(judgeSamples) || judgeSamples < 1 || judgeSamples > 11) {
    console.error("Error: --judge-samples must be a whole number between 1 and 11");
    process.exit(1);
  }

  const workspaceDir = typeof opts.workspace === "string" ? opts.workspace : ".";
  await mkdir(workspaceDir, { recursive: true });
  const { ws, tools, scoutEntries, rootAbs } = await buildLocalFsWorkspace(workspaceDir);

  // 2026-06-18: --from-criteria <path.json> skips Phase 1 synthesis. The
  // file is JSON: either a bare Criterion[] or {criteria: [...]} (the
  // shape `GoalDirectedAgent`'s criteria_proposed event emits, so a
  // verified run can be replayed). When set, the synthModel is never
  // called — useful for CI gates and for A/B comparisons that need the
  // same grader across two runs.
  const fromCriteriaPath = typeof opts["from-criteria"] === "string" ? opts["from-criteria"] : "";
  const presetCriteria = fromCriteriaPath
    ? await loadCriteriaFromFile(fromCriteriaPath)
    : undefined;

  const model = buildAnthropicModel(opts, apiKey);

  const streamMode = opts.stream === true;
  // 2026-06-18 (axis 9, L3) — wire CLI's --allow-negotiate to a stdin
  // prompt when interactive AND not in CI deterministic mode (i.e.
  // --from-criteria is unset). With --from-criteria the flag is a
  // noop because the criteria are frozen by the caller and the loop
  // is meant to be reproducible.
  const allowNegotiate = opts["allow-negotiate"] === true && !fromCriteriaPath;
  const agent = new GoalDirectedAgent({
    model,
    tools,
    workspaceReader: ws,
    scout: {
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      workspaceEntries: scoutEntries,
    },
    maxIterations,
    judgeSamples,
    judgeRequireMajority: opts["judge-majority"] === true,
    ...(presetCriteria ? { criteria: presetCriteria } : {}),
    ...(allowNegotiate
      ? {
          allowNegotiate: true,
          onAdaptationProposed: makeStdinAdaptationHandler(streamMode),
        }
      : {}),
  });

  if (!streamMode) {
    console.log(`Goal: ${task}`);
    console.log(`Workspace: ${rootAbs}`);
    if (presetCriteria) {
      console.log(`Criteria: ${fromCriteriaPath} (${presetCriteria.length}, Phase 1 skipped)`);
    }
    console.log("");
  }

  for await (const event of agent.run(task)) {
    if (streamMode) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      continue;
    }
    switch (event.event as string) {
      case "scout_done": {
        const d = event.data as { toolCount?: number; workspaceEntries?: string[] };
        console.log(
          `[scout]    tools=${d.toolCount ?? 0}, workspace=${d.workspaceEntries?.length ?? 0} entr${(d.workspaceEntries?.length ?? 0) === 1 ? "y" : "ies"}`
        );
        break;
      }
      case "criteria_proposed": {
        const d = event.data as { criteria?: Criterion[] };
        const cs = d.criteria ?? [];
        console.log(`[criteria] ${cs.length} criterion(a) synthesised:`);
        for (const c of cs) {
          const arg = c.arg !== undefined ? `=${JSON.stringify(c.arg)}` : "";
          const path = c.path ? ` (${c.path})` : "";
          console.log(`  · ${c.verify_method}${arg}${path}  — ${c.description}`);
        }
        break;
      }
      case "goal_iteration_start": {
        const d = event.data as { iteration?: number; hint?: string };
        console.log(`\n[iter ${d.iteration ?? "?"}]`);
        if (d.hint) console.log(`  retry hint: ${d.hint}`);
        break;
      }
      case "tool_call": {
        const d = event.data as { toolName?: string; args?: unknown };
        console.log(`  → ${d.toolName}(${JSON.stringify(d.args).slice(0, 120)})`);
        break;
      }
      case "tool_result": {
        const d = event.data as { toolName?: string; error?: unknown };
        if (d.error) console.log(`  ✗ ${d.toolName}: ${JSON.stringify(d.error).slice(0, 120)}`);
        break;
      }
      case "goal_directed_done": {
        const d = event.data as {
          outcome?: string;
          iterationCount?: number;
          totalInputTokens?: number;
          totalOutputTokens?: number;
          lastHint?: string;
        };
        console.log("");
        console.log(`Outcome:   ${d.outcome ?? "unknown"}`);
        console.log(`Iterations: ${d.iterationCount ?? 0}`);
        console.log(`Tokens:     ${d.totalInputTokens ?? 0} in / ${d.totalOutputTokens ?? 0} out`);
        if (d.lastHint) {
          console.log("");
          console.log("Last hint:");
          console.log(d.lastHint);
        }
        if (d.outcome === "verified") process.exitCode = 0;
        else if (d.outcome === "single-shot") process.exitCode = 0;
        else process.exitCode = 2;
        break;
      }
      case "error": {
        const d = event.data as { error?: string };
        console.error(`\n[error] ${d.error ?? "unknown"}`);
        process.exitCode = 1;
        break;
      }
    }
  }
}

// ── verify command (G3 of cli-gap-analysis-2026-06-18.md) ────────────────────

/**
 * `wasmagent verify --criteria criteria.json [--workspace .]` — run the
 * deterministic verifier protocol against a workspace without an LLM
 * involved. Useful as a CI gate, a post-commit hook, or a sanity check
 * during development.
 *
 * The criteria file is JSON: either a bare array of `Criterion` or an
 * object `{criteria: Criterion[]}` (matches what `GoalDirectedAgent`'s
 * Phase 1 emits, so a verified run can be re-checked offline).
 *
 * `llm_judge` criteria are silently skipped — the verifier subcommand
 * is for the deterministic-only path. Anyone wanting LLM judgement
 * should run `wasmagent goal` instead, where the judge is part of the
 * loop and gets adversarial defaults.
 */
export async function verifyCommand(
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const criteriaPath = typeof opts.criteria === "string" ? opts.criteria : "";
  if (!criteriaPath) {
    console.error("Error: --criteria=<path-to-json> is required");
    process.exit(1);
  }
  const criteriaArr = await loadCriteriaFromFile(criteriaPath);
  const skipped = criteriaArr.filter((c) => c.verify_method === "llm_judge");
  const checkable = criteriaArr.filter((c) => c.verify_method !== "llm_judge");
  if (skipped.length > 0) {
    console.error(
      `[verify] skipping ${skipped.length} llm_judge criterion(a) — use \`wasmagent goal\` for LLM-judged criteria.`
    );
  }
  if (checkable.length === 0) {
    console.error("Error: no deterministic criteria left to verify after dropping llm_judge.");
    process.exit(1);
  }

  const workspaceDir = typeof opts.workspace === "string" ? opts.workspace : ".";
  const { ws } = await buildLocalFsWorkspace(workspaceDir);

  const pipeline = new VerificationPipeline({ ws, verifiers: [new DeterministicVerifier()] });
  const result = await pipeline.run(checkable);

  // Per-criterion table (compact). The hint column is what makes this
  // useful in CI logs — operators read the failures directly.
  for (const v of result.verdicts) {
    const ok = v.ok ? "✓" : "✗";
    const colour = v.ok ? "" : "";
    if (v.ok) {
      console.log(`  ${colour}${ok} ${v.criterionId}`);
    } else {
      console.log(`  ${colour}${ok} ${v.criterionId} — ${v.hint}`);
    }
  }
  console.log("");
  if (result.ok) {
    console.log(`✓ all ${checkable.length} criterion(a) passed`);
    process.exitCode = 0;
  } else {
    const failed = result.verdicts.filter((v) => !v.ok).length;
    console.log(`✗ ${failed} of ${checkable.length} criterion(a) failed`);
    process.exitCode = 1;
  }
}

// ── evals command ────────────────────────────────────────────────────────────

/**
 * Falls back to a global `--base-url` if the model spec omits `@`.
 */
export async function evalsCommand(
  positionals: string[],
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const sub = positionals[0] ?? "list";
  const { REFERENCE_SUITES, runEvaluation, renderReportMarkdown } = await import(
    "@wasmagent/evals-runner"
  );

  if (sub === "list") {
    console.log("Available reference suites:");
    for (const [name, suite] of Object.entries(REFERENCE_SUITES)) {
      console.log(`  ${name.padEnd(28)} — ${suite.title}`);
      console.log(`    ${suite.description}`);
    }
    console.log("");
    console.log(
      "Run with:  wasmagent evals run --suite=<name,...> --models=<id@url[#modelId],...>"
    );
    return;
  }

  if (sub !== "run") {
    console.error(`Unknown evals subcommand: ${sub}. Use 'list' or 'run'.`);
    process.exit(1);
  }

  const suiteNames = String(opts.suite ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (suiteNames.length === 0) {
    console.error("Error: --suite=<name,...> is required (try `wasmagent evals list`).");
    process.exit(1);
  }
  const suites = suiteNames.map((n) => {
    const s = REFERENCE_SUITES[n];
    if (!s) {
      console.error(`Unknown suite: ${n}. Try \`wasmagent evals list\`.`);
      process.exit(1);
    }
    return s;
  });

  const modelsRaw = String(opts.models ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (modelsRaw.length === 0) {
    console.error(
      "Error: --models=<id@url[#modelId],...> is required.\n" +
        '  Example: --models="qwen2.5:0.5b@http://localhost:11434/v1"'
    );
    process.exit(1);
  }
  const fallbackBaseUrl = (opts["base-url"] as string | undefined) ?? "http://localhost:11434/v1";
  const models = modelsRaw.map((spec) => {
    // Format: id@baseUrl#modelId. baseUrl optional (falls back to --base-url
    // if `@` is missing OR `@` is present but the segment is empty, e.g.
    // `display@#wire-name`).
    const atIdx = spec.indexOf("@");
    const id = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
    const tail = atIdx >= 0 ? spec.slice(atIdx + 1) : "";
    const hashIdx = tail.indexOf("#");
    const rawBaseUrl = hashIdx >= 0 ? tail.slice(0, hashIdx) : tail;
    const baseUrl = rawBaseUrl || fallbackBaseUrl;
    const modelId = hashIdx >= 0 ? tail.slice(hashIdx + 1) : id;
    return { id, baseUrl, modelId };
  });

  const seeds = String(opts.seeds ?? "0,1,2")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n));

  console.log(
    `[evals] ${models.length} model(s) × ${suites.length} suite(s) × ${seeds.length} seed(s)`
  );
  const report = await runEvaluation({
    models,
    suites,
    seeds,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) {
        const pct = total > 0 ? ((done / total) * 100).toFixed(1) : "?";
        process.stderr.write(`\r[evals] ${done}/${total} (${pct}%)`);
      }
    },
  });
  process.stderr.write("\n");

  const md = renderReportMarkdown(report);
  const reportFile = (opts["report-file"] as string | undefined) ?? null;
  if (reportFile) {
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(reportFile, md, "utf8");
    console.log(`Report → ${reportFile}`);
  } else {
    console.log(md);
  }
}

// ── 2026-06-12: model command (L6) ────────────────────────────────────────────

/**
 * `wasmagent model <list|pull|verify|rm> [alias|path]`
 *
 * Thin wrapper over @wasmagent/model-local's downloader + registry. We
 * dynamic-import the peer so users who don't install the local-LLM provider
 * still see no overhead and no missing-module error from the main CLI.
 *
 * Behaviour mirrors common package-manager idioms:
 *   - `model list`            — print every registered alias with size and license.
 *   - `model pull <alias>`    — download and verify (multi-mirror, sha256).
 *   - `model verify <alias>`  — recompute sha256 of cached file and compare.
 *   - `model rm <alias>`      — delete the cached GGUF.
 *
 * Memory-budget warning: before pull(), check `os.freemem()` against the
 * registry's `minFreeMemGB`. We warn-but-don't-fail (the OS pages and a
 * generous swap can still load), which gives users a heads-up without
 * being prescriptive about hardware.
 */
export async function modelCommand(
  positionals: string[],
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const sub = positionals[0] ?? "list";

  let local: typeof import("@wasmagent/model-local");
  try {
    local = (await import("@wasmagent/model-local")) as typeof import("@wasmagent/model-local");
  } catch (_err) {
    console.error(
      "Error: @wasmagent/model-local is not installed.\n" +
        "  npm install @wasmagent/model-local\n" +
        "  (also requires the optional peer: npm install node-llama-cpp)"
    );
    process.exit(2);
    return;
  }

  const cacheDir = (opts["cache-dir"] as string | undefined) ?? local.defaultCacheDir();
  const mirror = opts.mirror as string | undefined;

  if (sub === "list") {
    console.log(`Cache dir: ${cacheDir}`);
    console.log("");
    console.log("Alias               Size (MB)  License                       Recommended  Note");
    console.log("------------------  ---------  ----------------------------  -----------  ----");
    for (const m of local.listRegisteredModels()) {
      const sizeMb = (m.sizeBytes / 1_000_000).toFixed(0).padStart(9, " ");
      const lic = m.license.padEnd(28, " ");
      const rec = (m.recommended ? "yes" : "—").padEnd(11, " ");
      const alias = m.alias.padEnd(18, " ");
      console.log(`${alias}  ${sizeMb}  ${lic}  ${rec}  ${m.note ?? ""}`);
    }
    return;
  }

  if (sub === "pull") {
    const alias = positionals[1];
    if (!alias) {
      console.error("Error: wasmagent model pull <alias>");
      process.exit(1);
      return;
    }
    const reg = local.getRegisteredModel(alias);
    // Memory pre-check.
    try {
      const os = await import("node:os");
      const freeGB = os.freemem() / 1024 ** 3;
      if (freeGB < reg.minFreeMemGB) {
        console.warn(
          `[warn] free RAM is ${freeGB.toFixed(1)} GB; "${alias}" recommends at least ` +
            `${reg.minFreeMemGB} GB free at load time. Proceeding — load may swap.`
        );
      }
    } catch {
      // os.freemem() not available; skip the check.
    }
    process.stderr.write(`Pulling ${alias} (${(reg.sizeBytes / 1e6).toFixed(0)} MB) ...\n`);
    const downloadOpts: Parameters<typeof local.downloadGGUF>[1] = {
      cacheDir,
      onProgress: (transferred, total) => {
        const pct = total > 0 ? ((transferred / total) * 100).toFixed(1) : "?";
        process.stderr.write(`\r  ${(transferred / 1e6).toFixed(1)} MB (${pct}%)`);
      },
    };
    if (mirror !== undefined) downloadOpts.mirror = mirror;
    const result = await local.downloadGGUF(reg, downloadOpts);
    process.stderr.write("\n");
    console.log(`✓ ${alias} → ${result.path}`);
    console.log(`  source:    ${result.sourceUsed.kind}`);
    console.log(`  cache hit: ${result.cacheHit}`);
    console.log(
      `  verified:  ${result.verified} ${reg.sha256 ? "" : "(registry sha256 not yet pinned)"}`
    );
    return;
  }

  if (sub === "verify") {
    const alias = positionals[1];
    if (!alias) {
      console.error("Error: wasmagent model verify <alias>");
      process.exit(1);
      return;
    }
    const reg = local.getRegisteredModel(alias);
    const path = await import("node:path").then((p) =>
      // biome-ignore lint/style/noNonNullAssertion: registry guarantees ≥1 source per registered alias
      p.join(cacheDir, local.filenameForSource(reg.sources[0]!))
    );
    const fs = await import("node:fs");
    if (!fs.existsSync(path)) {
      console.error(`Not cached: ${path}\n  Run: wasmagent model pull ${alias}`);
      process.exit(1);
      return;
    }
    const got = await local.computeSha256(path);
    if (!reg.sha256) {
      console.log(`sha256 = ${got}`);
      console.log("(registry sha256 not yet pinned — nothing to compare against)");
      return;
    }
    if (got === reg.sha256) {
      console.log(`✓ verified  ${alias}  sha256=${got}`);
    } else {
      console.error(`✗ MISMATCH  expected=${reg.sha256}  got=${got}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "rm") {
    const alias = positionals[1];
    if (!alias) {
      console.error("Error: wasmagent model rm <alias>");
      process.exit(1);
      return;
    }
    const reg = local.getRegisteredModel(alias);
    const fs = await import("node:fs/promises");
    const path = await import("node:path").then((p) =>
      // biome-ignore lint/style/noNonNullAssertion: registry guarantees ≥1 source per registered alias
      p.join(cacheDir, local.filenameForSource(reg.sources[0]!))
    );
    try {
      await fs.unlink(path);
      console.log(`✓ removed ${path}`);
    } catch (_e) {
      console.error(`Not present: ${path}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown model subcommand: ${sub}. Use list | pull | verify | rm.`);
  process.exit(1);
}

// ── validate-rollouts command ─────────────────────────────────────────────────

export async function validateRolloutsCommand(
  filePath: string | undefined,
  _opts: Record<string, string | boolean | undefined>
): Promise<void> {
  if (!filePath) {
    console.error("Error: path to JSONL file is required");
    console.error("  Usage: wasmagent validate-rollouts <path.jsonl>");
    process.exit(1);
  }

  let raw: string;
  try {
    raw = await fsReadFile(filePath, "utf8");
  } catch (e) {
    console.error(`Error: cannot read ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
    return;
  }

  const lines = raw.split("\n");
  let total = 0;
  let passed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    total++;
    const lineNum = i + 1;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (e) {
      console.log(
        `line ${lineNum}: FAIL — invalid JSON: ${e instanceof Error ? e.message : String(e)}`
      );
      continue;
    }

    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      console.log(`line ${lineNum}: FAIL — expected a JSON object`);
      continue;
    }

    const obj = record as Record<string, unknown>;
    const missing = ROLLOUT_BRANCH_REQUIRED_FIELDS.filter((f) => !(f in obj));

    if (missing.length > 0) {
      console.log(`line ${lineNum}: FAIL — missing fields: ${missing.join(", ")}`);
    } else {
      console.log(`line ${lineNum}: PASS`);
      passed++;
    }
  }

  console.log(`\n${passed}/${total} records valid`);
  if (passed < total) process.exit(1);
}

// ── export-rollouts command ───────────────────────────────────────────────────

export async function exportRolloutsCommand(
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const inPath = typeof opts.in === "string" ? opts.in : "";
  if (!inPath) {
    console.error("Error: --in <path.jsonl> is required");
    process.exit(1);
  }

  const format = typeof opts.format === "string" ? opts.format : "";
  if (format !== "dpo" && format !== "ppo") {
    console.error(`Error: --format must be "dpo" or "ppo", got "${format}"`);
    process.exit(1);
  }

  let raw: string;
  try {
    raw = await fsReadFile(inPath, "utf8");
  } catch (e) {
    console.error(`Error: cannot read ${inPath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
    return;
  }

  // Parse JSONL and group by rollout_id.
  const byRollout = new Map<
    string,
    Array<{
      rolloutId: string;
      task: string;
      branchIndex: number;
      temperature: number;
      seed: null;
      sessionId: string;
      trajectory: AgentEvent[];
      toolCallSequence: AgentEvent[];
      finalAnswer: string;
      buildResult: null;
      objectiveScore: 0 | 1;
      totalScore: number;
    }>
  >();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      process.stderr.write(`Warning: skipping malformed JSONL line\n`);
      continue;
    }
    const rid = String(obj.rollout_id ?? "");
    if (!rid) continue;
    if (!byRollout.has(rid)) byRollout.set(rid, []);
    const bucket = byRollout.get(rid);
    if (!bucket) continue;
    bucket.push({
      rolloutId: rid,
      task: String(obj.task ?? ""),
      branchIndex: Number(obj.branch_index ?? 0),
      temperature: Number(obj.temperature ?? 0),
      seed: null,
      sessionId: String(obj.session_id ?? ""),
      trajectory: [],
      toolCallSequence: Array.isArray(obj.tool_call_sequence)
        ? (obj.tool_call_sequence as AgentEvent[])
        : [],
      finalAnswer: String(obj.final_answer ?? ""),
      buildResult: null,
      objectiveScore: (obj.objective_score === 1 ? 1 : 0) as 0 | 1,
      totalScore: typeof obj.total_score === "number" ? obj.total_score : 0,
    });
  }

  const exportedAtMs = Date.now();
  const outputRecords: unknown[] = [];

  for (const branches of byRollout.values()) {
    // Sort by objectiveScore desc then totalScore desc to rank branches.
    const sorted = [...branches].sort(
      (a, b) => b.objectiveScore - a.objectiveScore || b.totalScore - a.totalScore
    );
    const ranked: RankedBranch[] = sorted.map((b, i) => ({
      branchIndex: b.branchIndex,
      rank: i + 1,
      objectiveScore: b.objectiveScore,
      judgeScore: 0,
      totalScore: b.totalScore,
    }));

    if (format === "dpo") {
      const rec = toDpoRecord(branches, ranked, exportedAtMs);
      if (rec !== null) outputRecords.push(rec);
    } else {
      const recs = toPpoRecords(branches, ranked, exportedAtMs);
      for (const r of recs) outputRecords.push(r);
    }
  }

  const jsonl = toJsonl(outputRecords);
  const outPath = typeof opts.out === "string" ? opts.out : "";

  if (outPath) {
    await writeFile(outPath, jsonl ? `${jsonl}\n` : "", "utf8");
    process.stderr.write(`Exported ${outputRecords.length} records to ${outPath}\n`);
  } else {
    if (jsonl) process.stdout.write(`${jsonl}\n`);
    process.stderr.write(`Exported ${outputRecords.length} records to stdout\n`);
  }
}
