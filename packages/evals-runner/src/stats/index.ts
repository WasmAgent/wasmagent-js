/**
 * Public stats surface — paired statistics for evaluation comparisons.
 * Standard model-evaluation toolkit: McNemar exact paired test, Wilson
 * proportion CI, paired percentile bootstrap, pooled-across-seeds gate.
 *
 * 2026-06-15: + IPT (Isomorphic Perturbation Test) for reward-hacking
 * shortcut detection (Helff et al., ICLR 2026 Workshop).
 */

export { pairedBootstrap } from "./bootstrap.js";
export type { G1Report, SeedResult } from "./g1Gate.js";
export { buildG1Report } from "./g1Gate.js";
export type { IptCohort, IptPair, IptPairVerdict, IptVerdict } from "./ipt.js";
export { iptClassify, iptShortcutRate } from "./ipt.js";
export { binomialCDF, mcnemarExact } from "./mcnemar.js";
export { invNormalCDF, wilsonCI } from "./wilson.js";
