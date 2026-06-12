/**
 * Paired bootstrap CI for the accuracy delta between candidate and baseline.
 *
 * Given two boolean[] arrays of equal length (each item: did the system get
 * it right?), we resample WITH REPLACEMENT at the item level (preserving the
 * pairing — the same resampled indices are used for both candidate and
 * baseline) and compute the accuracy delta at each resample. The empirical
 * percentile interval over B resamples is the bootstrap CI.
 *
 * @param candidateMatches Boolean array: was candidate correct on each item?
 * @param baselineMatches  Boolean array: was baseline correct on each item?
 * @param B                Resamples. Default 2000 — the standard for
 *                         model-evaluation paired-stats workflows.
 * @param alpha            Two-sided alpha. Default 0.05 → 95% CI.
 * @param seed             RNG seed. Default 0 — reproducible across runs.
 */
export function pairedBootstrap(
  candidateMatches: readonly boolean[],
  baselineMatches: readonly boolean[],
  B = 2000,
  alpha = 0.05,
  seed = 0
): { meanDelta: number; ciLo: number; ciHi: number; B: number } {
  if (candidateMatches.length !== baselineMatches.length) {
    throw new Error(
      `pairedBootstrap: arrays must be same length, got ${candidateMatches.length} vs ${baselineMatches.length}`
    );
  }
  const n = candidateMatches.length;
  if (n === 0) return { meanDelta: 0, ciLo: 0, ciHi: 0, B };

  const rng = mulberry32(seed >>> 0);
  const deltas = new Float64Array(B);
  for (let bIdx = 0; bIdx < B; bIdx++) {
    let cand = 0;
    let base = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rng() * n);
      if (candidateMatches[j]) cand++;
      if (baselineMatches[j]) base++;
    }
    deltas[bIdx] = (cand - base) / n;
  }
  // Mean of deltas.
  let sum = 0;
  for (const d of deltas) sum += d;
  const meanDelta = sum / B;
  // Percentile CI.
  const sorted = Array.from(deltas).sort((a, b) => a - b);
  const loIdx = Math.floor((alpha / 2) * B);
  const hiIdx = Math.min(B - 1, Math.ceil((1 - alpha / 2) * B) - 1);
  return { meanDelta, ciLo: sorted[loIdx] as number, ciHi: sorted[hiIdx] as number, B };
}

/**
 * Mulberry32 — small, fast, well-distributed deterministic RNG. Used here
 * for reproducibility: same seed → same bootstrap CI bit-for-bit. Not
 * cryptographic. https://github.com/bryc/code/blob/master/jshash/PRNGs.md
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
