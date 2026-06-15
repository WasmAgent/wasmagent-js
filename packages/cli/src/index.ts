#!/usr/bin/env node

/**
 * agentkit CLI (D6)
 *
 * Usage:
 *   agentkit run "<task>" [--model claude-sonnet-4-6] [--max-steps 20]
 *                         [--stream] [--events run_start,step_start,...]
 *   agentkit init-tool --name <name> [--output <dir>]
 *
 * Mirrors smolagents' `smolagent` CLI (cli.py:294).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AgentEvent } from "@agentkit-js/core";
import { AnthropicModel, AnthropicModels, CodeAgent } from "@agentkit-js/core";

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
      // A4 (S3, 2026-06): `agentkit devtools` flags. `events` doubles as both
      // the run-command filter and the devtools NDJSON input path.
      "events-file": { type: "string" },
      // D5 (2026-06): framework-agnostic GenAI semconv ingest. Either NDJSON
      // (one span per line) or OTLP/JSON (`{resourceSpans: …}`). When set,
      // takes precedence over --events-file so users can compare a Vercel
      // AI SDK or Mastra trace in the same Studio view.
      "otel-events-file": { type: "string" },
      port: { type: "string", default: "4317" },
      // 2026-06-12: `agentkit evals` flags. `--suite` accepts comma-separated
      // names; `--models` is comma-separated `id@baseUrl#modelId` triples;
      // `--seeds` is comma-separated integers.
      suite: { type: "string" },
      models: { type: "string" },
      seeds: { type: "string", default: "0,1,2" },
      "base-url": { type: "string" },
      "report-file": { type: "string" },
      // 2026-06-12: `agentkit model` (L6) flags. Loaded lazily via
      // @agentkit-js/model-local — no impact on `agentkit run` users who
      // don't install the local-model peer.
      mirror: { type: "string" },
      "cache-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    printHelp();
    process.exit(0);
  }

  const [command, ...rest] = positionals;

  switch (command) {
    case "run":
      await runCommand(rest.join(" "), values);
      break;
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
    console.error('Error: no task provided. Usage: agentkit run "<task>"');
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

  const model = new AnthropicModel(
    typeof opts.model === "string" ? opts.model : AnthropicModels.SONNET_LATEST,
    apiKey
  );
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

// ── init-tool command ─────────────────────────────────────────────────────────

async function initToolCommand(opts: Record<string, string | boolean | undefined>): Promise<void> {
  const rawName = typeof opts.name === "string" ? opts.name.trim() : "";
  if (!rawName) {
    console.error("Error: --name <tool-name> is required");
    console.error("  Example: agentkit init-tool --name web-search");
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
  console.log(`  2. Run: npx vitest run ${testFile}`);
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
import type { ToolDefinition } from "@agentkit-js/core";

/**
 * ${pascalName} tool.
 * Generated by: agentkit init-tool --name ${kebabName}
 */
