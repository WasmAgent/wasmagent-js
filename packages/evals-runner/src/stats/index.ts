/**
 * Public stats surface — paired statistics for evaluation comparisons.
 * Standard model-evaluation toolkit: McNemar exact paired test, Wilson
 * proportion CI, paired percentile bootstrap, pooled-across-seeds gate.
 */

export { pairedBootstrap } from "./bootstrap.js";
export type { G1Report, SeedResult } from "./g1Gate.js";
export { buildG1Report } from "./g1Gate.js";
export { binomialCDF, mcnemarExact } from "./mcnemar.js";
export { invNormalCDF, wilsonCI } from "./wilson.js";
