/**
 * A3 — Skills + lifecycle hooks demo.
 *
 * No model calls — runs entirely offline so the example doubles as a smoke
 * test. Demonstrates:
 *   1. Register three skills with cheap regex triggers; only the matching
 *      ones load their bodies.
 *   2. Compute the token-cost difference between "always inline all skills"
 *      and "skills lazy-loaded on demand".
 *   3. Post-tool hooks chain: redact + truncate composed for safe logging.
 */
import {
  redactPostHook,
  runToolPostHooks,
  SkillRegistry,
  truncatePostHook,
} from "@agentkit-js/core";

// ── 1. Register three skills ────────────────────────────────────────────────

const registry = new SkillRegistry();

registry.register({
  name: "react-build",
  description: "Scaffold a React + Vite + TypeScript app",
  trigger: (task) => /\b(react|jsx|hooks?)\b/i.test(task),
  load: () => ({
    instructions: `## React build skill\nUse functional components with hooks.\nPrefer Vite over CRA.\nWrite each file in ONE write_file call.\nNever batch multiple files in one step.`,
    tools: [],
  }),
});

registry.register({
  name: "data-analysis",
  description: "pandas-style analysis with matplotlib charts",
  trigger: (task) => /\b(pandas|csv|dataframe|matplotlib)\b/i.test(task),
  load: () => ({
    instructions: `## Data analysis skill\nLoad CSV with pandas.read_csv().\nMatplotlib uses the Agg backend in WASM.\nReturn a base64 PNG via __finalAnswer__ for charts.`,
    tools: [],
  }),
});

registry.register({
  name: "shell-script",
  description: "Author bash scripts with set -euo pipefail",
  trigger: (task) => /\b(bash|shell|cron|systemd)\b/i.test(task),
  load: () => ({
    instructions: `## Shell script skill\nAlways start with #!/usr/bin/env bash and set -euo pipefail.\nQuote every variable.\nPrefer printf to echo for portability.`,
    tools: [],
  }),
});

// ── 2. Token-cost comparison ───────────────────────────────────────────────

const ALL_INSTRUCTIONS = (await Promise.all(
  registry.list().map(async (m) => (await registry.activate(m.name)).body.instructions),
)).join("\n\n");

const TASK = "Build a small React component using hooks";
const lazyResolved = await registry.resolveForTask(TASK);
const lazyInstructions = lazyResolved?.instructions ?? "";

const tokens = (s) => Math.ceil(s.length / 4);

console.log("=== Token cost comparison ===");
console.log(`Eager (every skill always inlined):    ${tokens(ALL_INSTRUCTIONS)} tokens`);
console.log(`Lazy (matched skills only):            ${tokens(lazyInstructions)} tokens`);
console.log(`Compression ratio:                     ${(tokens(lazyInstructions) / tokens(ALL_INSTRUCTIONS) * 100).toFixed(1)}%`);
console.log(`Activated for "${TASK}":`);
console.log("  " + (lazyResolved?.activated.join(", ") ?? "(none)"));

// ── 3. Post-tool hook chain ─────────────────────────────────────────────────

const rawToolOutput = `
config.json:
  api_key=sk-abcdef1234567890
  endpoint=https://api.example.com
  ${"a".repeat(1500)}
`;

const safe = await runToolPostHooks(
  [
    redactPostHook({ pattern: /sk-[a-z0-9]{6,}/gi }),
    truncatePostHook({ maxChars: 200 }),
  ],
  "read_file",
  rawToolOutput,
  { input: { path: "config.json" }, durationMs: 12 },
);

console.log("\n=== Post-tool hook chain ===");
console.log("Raw output (first 80 chars):  ", JSON.stringify(rawToolOutput.slice(0, 80)));
console.log("Sanitised (last 200 chars):   ", JSON.stringify(String(safe).slice(-200)));
console.log("Note: API key was redacted, then output trimmed to a 200-char tail.");
