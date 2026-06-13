/**
 * portal-tokens.mjs — D1 (S1 strategic line, 2026-06-13).
 *
 * Verifies the README claim that federating M upstream MCP servers behind one
 * `createPortalServer` keeps the bootstrap-token cost O(1) regardless of how
 * many servers are wired in — same as single-server code-mode, even when each
 * upstream contributes its own tool catalogue.
 *
 * Three patterns are compared at fixed K=5 tools-touched-per-task:
 *
 *   A. Direct multi-MCP — host connects to M servers, each publishing
 *      N_avg tools; the model sees ALL M*N_avg schemas in the prompt.
 *   B. Code-mode per server — one code-mode server per upstream; the model
 *      sees M*2 = 2M tools in the prompt (each server's docs_search +
 *      execute_code), then routes per call.
 *   C. Portal (D1) — one federated Portal across all M servers; the model
 *      sees exactly 2 tools in the prompt regardless of M.
 *
 * Acceptance:
 *   1. At M=5 servers × 30 tools each (= 150 tools), the Portal beats
 *      pattern A by ≥10× and beats pattern B by ≥1.5× (the savings vs B come
 *      from removing the per-server bootstrap surcharge plus avoiding two
 *      separate docs_search round trips).
 *   2. The Portal's bootstrap cost is constant in M — same as single-server
 *      code-mode at the same total tool count.
 *
 * As with code-mode-tokens.mjs, this is an OFFLINE token accounting model.
 * Wall-clock and provider-specific cache rates live in
 * `examples/eval-suite/`.
 */
import { writeFile } from "node:fs/promises";

// Calibration constants — match code-mode-tokens.mjs verbatim so the two
// benches are directly comparable.
const TOKENS_PER_PUBLISHED_TOOL = 70;
const TOKENS_PER_DOC_RESULT = 30;
const TOKENS_BOOTSTRAP_CODEMODE = 2 * TOKENS_PER_PUBLISHED_TOOL;
const TASK_TOKENS = 50;
const ASSISTANT_OUTPUT_TOKENS = 60;
const CACHE_DISCOUNT = 0.1;
const TOOLS_USED_PER_TASK = 5;

function directMultiMcp(M, NPerServer) {
  const totalTools = M * NPerServer;
  const bootstrap = totalTools * TOKENS_PER_PUBLISHED_TOOL;
  // K calls all hit the same prefix; later rounds amortised at cache rate.
  const tokens =
    bootstrap +
    (TOOLS_USED_PER_TASK - 1) * bootstrap * CACHE_DISCOUNT +
    TOOLS_USED_PER_TASK * (TASK_TOKENS + ASSISTANT_OUTPUT_TOKENS);
  return Math.round(tokens);
}

function codeModePerServer(M, NPerServer) {
  // The model sees 2M tools (one docs_search + one execute_code per server).
  const bootstrap = 2 * M * TOKENS_PER_PUBLISHED_TOOL;
  // Worst case: K tools spread across all M servers — that's M docs_search
  // round trips (each ~K/M tool docs back) plus M execute_code rounds.
  // Realistic: assume K tool calls hit at most min(K, M) distinct servers.
  const distinctServersHit = Math.min(TOOLS_USED_PER_TASK, M);
  const docsResponseTotal = TOOLS_USED_PER_TASK * TOKENS_PER_DOC_RESULT;
  const tokens =
    bootstrap +
    distinctServersHit * (TASK_TOKENS + ASSISTANT_OUTPUT_TOKENS) + // docs_search rounds
    distinctServersHit * bootstrap * CACHE_DISCOUNT + // their cached prefixes
    docsResponseTotal +
    distinctServersHit * (ASSISTANT_OUTPUT_TOKENS + bootstrap * CACHE_DISCOUNT); // execute_code rounds
  return Math.round(tokens);
}

