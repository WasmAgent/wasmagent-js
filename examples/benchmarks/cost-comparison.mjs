/**
 * H② — Cross-model cost-comparison benchmark.
 *
 * Fixes a representative agent trajectory at the *token* level, then prices
 * it against every supported provider's published list rates. Runs entirely
 * offline, like every other bench in this directory — no real API keys, no
 * network. The point is to make "same task, different models, different
 * cache strategies" a single reproducible number set you can read off in
 * the docs and that CI gates against drift.
 *
 * Why no real API calls
 * ─────────────────────
 * Real-API cost benches sound nice but are noisy (rate limits, model
 * deprecations, region routing) and *not* reproducible — the same prompt to
 * Claude on Tuesday returns different token counts than Wednesday. Pricing
 * is the deterministic part. Model output token counts come from the same
 * tokensOf proxy ptc-tokens.mjs / observational-memory.mjs use — calibrated
 * once, stable forever, mechanism-focused.
 *
 * Pricing source
 * ──────────────
 * 2026-Q2 published list rates (USD per 1M tokens), pulled from each
 * provider's pricing page. Update the table when providers re-price.
 */
import { writeFile } from "node:fs/promises";
import { tokensOf } from "./tokens.mjs";

// ─── 1. Fixed task trajectory (same for every model) ────────────────────────
// Mirrors a "moderate tool-calling agent run":
//   • A 6 KB system prompt (skills, hooks, conventions, AGENTS.md)
//   • A 1.5 KB user task
//   • 4 tool round trips, each with ~600 char tool result
//   • A 400-token final answer
// Tokens are produced by the same proxy as our other benches so the numbers
// stay consistent across the whole bench suite.

const SYSTEM_PROMPT = "x".repeat(6_000);
const USER_TASK = "y".repeat(1_500);
const TOOL_RESULTS = Array.from({ length: 4 }, (_, i) => `t${i}: ${"z".repeat(600)}`);
const FINAL_ANSWER_CHARS = "f".repeat(1_600); // ≈ 400 tokens

const systemTokens = tokensOf(SYSTEM_PROMPT);
const userTokens = tokensOf(USER_TASK);
const toolResultTokens = TOOL_RESULTS.reduce((a, t) => a + tokensOf(t), 0);
const finalAnswerTokens = tokensOf(FINAL_ANSWER_CHARS);

// On a 5-step agent run (1 plan + 4 tool calls + 1 wrap-up), each step
// re-sends the system prompt + accumulated history. Without prompt cache,
// total input billed grows quadratic-ish; with cache (the @agentkit-js
// default for Anthropic/Doubao/Kimi/Qwen) the system prefix is a cache
// HIT after step 1 — billed at the cheaper "cached" rate.

const STEPS = 5;

// Tokens billed *to the model* — input direction.
let totalInputUncached = 0;
let totalInputCached = 0;
let totalCacheReads = 0;
let totalCacheWrites = 0;
let cumulativeHistory = 0;

for (let step = 0; step < STEPS; step++) {
  // Step's input prompt = system + user + history-so-far + (next tool result)
  const stepUser = step === 0 ? userTokens : 0;
  const stepHistory = cumulativeHistory;
  const stepToolResult = step > 0 && step <= TOOL_RESULTS.length ? tokensOf(TOOL_RESULTS[step - 1]) : 0;

  // Without cache: pay for everything every step.
  totalInputUncached += systemTokens + stepUser + stepHistory + stepToolResult;

  // With cache: system prefix is cached after first step; pay reduced rate
  // on the cached portion, full rate on the non-cached delta.
  if (step === 0) {
    totalCacheWrites += systemTokens; // initial cache *write* (1.25× rate)
    totalInputCached += stepUser; // user message billed normal
  } else {
    totalCacheReads += systemTokens; // subsequent reads at 0.10× rate
    totalInputCached += stepHistory + stepToolResult;
  }

  cumulativeHistory += stepUser + stepToolResult + (step === STEPS - 1 ? 0 : finalAnswerTokens / STEPS);
}

const totalOutput = finalAnswerTokens + 4 * 80; // 4 tool-call turns ≈ 80 tok each + final answer

// ─── 2. Pricing table (USD per 1M tokens, list rates 2026-Q2) ───────────────
// Rates are "per 1M tokens" — published rates of each provider as of 2026-Q2.
// Where a provider doesn't publish a discounted "cache-read" rate we leave
// it equal to the input rate (i.e. caching gives *no* savings; the
// comparison still surfaces output-bill differences). Where they DO publish
// a cache-read rate, we use it (Anthropic 0.10× of input, OpenAI 0.50× of
// input, Doubao 0.10× of input, etc.).

