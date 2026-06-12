/**
 * swe-bench-lite.mjs — SWE-bench-lite-class code-mode dispatch benchmark (DRAFT).
 *
 * Direction 2 of the 2026-06-12 optimization brief calls for a
 * single citable public-leaderboard number to break the chicken-and-egg
 * traction problem. LongMemEval-500 is the answer for the memory axis;
 * SWE-bench-lite-class is the answer for the *code-mode dispatch* axis,
 * directly comparable to Cloudflare Code Mode MCP (whose numbers are
 * not public, so any honest agentkit number is automatically the
 * first-mover entry on this axis).
 *
 * ## Status
 *
 * **DRAFT — not for publication runs yet.** This file is the skeleton
 * harness we want to fill in before we burn API budget. The file
 * lives in the repo today so that:
 *
 *   1. The methodology is reviewable in PR before any number is
 *      announced (per the strategy memo's "no private benchmarks"
 *      rule in section 4).
 *   2. The sample-mode (`--smoke`) path can run in CI as a
 *      regression guard once the harness is live.
 *   3. Contributors looking at the upstream-prs directory can find
 *      the leaderboard companion artefact in the same place.
 *
 * The first published run is funding-dependent (🖥️ in ROADMAP). The
 * placeholder report lives at
 * `docs/reports/swe-bench-lite-pending.md`; it follows the same
 * shape as `longmemeval-500-pending.md`.
 *
 * ## What this benchmarks
 *
 * The SWE-bench-lite split is 300 GitHub issue → patch tasks scoped
 * to a small set of repos. The "code-mode dispatch" framing is:
 *
 *   - Expose the repo-edit tool surface (read_file / write_file /
 *     run_tests / git_diff …) via the agentkit code-mode MCP server
 *     (`@agentkit-js/mcp-server`'s `createCodeModeServer()`).
 *   - The agent receives `docs_search` + `execute_code` and dispatches
 *     all tool calls inside a single sandboxed script per step.
 *   - Compare against two baselines:
 *       (a) Direct MCP — same tools, but published as N tool entries.
 *       (b) Cloudflare Code Mode MCP — for the bootstrap-token axis,
 *           we cite their published 1,000-token figure when the
 *           comparison is fair (same N, same tools).
 *
 * Output axes (per task and aggregated):
 *
 *   - resolved (binary): does the patch pass the held-out tests?
 *   - bootstrap_tokens: prompt size at step 0 (smaller is better)
 *   - total_tokens: in + out across the whole solve
 *   - cache_read_tokens: stable-prefix wins, Anthropic-only
 *   - wall_p95_ms: time-to-resolution
 *   - usd_per_solve / j_per_solve: cost & energy for Pareto framing
 *
 * ## Usage (when complete)
 *
 *   # Smoke (CI): 3 tasks, no real model — just exercises the harness:
 *   node swe-bench-lite.mjs --smoke
 *
 *   # Single answerer × code-mode dispatch:
 *   node swe-bench-lite.mjs \
 *     --tasks=300 \
 *     --answerer=claude-sonnet-4-6 \
 *     --answerer-base=https://api.anthropic.com/v1 \
 *     --dispatch=codemode \
 *     --output=docs/reports/swe-bench-lite-2026-XX-XX.md
 *
 *   # Pareto run (the artefact we publish):
 *   node swe-bench-lite.mjs --report \
 *     --tasks=300 \
 *     --answerers=claude-sonnet-4-6,claude-haiku-4-5,gpt-4o-mini \
 *     --dispatch=codemode,direct \
 *     --output=docs/reports/swe-bench-lite-2026-XX-XX.md
 *
 * ## Why first-mover-on-this-axis is the play
 *
 * Cloudflare's Code Mode MCP server published a token-savings story
 * (2026-02 blog) but did NOT publish a SWE-bench-class number. The
 * framework choice for an agent doing real coding work is between
 * "direct MCP" and "code-mode" — and there is no public number for
 * either pattern on a real coding benchmark.
 *
 * Whoever publishes the first credible number on this axis owns the
 * citation slot for the next 6-12 months. The strategy memo's L2 is
 * exactly this: trade self-built numbers for public-leaderboard
 * numbers, on the axes our differentiators actually move.
 *
 * ## What "Pareto" gets us that single-number doesn't
 *
 * SWE-bench-lite's official leaderboard ranks by accuracy alone.
 * That single dimension hides the variance we care about
 * (cost/correct, latency under budget, cache effectiveness). The
 * agentkit report follows the evals-runner Pareto convention:
 * accuracy × USD/correct × p95 wall × J/correct, with the
 * single-axis SWE-bench number called out *and* contextualized
 * in a Pareto plot. A reader who only wants the headline gets it;
 * a reader making a $$$/quality call gets the rest.
 *
 * ## Pre-run checklist
 *
 * Before running for publication, confirm:
 *
 *   [ ] SWE-bench-lite tasks are downloadable (HuggingFace dataset
 *       `princeton-nlp/SWE-bench_Lite`, ~300 instances).
 *   [ ] The fixture loader handles the dataset's known per-instance
 *       skips (env mismatches; tracked upstream).
 *   [ ] The code-mode MCP server is wired with the file/test/git
 *       tool surface AND the capabilities are sandboxed (no
 *       arbitrary network egress; allowedHosts: []).
 *   [ ] The answerer adapter can plumb `cache_read_input_tokens`
 *       so we can report cache hit rate.
 *   [ ] The judge step (does the patch pass tests?) runs in a
 *       container, not on the host.
 *   [ ] A dry run on a 5-task subset matches the expected pass
 *       rate within ±10% of a known reference (e.g. published
 *       Sonnet-4-6 on SWE-bench-lite).
 */