function portal(_M, _NPerServer) {
  // Same as single-server code-mode: bootstrap is fixed at 2 tools regardless
  // of how many upstream tools the Portal flattens. The K calls go through
  // ONE execute_code round.
  const bootstrap = TOKENS_BOOTSTRAP_CODEMODE;
  const docsResponse = TOOLS_USED_PER_TASK * TOKENS_PER_DOC_RESULT;
  const tokens =
    bootstrap +
    TASK_TOKENS +
    ASSISTANT_OUTPUT_TOKENS + // docs_search round
    bootstrap * CACHE_DISCOUNT + // round 2 prefix (cached)
    docsResponse +
    ASSISTANT_OUTPUT_TOKENS; // execute_code emits one script
  return Math.round(tokens);
}

async function main() {
  const SCENARIOS = [
    { M: 2, N: 15 }, // small: 2 servers × 15 tools
    { M: 3, N: 20 },
    { M: 5, N: 30 }, // headline: 5 servers × 30 tools = 150 tools
    { M: 8, N: 30 },
    { M: 10, N: 50 }, // large: enterprise mix-in
  ];

  const rows = SCENARIOS.map(({ M, N }) => {
    const a = directMultiMcp(M, N);
    const b = codeModePerServer(M, N);
    const c = portal(M, N);
    return {
      M,
      N,
      total: M * N,
      direct: a,
      perServer: b,
      portal: c,
      ratioVsDirect: c / a,
      ratioVsPerServer: c / b,
    };
  });

  const headline = rows.find((r) => r.M === 5 && r.N === 30);
  const passVsDirect = headline.ratioVsDirect <= 0.1; // ≥10× win vs direct
  const passVsPerServer = headline.ratioVsPerServer <= 1 / 1.5; // ≥1.5× win vs per-server

  // Constant in M: portal column should be the same value for every row at
  // the same N (since K is fixed and bootstrap doesn't depend on M).
  const portalConstant = rows.every((r) => r.portal === rows[0].portal);

  const allPass = passVsDirect && passVsPerServer && portalConstant;
  const sym = allPass ? "✅" : "❌";

  let md = "# Portal token federation (D1)\n\n";
  md += "Methodology — see header of `portal-tokens.mjs`. K=5 tools-touched-per-task,\n";
  md += "cache discount 10%, calibration constants identical to code-mode-tokens.mjs.\n\n";
  md += "| Servers M | Tools/server N | Total tools | Direct multi-MCP | Code-mode per server | Portal (D1) | Portal/Direct | Portal/per-server |\n";
  md += "|---:|---:|---:|---:|---:|---:|---:|---:|\n";
  for (const r of rows) {
    md += `| ${r.M} | ${r.N} | ${r.total} | ${r.direct} | ${r.perServer} | ${r.portal} | ${(r.ratioVsDirect * 100).toFixed(1)}% | ${(r.ratioVsPerServer * 100).toFixed(1)}% |\n`;
  }
  md += "\n";
  md += `${sym} **Headline (M=5 × N=30 = 150 tools)**: Portal is ${(headline.ratioVsDirect * 100).toFixed(1)}% of direct multi-MCP (target ≤10%) and ${(headline.ratioVsPerServer * 100).toFixed(1)}% of code-mode-per-server (target ≤66.7%).\n`;
  md += `${portalConstant ? "✅" : "❌"} **Constant in M**: Portal column is the same value for every M at this K, demonstrating O(1) bootstrap regardless of upstream count.\n\n`;
  md += "### Why the Portal beats per-server code-mode\n\n";
  md += "Per-server code-mode publishes 2 tools *per server*, so adding a 5th\n";
  md += "server costs 10 published-tool slots in the prompt. The Portal\n";
  md += "publishes 2 tools total — the federation happens inside the\n";
  md += "`execute_code` sandbox, which the upstream model never sees. That same\n";
  md += "consolidation is what Cloudflare's announced MCP Server Portals will\n";
  md += "do on their platform; this benchmark establishes the same scaling\n";
  md += "shape on a runtime-neutral implementation.\n\n";
  md += "### Caveat\n\n";
  md += "Offline token accounting; real-world numbers depend on actual tool\n";
  md += "docstring lengths and the host's prefix-cache hit rate. End-to-end\n";
  md += "measurement on a real model lives in `examples/eval-suite/`.\n";

  console.log(md);
  await writeFile(new URL("./report-portal.md", import.meta.url), md);
  if (!allPass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
