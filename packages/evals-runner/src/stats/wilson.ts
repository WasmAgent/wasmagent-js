/**
 * Wilson score confidence interval for a binomial proportion.
 *
 * Source: Wilson, E.B. (1927). "Probable inference, the law of succession,
 * and statistical inference." JASA 22:209–212.
 *
 * Wilson is preferred over the normal-approximation Wald interval at both
 * tails (esp. p≈0 / p≈1 where Wald produces invalid bounds outside [0,1]).
 *
 * Matches scipy.stats.binomtest(...).proportion_ci(method="wilson") and
 * statsmodels.stats.proportion.proportion_confint(method="wilson") to
 * within floating-point tolerance.
 *
 * @param successes Number of successes.
 * @param total     Total trials.
 * @param alpha     Two-sided alpha. Default 0.05 → 95% CI.
 * @returns [lo, hi] in [0,1].
 */
export function wilsonCI(successes: number, total: number, alpha = 0.05): [number, number] {
  if (total === 0) return [0, 0];
  if (successes < 0 || successes > total) {
    throw new Error(`wilsonCI: successes=${successes} out of range [0, ${total}]`);
  }
  const z = invNormalCDF(1 - alpha / 2); // critical value
  const phat = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = (phat + (z * z) / (2 * total)) / denom;
  const halfWidth =
    (z * Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total))) / denom;
  const lo = Math.max(0, centre - halfWidth);
  const hi = Math.min(1, centre + halfWidth);
  return [lo, hi];
}

/**
 * Inverse of the standard normal CDF (probit). Implementation: Acklam (2003)
 * rational approximation. Accurate to ~1e-9 for p ∈ (0,1), which is more
 * than enough for confidence-interval critical values.
 *
 * Public for reuse by the bootstrap and conformal stats; not exported from
 * the package barrel because callers should typically reach for `wilsonCI`.
 */
export function invNormalCDF(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new Error(`invNormalCDF: p must be in (0,1), got ${p}`);
  }
  // Acklam coefficients. Tuple types pin element access — required under
  // `noUncheckedIndexedAccess`, which would otherwise flag every `a[i]` as
  // possibly-undefined and force runtime checks for compile-time-static data.
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ] as const;
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ] as const;
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ] as const;
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
  ] as const;
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}