export const ${camelCase(pascalName)}Tool: ToolDefinition<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: "${kebabName}",
  description: "TODO: describe what this tool does",
  inputSchema: z.object({
    // TODO: define input fields
    query: z.string().describe("The input query"),
  }),
  outputSchema: z.string(),
  readOnly: true,    // TODO: set to false if this tool has side effects
  idempotent: true,  // TODO: set to false if repeated calls produce different results
  async forward(input) {
    // TODO: implement the tool logic
    throw new Error(\`${pascalName}: not yet implemented (input: \${JSON.stringify(input)})\`);
  },
};

const inputSchema = ${camelCase(pascalName)}Tool.inputSchema;
const outputSchema = ${camelCase(pascalName)}Tool.outputSchema;
`;
}

export function generateTestTemplate(kebabName: string, pascalName: string): string {
  return `import { describe, it, expect } from "vitest";
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
    // TODO: replace this with a real test once forward() is implemented
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
    // TODO: define input fields
    pub query: String,
}

#[derive(Serialize)]
pub struct ${pascalName}Output {
    pub result: String,
}

/// ${pascalName} — main entry point called from the agentkit TypeScript wrapper.
#[wasm_bindgen]
pub fn ${snakeName}(input_json: &str) -> Result<String, JsValue> {
    let input: ${pascalName}Input = serde_json::from_str(input_json)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    // TODO: implement tool logic
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
 * Generated by: agentkit init-tool --name ${kebabName} --lang rust
 *
 * Build the WASM first: wasm-pack build --target nodejs
 * Then this file imports from the generated ./pkg/ directory.
 */
import { z } from "zod";
import type { ToolDefinition } from "@agentkit-js/core";

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
  description: "TODO: describe what this tool does",
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
agentkit — TypeScript agent runtime (agentkit-js v0.1.0)

Usage:
  agentkit run "<task>" [options]
  agentkit init-tool --name <tool-name> [options]
  agentkit devtools --events-file <ndjson> [--port 4317]
  agentkit devtools --otel-events-file <ndjson|otlp.json> [--port 4317]
  agentkit evals list
  agentkit evals run --suite=<names> --models=<id@url[#modelId],...> [--seeds=0,1,2]
  agentkit model list
  agentkit model pull <alias> [--mirror=<huggingface|hf-mirror|modelscope|<url>>] [--cache-dir=<path>]
  agentkit model verify <alias> [--cache-dir=<path>]
  agentkit model rm <alias> [--cache-dir=<path>]

Commands:
  run "<task>"              Run an agent on a task
  init-tool                 Scaffold a new ToolDefinition file (TypeScript or Rust/WASM)
  devtools                  Start the local Studio (zero-deploy runs overview)
  evals list                List the 6 reference benchmark suites
  evals run                 Run a multi-model multi-suite evaluation; output a Pareto report
  model list                List registered local models (Qwen/Gemma/Llama 1B-class)
  model pull <alias>        Download a registered local model with sha256 verification
  model verify <alias>      Recompute sha256 of the cached file and compare
  model rm <alias>          Delete the cached model file

run options:
  --model <id>             Model ID (default: claude-sonnet-4-6)
  --max-steps <n>          Maximum agent steps (default: 20)
  --api-key <key>          Anthropic API key (or set ANTHROPIC_API_KEY)
  --stream                 Output all events as NDJSON (pipe-friendly)
  --events <types>         Comma-separated event types to include
  -h, --help               Show this help

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

Examples:
  agentkit run "What is 2+2?"
  agentkit run "Analyse data" --stream | jq .
  agentkit run "Search AI news" --events final_answer,error
  agentkit init-tool --name web-search --output ./tools
  agentkit devtools --events-file ./events.ndjson
  agentkit evals list
  agentkit evals run --suite=multi-turn-memory --models=qwen2.5:0.5b@http://localhost:11434/v1
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
 * Node, Bun, Workers; the React overlay (in `@agentkit-js/devtools/react`)
 * is opt-in for callers who already have a Vite/Next pipeline.
 */
export async function devtoolsCommand(
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  // Lazy import — devtools is its own peer with React types; we don't want
  // run/init-tool callers to load it.
  const dt = (await import("@agentkit-js/devtools")) as {
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
    console.error("  agentkit devtools --events-file ./events.ndjson");
    console.error(
      "  agentkit devtools --otel-events-file ./trace.ndjson  # any GenAI semconv source"
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
  console.log(`agentkit Studio: http://localhost:${port} (source: ${sourceLabel})`);
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
  <title>agentkit Studio</title>
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
  <h1>agentkit Studio</h1>
  <div class="sub">A4 — local runs overview · pure-logic aggregator from <code>@agentkit-js/devtools</code></div>
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
 * `agentkit evals run --suite=<name,name> --models=<id@url#modelId,...> --seeds=0,1,2`
 *
 * Wraps `@agentkit-js/evals-runner` so users can fire a multi-model
 * multi-suite evaluation without writing TypeScript. Maps to the same
 * runEvaluation()/REFERENCE_SUITES API surface — nothing CLI-specific.
 *
 * Models string format: `id@baseUrl#modelId` (modelId optional, defaults
 * to id). Comma-separated. Example:
 *   --models=qwen2.5:0.5b@http://localhost:11434/v1,gpt4o@https://api.openai.com/v1#gpt-4o-mini
 *
 * Falls back to a global `--base-url` if the model spec omits `@`.
 */
export async function evalsCommand(
  positionals: string[],
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const sub = positionals[0] ?? "list";
  const { REFERENCE_SUITES, runEvaluation, renderReportMarkdown } = await import(
    "@agentkit-js/evals-runner"
  );

  if (sub === "list") {
    console.log("Available reference suites:");
    for (const [name, suite] of Object.entries(REFERENCE_SUITES)) {
      console.log(`  ${name.padEnd(28)} — ${suite.title}`);
      console.log(`    ${suite.description}`);
    }
    console.log("");
    console.log("Run with:  agentkit evals run --suite=<name,...> --models=<id@url[#modelId],...>");
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
    console.error("Error: --suite=<name,...> is required (try `agentkit evals list`).");
    process.exit(1);
  }
  const suites = suiteNames.map((n) => {
    const s = REFERENCE_SUITES[n];
    if (!s) {
      console.error(`Unknown suite: ${n}. Try \`agentkit evals list\`.`);
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
    // Format: id@baseUrl#modelId. baseUrl optional (falls back to --base-url).
    const atIdx = spec.indexOf("@");
    const id = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
    const tail = atIdx >= 0 ? spec.slice(atIdx + 1) : "";
    const hashIdx = tail.indexOf("#");
    const baseUrl = hashIdx >= 0 ? tail.slice(0, hashIdx) : tail || fallbackBaseUrl;
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
 * `agentkit model <list|pull|verify|rm> [alias|path]`
 *
 * Thin wrapper over @agentkit-js/model-local's downloader + registry. We
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

  let local: typeof import("@agentkit-js/model-local");
  try {
    local = (await import("@agentkit-js/model-local")) as typeof import("@agentkit-js/model-local");
  } catch (err) {
    console.error(
      "Error: @agentkit-js/model-local is not installed.\n" +
        "  npm install @agentkit-js/model-local\n" +
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
      console.error("Error: agentkit model pull <alias>");
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
      console.error("Error: agentkit model verify <alias>");
      process.exit(1);
      return;
    }
    const reg = local.getRegisteredModel(alias);
    const path = await import("node:path").then((p) =>
      p.join(cacheDir, local.filenameForSource(reg.sources[0]!))
    );
    const fs = await import("node:fs");
    if (!fs.existsSync(path)) {
      console.error(`Not cached: ${path}\n  Run: agentkit model pull ${alias}`);
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
      console.error("Error: agentkit model rm <alias>");
      process.exit(1);
      return;
    }
    const reg = local.getRegisteredModel(alias);
    const fs = await import("node:fs/promises");
    const path = await import("node:path").then((p) =>
      p.join(cacheDir, local.filenameForSource(reg.sources[0]!))
    );
    try {
      await fs.unlink(path);
      console.log(`✓ removed ${path}`);
    } catch (e) {
      console.error(`Not present: ${path}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown model subcommand: ${sub}. Use list | pull | verify | rm.`);
  process.exit(1);
}
