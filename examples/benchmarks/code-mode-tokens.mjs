/**
 * code-mode-tokens.mjs — A1 (S1 strategic line, 2026-06).
 *
 * Verifies the README claim that exposing N downstream MCP tools through a
 * single `execute_code` entry collapses input tokens. We mirror the methodology
 * Red Hat's codemode-lite used (next.redhat.com, 2026-04): for a fixed number
 * of tools N, compare two patterns:
 *
 *   A. Direct MCP — every tool is published on the host's tools/list, so the
 *      executing model sees every tool's name + description + input schema as
 *      part of its prompt.
 *   B. Code-mode — only `docs_search` + `execute_code` are published. The
 *      model fetches docs JIT for the tools it needs, then emits one script.
 *
 * The break-even point and the slope determine whether code-mode is worth the
 * indirection on a given workload. We assert two things:
 *
 *   1. At N=30 (the headline "30+ tools" condition), code-mode tokens are at
 *      most 50% of direct-mcp tokens — matching codemode-lite's 53% claim.
 *   2. The savings ratio improves monotonically with N (i.e. the larger the
 *      tool catalogue, the bigger the win).
 *
 * Note: this is an OFFLINE token-accounting harness. It demonstrates the
 * mechanism (scaling of bootstrap tokens vs JIT docs lookup), not the wall-clock
 * Anthropic/OpenAI servers would report. End-to-end measurement against a real
 * model lives in `examples/eval-suite/`.
 */
import { writeFile } from "node:fs/promises";
import { tokensOf } from "./tokens.mjs";

// Average tool tokens — calibrated against representative MCP server catalogues
// (filesystem, github, slack, browser, search). Each tool publishes:
//   - name (≈3 tokens)
//   - description (≈25 tokens, one-sentence summary)
//   - inputSchema JSON (≈40 tokens for typical 2-3 field object)
// Total per tool published in tools/list: ~70 tokens.
const TOKENS_PER_PUBLISHED_TOOL = 70;

// docs_search response per tool, when JIT-fetched: name + one-sentence
// description (no schema by default — same as createCodeModeServer's
// includeSchemas=false default). ~30 tokens.
const TOKENS_PER_DOC_RESULT = 30;

// Two-tool bootstrap (docs_search + execute_code) is fixed overhead.
const TOKENS_BOOTSTRAP_CODEMODE = 2 * TOKENS_PER_PUBLISHED_TOOL;

// The model still needs to express intent. We charge each pattern an equal
// task prompt (so the comparison isolates the tools-surface difference).
const TASK_TOKENS = 50;
const ASSISTANT_OUTPUT_TOKENS = 60; // one tool_call or one execute_code script

// Workload parameter — assume the script needs ~K tools out of N. K is small
// (~5) regardless of N, since most user requests touch a handful of tools.
const TOOLS_USED_PER_TASK = 5;

function directMcpTokens(N) {
  // Bootstrap: every tool's full schema sits in the prompt.
  const bootstrap = N * TOKENS_PER_PUBLISHED_TOOL;
  // K tool round-trips. Each round resends the bootstrap at a cache discount
  // (Anthropic 1h prefix cache; ~10% effective cost on repeat).
  const CACHE_DISCOUNT = 0.1;
  const tokens =
    bootstrap // first round full price
    + (TOOLS_USED_PER_TASK - 1) * bootstrap * CACHE_DISCOUNT
    + TOOLS_USED_PER_TASK * (TASK_TOKENS + ASSISTANT_OUTPUT_TOKENS);
  return Math.round(tokens);
}

function codeModeTokens(N) {
  // Bootstrap: only docs_search + execute_code.
  const bootstrap = TOKENS_BOOTSTRAP_CODEMODE;
  // Two model rounds: one to call docs_search, one to call execute_code.
  // docs_search response carries K tool docs (~30 tokens each).
  const CACHE_DISCOUNT = 0.1;
  const docsResponse = TOOLS_USED_PER_TASK * TOKENS_PER_DOC_RESULT;
  const tokens =
    bootstrap // round 1
    + TASK_TOKENS
    + ASSISTANT_OUTPUT_TOKENS // calling docs_search
    + bootstrap * CACHE_DISCOUNT // round 2 prefix
    + docsResponse
    + ASSISTANT_OUTPUT_TOKENS; // emitting execute_code script
  return Math.round(tokens);
}

// ── Run + report ─────────────────────────────────────────────────────────────
async function main() {
  const NS = [10, 20, 30, 50, 100];
  const rows = NS.map((N) => {
    const a = directMcpTokens(N);
    const b = codeModeTokens(N);
    return { N, direct: a, codemode: b, ratio: b / a, savings: 1 - b / a };
  });

  const at30 = rows.find((r) => r.N === 30);
  const target = 0.5; // codeModeTokens ≤ 50% of direct at N=30
  const passN30 = at30.ratio <= target;

  // Monotonic: savings should improve with N (or at minimum not degrade).
  let monotonic = true;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].savings < rows[i - 1].savings - 0.02) {
      monotonic = false;
      break;
    }
  }

  const allPass = passN30 && monotonic;
  const sym = allPass ? "✅" : "❌";

  let md = "# Code-mode token reduction (S1/A1)\n\n";
  md += `Methodology — see header of \`code-mode-tokens.mjs\`. Token model is the\n`;
  md += `same one we used for the PTC benchmark (Anthropic 1h prefix cache, 10%\n`;
  md += `effective discount on repeat). N is the number of downstream tools the\n`;
  md += `host has registered; K=${TOOLS_USED_PER_TASK} tools are touched per task.\n\n`;
  md += `| N tools | Direct MCP | Code-mode | Code-mode / Direct | Savings |\n`;
  md += `|---:|---:|---:|---:|---:|\n`;
  for (const r of rows) {
    md += `| ${r.N} | ${r.direct} | ${r.codemode} | ${(r.ratio * 100).toFixed(1)}% | ${(r.savings * 100).toFixed(1)}% |\n`;
  }
  md += `\n`;
  md += `${sym} **N=30 break-even**: code-mode is ${(at30.ratio * 100).toFixed(1)}% of direct (target ≤ ${target * 100}%, codemode-lite reported 53%).\n`;
  md += `${monotonic ? "✅" : "❌"} **Monotonic**: savings improve as N grows.\n\n`;
  md += `### Caveat\n\n`;
  md += `This is an OFFLINE accounting model. Real-world numbers depend on\n`;
  md += `actual tool docstring lengths, prefix-cache hit rate, and the model's\n`;
  md += `tool-selection strategy. The point of this benchmark is to pin the\n`;
  md += `*scaling shape* — bootstrap-O(N) for direct MCP vs O(1) for code-mode.\n`;
  md += `End-to-end token measurement on a real model lives in\n`;
  md += `\`examples/eval-suite/\`.\n`;

  console.log(md);
  await writeFile(new URL("./report-code-mode.md", import.meta.url), md);
  if (!allPass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
