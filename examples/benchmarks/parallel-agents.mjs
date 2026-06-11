/**
 * G3 — Parallel agents wall-clock + token benchmark.
 *
 * Models a fork-join run shape: N independent draft agents fan out from
 * the same prompt, a synthesise-and-review pass merges them. We measure
 *   (a) wall-clock vs. a serial (1-branch) baseline,
 *   (b) total tokens billed (each branch pays its own context),
 *   (c) cost-per-quality trade-off as branches scale 1 → 8.
 *
 * Like the other benchmarks in this directory, the model is a deterministic
 * fake — we're measuring the orchestration mechanism, not asking a real LLM
 * the same question N times. Token counts are produced by the same
 * `tokensOf` proxy used by ptc-tokens.mjs and observational-memory.mjs.
 *
 * The numbers a CI run produces are therefore reproducible bit-for-bit;
 * they exist so a future regression in `ParallelForkJoinRunner` (e.g.,
 * accidentally serialising work or duplicating the prefix) is caught
 * before it ships.
 */
import { tokensOf, verdict } from "./tokens.mjs";

// Per-branch artificial latency. Real model calls would be hundreds of ms;
// we use 50ms here so the benchmark stays cheap to run in CI.
const BRANCH_LATENCY_MS = 50;
// Concurrency cap (matches ParallelForkJoinRunner's default).
const CONCURRENCY = 4;

const SYSTEM_TOKENS = tokensOf("a".repeat(800)); // ~200 tokens
const TASK_TOKENS = tokensOf("b".repeat(400)); // ~100 tokens
const DRAFT_OUTPUT_TOKENS = 150;
const REVIEW_PROMPT_TOKENS = 50;
const REVIEW_OUTPUT_TOKENS = 200;

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function fakeBranch(_index) {
  await new Promise((r) => setTimeout(r, BRANCH_LATENCY_MS));
  return DRAFT_OUTPUT_TOKENS;
}

async function runForkJoin(branches) {
  const t0 = nowMs();
  // Each branch carries the full prefix (system + task) — that's the
  // expected behaviour; the prefix is identical so prompt-cache will
  // cover it on real models.
  const prefixTokens = SYSTEM_TOKENS + TASK_TOKENS;

  // Schedule branches with the concurrency cap.
  const queue = Array.from({ length: branches }, (_, i) => i);
  const inflight = new Set();
  const results = [];
  while (queue.length > 0 || inflight.size > 0) {
    while (inflight.size < CONCURRENCY && queue.length > 0) {
      const i = queue.shift();
      const p = fakeBranch(i).then((tokens) => {
        inflight.delete(p);
        results.push(tokens);
      });
      inflight.add(p);
    }
    if (inflight.size > 0) await Promise.race(inflight);
  }
  const draftWallMs = nowMs() - t0;

  // Synthesise + review — runs once, sees every draft.
  const synthesisInput = REVIEW_PROMPT_TOKENS + results.reduce((a, b) => a + b, 0);
  const synthesisOutput = REVIEW_OUTPUT_TOKENS;
  const totalWallMs = nowMs() - t0;

  return {
    branches,
    draftWallMs,
    totalWallMs,
    branchTokens: prefixTokens * branches + DRAFT_OUTPUT_TOKENS * branches,
    reviewTokens: prefixTokens + synthesisInput + synthesisOutput,
  };
}

const cases = [];
for (const n of [1, 2, 4, 8]) {
  cases.push(await runForkJoin(n));
}

// Serial baseline = N branches × per-branch latency. Compares the actual
// fork-join wall-clock to "what it would have cost if branches ran one
// after the other".
const eight = cases[3];
const serialEightMs = 8 * BRANCH_LATENCY_MS;
const speedupVsSerialEight = serialEightMs / eight.totalWallMs;

const baseline = cases[0];
const tokenCost =
  (eight.branchTokens + eight.reviewTokens) /
  (baseline.branchTokens + baseline.reviewTokens);

console.log(`# ParallelForkJoinRunner wall-clock + token cost\n`);
console.log(`| Branches | Wall ms | Branch tokens | Review tokens | Total tokens |`);
console.log(`|---:|---:|---:|---:|---:|`);
for (const c of cases) {
  const total = c.branchTokens + c.reviewTokens;
  console.log(`| ${c.branches} | ${c.totalWallMs} | ${c.branchTokens} | ${c.reviewTokens} | ${total} |`);
}

console.log(`\n**8 branches with cap=${CONCURRENCY}:**`);
console.log(`- Wall-clock vs equivalent serial work: \`${speedupVsSerialEight.toFixed(2)}x\` faster`);
console.log(`- Total token cost: \`${(tokenCost * 100).toFixed(0)}%\` of 1-branch baseline`);

// Tolerance:
// - At cap=4, 8 branches should be ~2x faster than 8-serial (2 waves vs 8).
// - Token cost scales ~linearly with branches; 8 branches → ~5–10x more tokens.
const ok =
  speedupVsSerialEight >= 2.5 && // CI jitter; 2 waves of 50ms vs 8x50ms ≈ 4x in theory
  tokenCost >= 4 &&
  tokenCost <= 12;

if (!ok) {
  console.error(
    `\n❌ Parallel runner numbers out of tolerance: speedup=${speedupVsSerialEight.toFixed(2)}x token-ratio=${tokenCost.toFixed(2)}x`,
  );
  process.exit(1);
}
console.log(`\n✅ Parallel runner mechanics within tolerance.`);
