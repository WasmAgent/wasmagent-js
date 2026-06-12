/**
 * Cost-per-correct — same items as multi-turn-memory, but the headline
 * metric is `(total cost USD) / (passed cells)` instead of accuracy.
 *
 * Why this is its own suite: it tells you which model gives the most
 * answers per dollar — exactly the axis accuracy-only benchmarks ignore
 * but production buyers care about. Pareto front becomes meaningful only
 * when this column exists.
 *
 * The suite reuses multiTurnMemorySuite items verbatim, so a user can
 * compare cost vs accuracy as paired axes: same items, two suites.
 */

import type { BenchmarkSuite } from "../types.js";
import { multiTurnMemorySuite } from "./multi-turn-memory.js";

export const costPerCorrectSuite: BenchmarkSuite = {
  name: "cost-per-correct",
  title: "Cost-per-correct on multi-turn memory items",
  description:
    "Same 6 items as multi-turn-memory; reports total USD spend / number of passes. Requires pricePer1MInput and pricePer1MOutput on each ModelSpec. Local Ollama models report $0 — useful for time-per-correct comparison instead.",
  items: multiTurnMemorySuite.items,
  scorers: multiTurnMemorySuite.scorers,
};
