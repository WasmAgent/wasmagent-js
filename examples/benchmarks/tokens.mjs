/**
 * Tiny token-equivalent counter. We approximate one token per 4 characters
 * (the OpenAI rule-of-thumb). This is enough to make BEFORE/AFTER ratios
 * meaningful — what every README claim is actually measuring.
 *
 * For real Anthropic-server numbers use the `eval-suite` example with an
 * API key; this proxy is here so the benchmarks can run offline in CI.
 */
export function tokensOf(s) {
  return Math.ceil(String(s).length / 4);
}

/**
 * Pretty-print a benchmark verdict line.
 * @param {string} name      Human-readable name
 * @param {number} ratio     Observed ratio (e.g. 0.63 means 63% of baseline)
 * @param {number} target    Target ratio (e.g. 0.63 == README claim of -37%)
 * @param {number} tolerance Acceptable absolute deviation (default 0.10)
 */
export function verdict(name, ratio, target, tolerance = 0.1) {
  const deviation = Math.abs(ratio - target);
  const pass = deviation <= tolerance;
  const sym = pass ? "✅" : "❌";
  return {
    line: `${sym} ${name}: observed ${(ratio * 100).toFixed(1)}% of baseline (target ${(target * 100).toFixed(1)}%)`,
    pass,
    ratio,
    target,
    deviation,
  };
}
