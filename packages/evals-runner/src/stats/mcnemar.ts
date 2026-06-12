/**
 * McNemar's exact test for paired binary outcomes.
 *
 * Given two systems (candidate, baseline) evaluated on the same items, the
 * 2×2 confusion table has off-diagonal counts:
 *   b = items where candidate is RIGHT and baseline is WRONG
 *   c = items where candidate is WRONG and baseline is RIGHT
 *
 * Under H0 (no difference between systems), b ~ Binomial(b+c, 0.5). We
 * compute the exact two-sided p-value as
 *   p = 2 · min( P(X ≤ min(b,c)),  P(X ≥ max(b,c))  )
 * clipped to ≤ 1.
 *
 * Matches `scipy.stats.contingency.mcnemar(..., exact=True)`.
 *
 * @returns { p, b, c, n: b+c }
 */
export function mcnemarExact(b: number, c: number): { p: number; b: number; c: number; n: number } {
  if (b < 0 || c < 0 || !Number.isInteger(b) || !Number.isInteger(c)) {
    throw new Error(`mcnemarExact: b/c must be non-negative integers, got b=${b}, c=${c}`);
  }
  const n = b + c;
  if (n === 0) return { p: 1, b, c, n };
  const k = Math.min(b, c);
  // P(X ≤ k) under Binomial(n, 0.5).
  const tail = binomialCDF(k, n, 0.5);
  // Two-sided p: by symmetry of Binom(n,0.5) around n/2, the upper tail
  // P(X ≥ n-k) equals tail. So p = 2·tail, clipped to [0,1].
  return { p: Math.min(1, 2 * tail), b, c, n };
}

/**
 * Binomial CDF: P(X ≤ k) for X ~ Binomial(n, p). Computed in log-space to
 * avoid underflow at large n. Accurate to ~1e-12 for n ≤ 10⁶.
 */
export function binomialCDF(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let cdf = 0;
  // Compute pmf(0) = (1-p)^n, then iterate via the multiplicative ratio
  // pmf(i+1)/pmf(i) = (n-i)/(i+1) · p/(1-p).
  let logPmf = n * Math.log(1 - p);
  cdf = Math.exp(logPmf);
  for (let i = 0; i < k; i++) {
    logPmf += Math.log((n - i) / (i + 1)) + Math.log(p / (1 - p));
    cdf += Math.exp(logPmf);
  }
  return Math.min(1, cdf);
}
