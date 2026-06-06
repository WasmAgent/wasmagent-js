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

import { parseArgs } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CodeAgent, AnthropicModel } from "@agentkit-js/core";
import type { AgentEvent } from "@agentkit-js/core";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: "string", default: "claude-sonnet-4-6" },
    "max-steps": { type: "string", default: "20" },
    "api-key": { type: "string" },
    stream: { type: "boolean", default: false },
    events: { type: "string" },
    // init-tool options
    name: { type: "string" },
    output: { type: "string", default: "." },
    /** Language/template for init-tool. Default: "ts". Supported: "ts", "rust". */
    lang: { type: "string", default: "ts" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values["help"] || positionals.length === 0) {
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
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}

// ── run command ───────────────────────────────────────────────────────────────

async function runCommand(
  task: string,
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  if (!task) {
    console.error("Error: no task provided. Usage: agentkit run \"<task>\"");
    process.exit(1);
  }

  const apiKey =
    typeof opts["api-key"] === "string"
      ? opts["api-key"]
      : process.env["ANTHROPIC_API_KEY"];

  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY env var or --api-key flag required");
    process.exit(1);
  }

  const streamMode = opts["stream"] === true;
  const eventsFilter = parseEventsFilter(
    typeof opts["events"] === "string" ? opts["events"] : undefined,
    streamMode
  );

  const model = new AnthropicModel(
    typeof opts["model"] === "string" ? opts["model"] : "claude-sonnet-4-6",
    apiKey
  );
  const maxSteps = parseInt(
    typeof opts["max-steps"] === "string" ? opts["max-steps"] : "20",
    10
  );
  const agent = new CodeAgent({ tools: [], model, maxSteps });

  if (!streamMode) console.log(`Running: ${task}\n`);

  let stepCount = 0;

  for await (const event of agent.run(task)) {
    if (!eventsFilter.has(event.event)) continue;

    if (streamMode) {
      process.stdout.write(JSON.stringify(event) + "\n");
      continue;
    }

    switch (event.event) {
      case "run_start":
        break;
      case "step_start": {
        const data = event.data as Record<string, unknown>;
        if (typeof data["step"] === "number") {
          stepCount = data["step"] as number;
          process.stderr.write(`\n[step ${stepCount}] `);
        } else if (typeof data["delta"] === "string") {
          process.stdout.write(data["delta"]);
        }
        break;
      }
      case "planning": {
        const data = event.data as { step: number; plan: string; facts: string };
        console.log(`\n\n[planning @ step ${data.step ?? stepCount}]`);
        console.log(`Plan: ${data.plan}`);
        if (data.facts) console.log(`Facts: ${data.facts}`);
        break;
      }
      case "tool_call": {
        const data = event.data as { toolName: string; args: unknown };
        console.log(`\n[tool_call] ${data.toolName}(${JSON.stringify(data.args)})`);
        break;
      }
      case "tool_result": {
        const data = event.data as { toolName: string; output: unknown; error?: unknown };
        if (data.error) {
          console.log(`[tool_result] ERROR: ${JSON.stringify(data.error)}`);
        } else {
          console.log(`[tool_result] ${data.toolName} → ${JSON.stringify(data.output)}`);
        }
        break;
      }
      case "final_answer":
        console.log("\n\nFinal answer:", (event.data as { answer: unknown }).answer);
        break;
      case "error":
        console.error("\nError:", (event.data as { error: string }).error);
        break;
    }
  }
}

// ── init-tool command ─────────────────────────────────────────────────────────

async function initToolCommand(
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const rawName = typeof opts["name"] === "string" ? opts["name"].trim() : "";
  if (!rawName) {
    console.error("Error: --name <tool-name> is required");
    console.error("  Example: agentkit init-tool --name web-search");
    process.exit(1);
  }

  const lang = typeof opts["lang"] === "string" ? opts["lang"] : "ts";
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

  const outputDir = typeof opts["output"] === "string" ? opts["output"] : ".";
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

function generateToolTemplate(kebabName: string, pascalName: string): string {
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

function generateTestTemplate(kebabName: string, pascalName: string): string {
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

function camelCase(pascal: string): string {
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function generateCargoTemplate(kebabName: string, snakeName: string): string {
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
  "run_start", "step_start", "tool_call", "tool_result", "planning", "final_answer", "error",
];

function parseEventsFilter(raw: string | undefined, streamMode: boolean): Set<EventType> {
  if (raw) {
    const requested = raw.split(",").map((s) => s.trim()) as EventType[];
    return new Set(requested.filter((e): e is EventType => (ALL_EVENT_TYPES as string[]).includes(e)));
  }
  if (streamMode) return new Set(ALL_EVENT_TYPES);
  return new Set<EventType>(["step_start", "planning", "tool_call", "tool_result", "final_answer", "error"]);
}

function printHelp(): void {
  console.log(`
agentkit — TypeScript agent runtime (agentkit-js v0.1.0)

Usage:
  agentkit run "<task>" [options]
  agentkit init-tool --name <tool-name> [options]

Commands:
  run "<task>"              Run an agent on a task
  init-tool                 Scaffold a new ToolDefinition file (TypeScript or Rust/WASM)

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

Examples:
  agentkit run "What is 2+2?"
  agentkit run "Analyse data" --stream | jq .
  agentkit run "Search AI news" --events final_answer,error
  agentkit init-tool --name web-search --output ./tools
`);
}
