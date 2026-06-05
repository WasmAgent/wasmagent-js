#!/usr/bin/env node
/**
 * agentkit CLI (D6 skeleton)
 *
 * Usage:
 *   agentkit run "plan a trip to Tokyo" [--model claude-sonnet-4-6] [--max-steps 20]
 *   agentkit init-tool --lang rust        (scaffolds a WASM tool template)
 *
 * Mirrors smolagents' `smolagent` CLI (cli.py:294).
 */

import { parseArgs } from "node:util";
import { CodeAgent, AnthropicModel } from "@agentkit-js/core";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: "string", default: "claude-sonnet-4-6" },
    "max-steps": { type: "string", default: "20" },
    "api-key": { type: "string" },
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
    console.error("init-tool scaffold: coming in M3 (D6)");
    process.exit(1);
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}

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
    console.error(
      "Error: ANTHROPIC_API_KEY env var or --api-key flag required"
    );
    process.exit(1);
  }

  const model = new AnthropicModel(
    typeof opts["model"] === "string" ? opts["model"] : "claude-sonnet-4-6",
    apiKey
  );
  const maxSteps = parseInt(
    typeof opts["max-steps"] === "string" ? opts["max-steps"] : "20",
    10
  );
  const agent = new CodeAgent({ tools: [], model, maxSteps });

  console.log(`Running: ${task}\n`);
  for await (const event of agent.run(task)) {
    if (event.event === "final_answer") {
      console.log("\nFinal answer:", (event.data as { answer: unknown }).answer);
    } else if (event.event === "error") {
      console.error("\nError:", (event.data as { error: string }).error);
    } else if (
      event.channel === "thinking" &&
      event.event === "step_start" &&
      typeof (event.data as { delta?: string }).delta === "string"
    ) {
      process.stdout.write((event.data as { delta: string }).delta);
    }
  }
}

function printHelp(): void {
  console.log(`
agentkit — TypeScript agent runtime (agentkit-js v0.1.0)

Usage:
  agentkit run "<task>" [options]
  agentkit init-tool --lang rust

Options:
  --model <id>       Model ID (default: claude-sonnet-4-6)
  --max-steps <n>    Maximum agent steps (default: 20)
  --api-key <key>    Anthropic API key (or set ANTHROPIC_API_KEY)
  -h, --help         Show this help

Examples:
  agentkit run "What is 2+2?"
  agentkit run "Search and summarise recent AI news" --max-steps 5
`);
}
