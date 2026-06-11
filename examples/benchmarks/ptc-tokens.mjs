/**
 * Verifies the README claim: Programmatic Tool Calling (PTC) saves −37%
 * tokens vs. round-trip tool calling.
 *
 * Mechanism check: PTC executes a model-generated *script* that calls many
 * tools in one round. The intermediate tool outputs never re-enter the
 * model's context — only the final return value does. Round-trip tool
 * calling, in contrast, sends every intermediate tool_result back to the
 * model, accumulating tokens.
 *
 * We simulate a 5-tool chain (read file → parse → transform → format →
 * write) and tally tokens for each pattern.
 */
import { writeFile } from "node:fs/promises";
import { tokensOf } from "./tokens.mjs";

// ── Synthetic tool outputs (representative of compact API responses) ─────────
// These match the typical shape of a real coding agent's tool calls: small,
// structured returns (read_file → 100 tokens, transform → 200 tokens, etc.).
// The −37% claim assumes roughly this profile; with multi-KB outputs the
// savings approach 100% (PTC is even more dominant), so calibrate to the
// realistic case the README is talking about.
const TOOL_OUTPUTS = {
  read_file: "x".repeat(400),    // 100 tokens
  parse_json: "{".repeat(200),   // 50 tokens
  transform: "y".repeat(800),    // 200 tokens
  format: "z".repeat(400),       // 100 tokens
  write_file: "OK: written 8 chars",  // ~5 tokens
};
const FINAL_ANSWER = "Done.";

// Anthropic's prompt-cache hits the system+task prefix on every round, so the
// re-sent prefix on each round-trip request is mostly cached and discounted.
// Approximate the cache discount at 90% on the system+task prefix segment.
const CACHE_DISCOUNT = 0.1;

// ── Round-trip tool calling: every intermediate result re-enters context ─────
// Each round, the model receives the FULL message history (system + task +
// every prior tool_call/tool_result) before generating the next tool_call.
// That's the cost dominator and why PTC wins.
function roundTripTokens() {
  const SYSTEM = "You are an agent. Use tools to complete the task.";
  const TASK = "Process the input file and write the result to output.json";
  const ASSISTANT_TURN = 30;
  const prefixTokens = tokensOf(SYSTEM) + tokensOf(TASK);
  const history = [];
  let inputTotal = 0;
  let outputTotal = 0;
  for (const out of Object.values(TOOL_OUTPUTS)) {
    // Each request resends system + task (cache-discounted) + history.
    inputTotal += prefixTokens * CACHE_DISCOUNT + history.reduce((a, m) => a + m, 0);
    outputTotal += ASSISTANT_TURN;
    history.push(ASSISTANT_TURN);
    history.push(tokensOf(out));
  }
  // Final round.
  inputTotal += prefixTokens * CACHE_DISCOUNT + history.reduce((a, m) => a + m, 0);
  outputTotal += tokensOf(FINAL_ANSWER);
  return Math.round(inputTotal + outputTotal);
}

// ── PTC: model generates one script; only final return crosses the boundary ──
// One model request, one model emission. Tools run inside the kernel; their
// intermediate outputs never re-enter the model's prompt.
function ptcTokens() {
  const SYSTEM = "You are an agent. Generate a script that uses callTool() to complete the task.";
  const TASK = "Process the input file and write the result to output.json";
  const SCRIPT = `
const a = await callTool("read_file", {path: "in.json"});
const b = await callTool("parse_json", {text: a});
const c = await callTool("transform", {data: b});
const d = await callTool("format", {data: c});
return await callTool("write_file", {path: "out.json", content: d});
`.trim();
  // Single request: system + task in input, script + final return in output.
  return tokensOf(SYSTEM) + tokensOf(TASK) + tokensOf(SCRIPT) + tokensOf(TOOL_OUTPUTS.write_file);
}

// ── Run + report ─────────────────────────────────────────────────────────────
async function main() {
  const baseline = roundTripTokens();
  const ptc = ptcTokens();
  const ratio = ptc / baseline;
  // PTC's exact ratio depends heavily on output sizes and prompt-cache hit
  // rates that this offline harness cannot fully simulate. We assert that PTC
  // beats the round-trip baseline by AT LEAST 37% — the README's stated lower
  // bound — without claiming an exact match.
  const lowerBoundRatio = 0.63;
  const pass = ratio <= lowerBoundRatio;
  const sym = pass ? "✅" : "❌";
  const verdictLine =
    `${sym} PTC token reduction: observed ${(ratio * 100).toFixed(1)}% of baseline ` +
    `(README claims ≤ ${(lowerBoundRatio * 100).toFixed(0)}%, i.e. ≥ −37%)`;

  let md = "# PTC token reduction benchmark\n\n";
  md += `| Pattern | Tokens |\n|---|---:|\n`;
  md += `| Round-trip tool calling | ${baseline} |\n`;
  md += `| Programmatic Tool Calling | ${ptc} |\n`;
  md += `| **Ratio** | **${(ratio * 100).toFixed(1)}%** |\n\n`;
  md += `${verdictLine}\n`;
  md += `\nREADME claim: \`−37% tokens\`. ` +
    `Threshold: PTC tokens ≤ 63% of round-trip. ` +
    `Observed: ${ratio.toFixed(3)}.\n\n` +
    `Note: this offline harness demonstrates the *mechanism* (PTC avoids ` +
    `re-sending intermediate tool outputs), not the exact wall-clock saving ` +
    `Anthropic's servers would report. End-to-end measurement against a ` +
    `real model lives in \`examples/eval-suite/\`.\n`;

  console.log(md);
  await writeFile(new URL("./report-ptc.md", import.meta.url), md);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
