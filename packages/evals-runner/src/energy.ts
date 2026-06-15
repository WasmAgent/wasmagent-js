/**
 * Energy estimation utilities (P16-8 ④).
 *
 * macOS powermetrics requires root privileges. Instead we use a
 * token-throughput × TDP model: if a model generates T tokens at
 * tokens/s = T / wallMs * 1000, and the chip's TDP is W watts,
 * then energy ≈ wallMs/1000 × W joules.
 *
 * This is a rough estimate but sufficient for relative comparison
 * (J/correct across models). For hardware-accurate measurements,
 * run `sudo powermetrics --samplers gpu_power -n 1 -i 1000` externally.
 *
 * Reference TDP values for Apple Silicon (approximate):
 *   M1 / M2: ~10-15W active inference
 *   M3 / M3 Pro: ~15-20W
 *   M3 Max: ~40-50W
 *   (GPU clusters, not whole-chip; actual varies by workload)
 *
 * Usage:
 *   const jPerCorrect = estimateJoulesPerCorrect(aggregate, { tdpWatts: 40 });
 */

import type { SuiteAggregate } from "./types.js";

export interface EnergySpec {
  /** Estimated active TDP in watts during inference. Default: 20 (conservative Apple Silicon). */
  tdpWatts?: number;
}

export interface EnergyReport {
  modelId: string;
  suiteName: string;
  /** Total wall-clock for all cells (ms). */
  totalWallMs: number;
  /** Estimated total energy (joules). */
  totalJoules: number;
  /** Joules per correct answer — the key efficiency metric. */
  joulesPerCorrect: number;
  /** Joules per token generated. */
  joulesPerToken: number;
  /** Tokens per second (throughput). */
  tokensPerSecond: number;
  /** Accuracy (passedCells / totalCells). */
  accuracy: number;
  /** Warmup energy not included (warmupMs is excluded from cells). */
  warmupJoules: number;
  tdpWatts: number;
}

/**
 * Estimate energy efficiency for a model on a suite.
 *
 * @param aggregate  - per-(model, suite) rollup from runEvaluation
 * @param spec       - hardware TDP spec
 * @returns EnergyReport with J/correct as the primary efficiency metric
 */
export function estimateJoulesPerCorrect(
  aggregate: SuiteAggregate,
  spec: EnergySpec = {}
): EnergyReport {
  const tdpWatts = spec.tdpWatts ?? 20;

  // Total wall time for all evaluation cells (warmup excluded by design).
  // We reconstruct total from median × totalCells as a proxy since we only
  // have p95 and median in the aggregate; totalCells × medianWallMs gives
  // a reasonable estimate.
  const totalWallMs = aggregate.medianWallMs * aggregate.totalCells;
  const totalJoules = (totalWallMs / 1000) * tdpWatts;

  const tokensPerSecond = totalWallMs > 0 ? (aggregate.totalTokens / totalWallMs) * 1000 : 0;

  const joulesPerToken = aggregate.totalTokens > 0 ? totalJoules / aggregate.totalTokens : 0;

  const joulesPerCorrect =
    aggregate.passedCells > 0 ? totalJoules / aggregate.passedCells : Infinity;

  const warmupJoules = (aggregate.warmupMs / 1000) * tdpWatts;

  return {
    modelId: aggregate.modelId,
    suiteName: aggregate.suiteName,
    totalWallMs,
    totalJoules,
    joulesPerCorrect,
    joulesPerToken,
    tokensPerSecond,
    accuracy: aggregate.totalCells > 0 ? aggregate.passedCells / aggregate.totalCells : 0,
    warmupJoules,
    tdpWatts,
  };
}

/**
 * Render energy report as a markdown table row.
 *
 * Example output:
 *   | `evo-qwen3-1b7` | 97% | 1,234 ms | 2.4W×1.2s = 2.9 J | **0.12 J/✓** |
 */
export function renderEnergyRow(r: EnergyReport): string {
  const jStr = r.joulesPerCorrect === Infinity ? "∞" : `${r.joulesPerCorrect.toFixed(2)} J`;
  const throughput = `${r.tokensPerSecond.toFixed(0)} tok/s`;
  return (
    `| \`${r.modelId}\` | ${(r.accuracy * 100).toFixed(1)}% ` +
    `| ${Math.round(r.totalWallMs / r.accuracy || 0).toLocaleString()} ms/✓ ` +
    `| ${throughput} | **${jStr}/✓** |`
  );
}

/**
 * Render full energy comparison table for a suite.
 */
export function renderEnergyTable(reports: EnergyReport[], suiteTitle: string): string {
  const lines: string[] = [];
  lines.push(`### Energy efficiency — \`${suiteTitle}\``);
  lines.push("");
  lines.push(
    `> TDP assumed ${reports[0]?.tdpWatts ?? 20}W (Apple Silicon active inference estimate). ` +
      `For hardware-accurate J/correct, run \`sudo powermetrics --samplers gpu_power\` externally.`
  );
  lines.push("");
  lines.push("| Model | Accuracy | Wall/correct | Throughput | J/correct |");
  lines.push("|---|---:|---:|---:|---:|");
  // Sort by J/correct ascending (lower is better)
  const sorted = [...reports].sort((a, b) => a.joulesPerCorrect - b.joulesPerCorrect);
  for (const r of sorted) {
    lines.push(renderEnergyRow(r));
  }
  lines.push("");
  lines.push(
    "> J/correct = total-joules ÷ correct-answers. " +
      "Lower is better — this captures both accuracy and throughput."
  );
  return lines.join("\n");
}