import { writeFile } from "node:fs/promises";

const DEFAULT_REPORT_PATH = "docs/reports/swe-bench-lite-pending.md";

// ── flag parsing ─────────────────────────────────────────────────────────────
// Same shape as longmemeval-500.mjs so users have one mental model.
const args = parseArgs(process.argv.slice(2));

if (args["help"] || (args._.length === 0 && Object.keys(args).length === 1)) {
  printHelp();
  process.exit(0);
}

if (args["smoke"]) {
  await smokeRun();
  process.exit(0);
}

console.error(
  "swe-bench-lite.mjs is a DRAFT skeleton — the publication run is funding-dependent.\n" +
    "See docs/reports/swe-bench-lite-pending.md for status.\n" +
    "Use --smoke to exercise the harness offline, or contribute to the\n" +
    "pre-run checklist in the file's docblock."
);
process.exit(2);

// ── implementation slots ─────────────────────────────────────────────────────
// Each function below is a clearly-named extension point. The intent is
// that a contributor (or co-maintainer candidate from the upstream-prs
// pipeline) can fill in one slot at a time without holding the whole
// run in their head.

// eslint-disable-next-line no-unused-vars
async function loadTasks(_count) {
  // TODO: download SWE-bench_Lite from HuggingFace (or a local cache),
  // return [{ instance_id, repo, base_commit, problem_statement,
  // test_patch, ...}]. Honor the known skip-list at the top of the
  // upstream dataset README.
  throw new Error("loadTasks: not yet implemented");
}

// eslint-disable-next-line no-unused-vars
async function dispatchCodemode(_task, _answerer) {
  // TODO: wire @agentkit-js/mcp-server createCodeModeServer with the
  // file/test/git tool surface, run the answerer with docs_search +
  // execute_code, capture per-step tokens + cache_read tokens.
  throw new Error("dispatchCodemode: not yet implemented");
}

// eslint-disable-next-line no-unused-vars
async function dispatchDirect(_task, _answerer) {
  // TODO: same tool surface, but exposed as N direct MCP tools.
  // Same answerer model, same task — only the dispatch shape varies.
  throw new Error("dispatchDirect: not yet implemented");
}

// eslint-disable-next-line no-unused-vars
async function runTests(_task, _patch) {
  // TODO: apply the patch in a containerised checkout, run the
  // task's test suite, return { passed: boolean, failed: [...]}.
  // Containerisation is a hard gate — never run on the host.
  throw new Error("runTests: not yet implemented");
}

// eslint-disable-next-line no-unused-vars
async function reportPareto(_results, _outPath) {
  // TODO: write the Pareto report (accuracy × USD/correct × p95 wall ×
  // J/correct), per dispatch shape, per answerer. Format: same as
  // evals-runner's reportEvaluationsPareto so we get free
  // McNemar / Wilson CI / paired-bootstrap framing.
  throw new Error("reportPareto: not yet implemented");
}

async function smokeRun() {
  // Exercises the parser + report scaffolding without touching the
  // real dataset or any model. CI guard: changes to this file should
  // not break --smoke.
  const out = [
    "# SWE-bench-lite — smoke run output",
    "",
    "> Smoke run produced no real numbers. The full harness is",
    "> draft — see the docblock at the top of",
    "> `examples/benchmarks/swe-bench-lite.mjs` for the pre-run",
    "> checklist and the placeholder report at",
    `> \`${DEFAULT_REPORT_PATH}\` for what gets published.`,
    "",
  ].join("\n");
  console.log(out);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v ?? true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function printHelp() {
  console.log(`
swe-bench-lite.mjs — SWE-bench-lite-class code-mode dispatch benchmark (DRAFT).

Status: skeleton. Direction 2 of the 2026-06-12 optimization brief.
The full harness is funding-dependent; the file in the repo defines
the methodology + slots a contributor can fill in.

Usage:
  --smoke                       Run the offline harness exerciser (CI guard).
  --tasks=N                     Number of SWE-bench-lite tasks (full set: 300).
  --answerer=ID                 Single answerer model id.
  --answerer-base=URL           Answerer base URL (OpenAI-compat / Anthropic).
  --answerers=ID,ID,...         Multi-answerer report mode.
  --dispatch=codemode|direct    Dispatch shape under test.
  --output=PATH                 Report output path.
  --help                        Print this help.
`);
}
