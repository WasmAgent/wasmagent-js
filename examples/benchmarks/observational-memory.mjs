/**
 * A1 — ObservationalMemory token benchmark.
 *
 * Verifies the docs claim: continuous observation compresses long
 * conversations to ≤25% of the baseline prefix on a 50-turn synthetic
 * trace. Mirrors the structural mechanism in
 * packages/core/src/memory/ObservationalMemory.ts (compressed observations
 * land at the front; `keepRecentSteps` trail verbatim) but reimplements
 * the math here so the benchmark stays runnable in plain Node — same
 * pattern as context-editing.mjs.
 *
 * Quality of the compression itself (do summaries actually preserve enough
 * to answer follow-up questions?) is the eval-suite's job. This benchmark
 * is purely about token-count mechanics.
 */
import { writeFile } from "node:fs/promises";
import { tokensOf, verdict } from "./tokens.mjs";

const TURNS = 50;
const PER_TURN_CHARS = 1200; // ~300 tokens per turn
const KEEP_RECENT = 5;

// Observation length the cheap observer model would produce. Mastra's
// reference work shows ~80–120 tokens per observation in practice; we use
// the conservative end of that range so the benchmark is honest about
// what real observers cost.
const OBS_TOKENS = 120;
// Token threshold at which the observer fires. The smaller this is, the
// more often we compress and the better the ratio.
const TOKEN_THRESHOLD = 2400; // ~8 turns

function turnText(i) {
  return `turn ${i}: ${"x".repeat(PER_TURN_CHARS)}`;
}

function baselineTokens(turns) {
  let total = tokensOf("system");
  for (let i = 0; i < turns; i++) total += tokensOf(turnText(i));
  return total;
}

/**
 * Run one pass of the simulation. After every turn, when the cumulative
 * unobserved tokens exceed the threshold AND there are more than
 * keepRecent unobserved turns, the observer collapses everything older
 * than the trailing window into one OBS_TOKENS-token observation.
 */
function observationalTokens(turns) {
  let observations = 0;
  // Window of "unobserved" turn indices, oldest first.
  let unobserved = [];
  for (let i = 0; i < turns; i++) {
    unobserved.push(i);
    const trailingTokens = unobserved
      .map((j) => tokensOf(turnText(j)))
      .reduce((a, b) => a + b, 0);
    if (trailingTokens >= TOKEN_THRESHOLD && unobserved.length > KEEP_RECENT) {
      // Collapse all but the trailing KEEP_RECENT turns.
      unobserved = unobserved.slice(-KEEP_RECENT);
      observations += 1;
    }
  }
  // Final prefix = system + N observations + trailing turns verbatim.
  let total = tokensOf("system");
  total += observations * OBS_TOKENS;
  for (const j of unobserved) total += tokensOf(turnText(j));
  return { total, observations };
}

/**
 * One-shot compact() simulation: leave only the trailing KEEP_RECENT
 * turns verbatim, replace everything else with one ~2× OBS_TOKENS
 * summary (compact() instructions ask for a denser one-shot summary).
 */
function compactTokens(turns) {
  let total = tokensOf("system") + OBS_TOKENS * 2;
  for (let i = turns - KEEP_RECENT; i < turns; i++) {
    total += tokensOf(turnText(i));
  }
  return total;
}

async function main() {
  const baseline = baselineTokens(TURNS);
  const compact = compactTokens(TURNS);
  const obs = observationalTokens(TURNS);

  const ratioCompact = compact / baseline;
  const ratioObs = obs.total / baseline;

  // Doc target: ≤25% of baseline, ie ≥4× compression.
  const v = verdict("ObservationalMemory token compression", ratioObs, 0.18, 0.10);

  let md = "# Observational memory token benchmark\n\n";
  md += `Synthetic 50-turn conversation, ~${PER_TURN_CHARS / 4} tokens per turn.\n\n`;
  md += "| Mode | Prefix tokens | Ratio vs baseline |\n|---|---:|---:|\n";
  md += `| Baseline (no compression) | ${baseline} | 100.0% |\n`;
  md += `| One-shot compact() | ${compact} | ${(ratioCompact * 100).toFixed(1)}% |\n`;
  md += `| ObservationalMemory (continuous) | ${obs.total} | ${(ratioObs * 100).toFixed(1)}% |\n\n`;
  md += `${v.line}\n\n`;
  md += `Observations produced: ${obs.observations}. ` +
    `Each observation modeled at ${OBS_TOKENS} tokens; ` +
    `trailing window: ${KEEP_RECENT} turns; threshold: ${TOKEN_THRESHOLD} tokens.\n`;

  console.log(md);
  await writeFile(
    new URL("./report-observational-memory.md", import.meta.url),
    md,
  );
  if (!v.pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