const PRICING = [
  // provider           input    output  cacheRead  cacheWrite  notes
  ["claude-sonnet-4-6", 3.00,    15.00,  0.30,      3.75,       "Anthropic Claude Sonnet 4.6"],
  ["claude-haiku-4-5",  1.00,    5.00,   0.10,      1.25,       "Anthropic Claude Haiku 4.5"],
  ["claude-opus-4-8",   15.00,   75.00,  1.50,      18.75,      "Anthropic Claude Opus 4.8"],
  ["gpt-4-1",           2.50,    10.00,  1.25,      2.50,       "OpenAI GPT-4.1"],
  ["gpt-4-1-mini",      0.50,    1.60,   0.25,      0.50,       "OpenAI GPT-4.1 Mini"],
  ["doubao-seed-1-6",   0.40,    1.20,   0.04,      0.50,       "Volcengine Ark Doubao Seed 1.6"],
  ["deepseek-v4",       0.27,    1.10,   0.07,      0.27,       "DeepSeek V4 (off-peak)"],
  ["kimi-k2-6",         0.60,    2.50,   0.06,      0.75,       "Moonshot Kimi K2.6"],
  ["qwen3-max",         1.40,    5.60,   1.40,      1.40,       "Alibaba Qwen3 Max (no published cache-read rate)"],
  ["glm-5",             0.50,    1.50,   0.50,      0.50,       "Zhipu GLM-5 (no published cache-read rate)"],
  ["minimax-m3",        0.30,    1.20,   0.30,      0.30,       "MiniMax M3 (no published cache-read rate)"],
];

// ─── 3. Compute per-model totals ────────────────────────────────────────────
// USD = (tokens / 1_000_000) × ratePerMillion
const M = 1_000_000;
const rows = PRICING.map(([id, inRate, outRate, cacheReadRate, cacheWriteRate, label]) => {
  const noCacheUsd = (totalInputUncached * inRate + totalOutput * outRate) / M;
  const cachedUsd =
    (totalInputCached * inRate +
      totalCacheReads * cacheReadRate +
      totalCacheWrites * cacheWriteRate +
      totalOutput * outRate) /
    M;
  const savings = ((noCacheUsd - cachedUsd) / noCacheUsd) * 100;
  return { id, label, noCacheUsd, cachedUsd, savings };
});

// Sort by cached-cost ascending (the column users actually care about).
rows.sort((a, b) => a.cachedUsd - b.cachedUsd);

const cheapest = rows[0];
const mostExpensive = rows[rows.length - 1];
const ratio = mostExpensive.cachedUsd / cheapest.cachedUsd;

// ─── 4. Report ──────────────────────────────────────────────────────────────
const lines = [];
lines.push("# Cross-model cost comparison\n");
lines.push("Same agent trajectory, priced against every supported provider's published 2026-Q2 list rates.\n");
lines.push("**Trajectory shape:**");
lines.push(`- System prompt: ${systemTokens.toLocaleString()} tokens (skills + hooks + AGENTS.md)`);
lines.push(`- User task: ${userTokens.toLocaleString()} tokens`);
lines.push(`- ${STEPS}-step run with 4 tool calls (~${(toolResultTokens / 4).toFixed(0)} tokens each)`);
lines.push(`- Final answer: ${finalAnswerTokens.toLocaleString()} tokens output`);
lines.push("");
lines.push(`Total **input** tokens billed without cache: \`${totalInputUncached.toLocaleString()}\``);
lines.push(`Total **input** tokens billed with cache: \`${(totalInputCached + totalCacheReads + totalCacheWrites).toLocaleString()}\` (${totalCacheReads.toLocaleString()} cache-read, ${totalCacheWrites.toLocaleString()} cache-write)`);
lines.push(`Total **output** tokens: \`${totalOutput.toLocaleString()}\``);
lines.push("");

lines.push("## Cost per run\n");
lines.push("| Model | Cost (no cache) | Cost (with cache) | Cache savings |");
lines.push("|---|---:|---:|---:|");
for (const r of rows) {
  lines.push(
    `| **${r.id}** ${r.label.includes("(no published") ? "*†*" : ""} | $${r.noCacheUsd.toFixed(4)} | $${r.cachedUsd.toFixed(4)} | ${r.savings.toFixed(0)}% |`,
  );
}
lines.push("");
lines.push("*† Provider does not publish a discounted cache-read rate; \"with cache\" cost equals \"no cache\".*\n");
lines.push("## Headline\n");
lines.push(
  `- Cheapest run with cache: **${cheapest.id}** at **$${cheapest.cachedUsd.toFixed(4)}**`,
);
lines.push(
  `- Most expensive: **${mostExpensive.id}** at **$${mostExpensive.cachedUsd.toFixed(4)}** (${ratio.toFixed(1)}× cheapest)`,
);
lines.push("");
lines.push("## Reproduce\n");
lines.push("```bash");
lines.push("bun run bench -- cost-comparison");
lines.push("```");
lines.push("");
lines.push("Pricing table lives at the top of `examples/benchmarks/cost-comparison.mjs` —");
lines.push("update it when providers re-price. Trajectory shape is fixed; only rates change.");

const md = lines.join("\n");
console.log(md);

// Write the markdown report next to the script.
const reportUrl = new URL("./report-cost-comparison.md", import.meta.url);
await writeFile(reportUrl, md, "utf8");

// ─── 5. Tolerance gate ──────────────────────────────────────────────────────
// CI assertion: cheapest model's cached cost must stay below $0.05 and
// most-expensive must stay below $5. This catches accidental pricing-table
// edits that would silently inflate the marketing numbers, AND token-count
// drifts in tokens.mjs.
const ok = cheapest.cachedUsd < 0.05 && mostExpensive.cachedUsd < 5.0 && ratio >= 5 && ratio <= 200;

if (!ok) {
  console.error(
    `\n❌ Cost comparison out of tolerance: cheapest=$${cheapest.cachedUsd.toFixed(4)}, mostExpensive=$${mostExpensive.cachedUsd.toFixed(4)}, ratio=${ratio.toFixed(1)}x`,
  );
  process.exit(1);
}
console.log(`\n✅ Cross-model cost comparison within tolerance.`);
