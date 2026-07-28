/**
 * Compile a CapabilityManifest + RiskContext into a RecordingPolicy.
 *
 * The recording policy determines how much evidence to capture for a given
 * tool invocation based on manifest constraints and runtime risk signals.
 *
 * Decision priority (highest severity wins):
 *   1. wasVetted === true → full
 *   2. hasConsentAnomaly === true → full
 *   3. taintChainLength > 0 AND sideEffectClass !== "read" → full
 *   4. sideEffectClass === "unknown" → full
 *   5. sideEffectClass is "mutate-external" or "network-egress" → full
 *   6. sideEffectClass === "mutate-local" AND no anomaly → delta
 *   7. sideEffectClass === "read" AND no anomaly → validation
 */

import type { CapabilityManifest } from "@wasmagent/core";

export interface RiskContext {
  /** Whether the tool was flagged by a vetting/review process. */
  wasVetted: boolean;
  /** Whether a consent anomaly was detected (e.g. user did not explicitly approve). */
  hasConsentAnomaly: boolean;
  /** Length of the taint chain — number of prior tainted hops reaching this call. */
  taintChainLength: number;
  /** Classification of the tool's side-effect behaviour. */
  sideEffectClass: "read" | "mutate-local" | "mutate-external" | "network-egress" | "unknown";
}

export interface RecordingPolicy {
  /** The recording mode to apply. */
  mode: "validation" | "delta" | "full";
  /** Human-readable reason for the decision. */
  reason: string;
}

/**
 * Compile a CapabilityManifest and RiskContext into a RecordingPolicy.
 *
 * The manifest is accepted for future use (e.g. manifest-scoped overrides)
 * but the current logic derives the decision purely from the RiskContext.
 *
 * Invariant: unknown side-effect class always produces the highest severity
 * (full recording) — treating unknowns as maximally risky.
 */
export function compileToRecordingPolicy(
  _manifest: CapabilityManifest,
  riskContext: RiskContext
): RecordingPolicy {
  // Priority 1: tool flagged by vetting
  if (riskContext.wasVetted) {
    return { mode: "full", reason: "tool flagged by vetting" };
  }

  // Priority 2: consent anomaly
  if (riskContext.hasConsentAnomaly) {
    return { mode: "full", reason: "consent anomaly recorded" };
  }

  // Priority 3: tainted input reaching state-changing call
  if (riskContext.taintChainLength > 0 && riskContext.sideEffectClass !== "read") {
    return { mode: "full", reason: "tainted input reaching state-changing call" };
  }

  // Priority 4: unknown side-effect class (highest severity for unknowns)
  if (riskContext.sideEffectClass === "unknown") {
    return { mode: "full", reason: "unknown side-effect class" };
  }

  // Priority 5: external mutation or network egress
  if (
    riskContext.sideEffectClass === "mutate-external" ||
    riskContext.sideEffectClass === "network-egress"
  ) {
    return { mode: "full", reason: "external mutation" };
  }

  // Priority 6: local mutation, low risk
  if (riskContext.sideEffectClass === "mutate-local") {
    return { mode: "delta", reason: "local mutation, low risk" };
  }

  // Priority 7: read-only, no anomaly
  return { mode: "validation", reason: "read-only, no anomaly" };
}

// ---------------------------------------------------------------------------
// Evidence-based anomaly detection (#266)
//
// Statistical models over a stream of recorded tool calls (AEP evidence):
//   - timing   → running mean/stddev of call duration; flags z-score outliers
//   - payload  → running mean/stddev of argument size; flags z-score outliers
//   - pattern  → sliding-window calls-per-second; flags bursts
// All thresholds are configurable; sensible defaults ship out of the box.
// ---------------------------------------------------------------------------

/**
 * A single tool-call observation feeding the statistical anomaly detector.
 *
 * Observations are derived from recorded AEP evidence — each represents one
 * tool invocation's identity, timing, and payload size. The detector builds a
 * per-tool statistical baseline from the stream and flags observations that
 * deviate beyond configurable thresholds.
 */
export interface ToolCallObservation {
  /** Name of the tool invoked. */
  toolName: string;
  /** Wall-clock latency of the call, in milliseconds. */
  durationMs: number;
  /** Serialized size of the tool-call arguments, in bytes. */
  payloadBytes: number;
  /**
   * Monotonic timestamp of the call, in milliseconds. Defaults to `Date.now()`.
   * Accepting an explicit value keeps detection deterministic in tests.
   */
  timestampMs?: number;
}

/** Dimension of tool-call behaviour an alert can fire on. */
export type AnomalyDimension = "timing" | "payload" | "call-rate";

/**
 * Configurable thresholds for anomaly alerts. Every threshold has a documented
 * default so callers can adopt detection with zero configuration and tighten
 * sensitivity as their baseline matures.
 */
export interface AnomalyThresholds {
  /**
   * Minimum baseline samples a tool must accumulate before z-score alerts
   * (timing, payload) fire. Prevents false positives while the model boots.
   */
  minSamples: number;
  /** Magnitude of the timing z-score above which a timing alert fires. */
  timingZScore: number;
  /** Magnitude of the payload-size z-score above which a payload alert fires. */
  payloadZScore: number;
  /** Hard ceiling on calls-per-second; exceeding it fires a call-rate alert. */
  maxCallsPerSecond: number;
  /** Sliding-window length (ms) over which call-rate is measured. */
  rateWindowMs: number;
}

/**
 * Sensible defaults: a 3σ outlier threshold, a 5-sample warm-up, and a 10/s
 * burst ceiling measured over a 10-second window.
 */
export const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds = {
  minSamples: 5,
  timingZScore: 3,
  payloadZScore: 3,
  maxCallsPerSecond: 10,
  rateWindowMs: 10_000,
};

/** A statistical anomaly alert emitted for a single observation. */
export interface AnomalyAlert {
  /** Which behavioural dimension triggered the alert. */
  dimension: AnomalyDimension;
  /** Tool whose observation crossed a threshold. */
  toolName: string;
  /** Observed value (ms, bytes, or calls/sec depending on dimension). */
  observed: number;
  /** Baseline the observation was compared against (mean or ceiling). */
  baseline: number;
  /**
   * Statistical score: z-score for `timing`/`payload`, observed calls/sec for
   * `call-rate`.
   */
  score: number;
  /** Human-readable explanation. */
  reason: string;
}

/** Snapshot of a tool's accumulated statistical model. */
export interface ToolStats {
  /** Number of observations ingested for this tool. */
  samples: number;
  meanDurationMs: number;
  stddevDurationMs: number;
  meanPayloadBytes: number;
  stddevPayloadBytes: number;
  /** Calls recorded inside the current sliding window. */
  callsInWindow: number;
  /** Current calls-per-second over the sliding window. */
  callsPerSecond: number;
}

/**
 * Online mean/variance accumulator (Welford's algorithm). Numerically stable
 * for streaming evidence — no need to retain raw observations.
 */
class RunningStats {
  n = 0;
  mean = 0;
  private m2 = 0;

  add(x: number): void {
    this.n += 1;
    const delta = x - this.mean;
    this.mean += delta / this.n;
    this.m2 += delta * (x - this.mean);
  }

  /** Sample standard deviation (0 until two observations are recorded). */
  get stddev(): number {
    return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0;
  }
}

/**
 * Evidence-based statistical anomaly detector for tool-call streams (#266).
 *
 * Each observation is scored against the baseline accumulated *before* it, then
 * folded into the baseline — so the model learns normal behaviour from the
 * stream and only alerts once `minSamples` of history exist.
 *
 * @example
 * ```ts
 * const detector = new AnomalyDetector({ timingZScore: 2.5 });
 * for (const obs of stream) {
 *   for (const alert of detector.observe(obs)) {
 *     console.warn(alert.reason);
 *   }
 * }
 * ```
 */
export class AnomalyDetector {
  private readonly thresholds: AnomalyThresholds;
  private readonly timing = new Map<string, RunningStats>();
  private readonly payload = new Map<string, RunningStats>();
  private readonly callTimes = new Map<string, number[]>();

  constructor(thresholds: Partial<AnomalyThresholds> = {}) {
    this.thresholds = { ...DEFAULT_ANOMALY_THRESHOLDS, ...thresholds };
  }

  /** Thresholds the detector is currently applying. */
  get config(): AnomalyThresholds {
    return this.thresholds;
  }

  /**
   * Ingest one tool-call observation and return any alerts it triggered.
   * Alerts are returned (not thrown) so callers can batch, filter, or forward
   * them to monitoring hooks.
   */
  observe(observation: ToolCallObservation): AnomalyAlert[] {
    const alerts: AnomalyAlert[] = [];
    const now = observation.timestampMs ?? Date.now();

    const timing = this.timing.get(observation.toolName) ?? new RunningStats();
    const payload = this.payload.get(observation.toolName) ?? new RunningStats();

    // Score against the prior baseline, then fold the observation in.
    this.scoreZScore({
      dimension: "timing",
      label: "duration",
      unit: "ms",
      toolName: observation.toolName,
      stats: timing,
      value: observation.durationMs,
      zThreshold: this.thresholds.timingZScore,
      alerts,
    });
    this.scoreZScore({
      dimension: "payload",
      label: "payload size",
      unit: "B",
      toolName: observation.toolName,
      stats: payload,
      value: observation.payloadBytes,
      zThreshold: this.thresholds.payloadZScore,
      alerts,
    });

    timing.add(observation.durationMs);
    payload.add(observation.payloadBytes);
    this.timing.set(observation.toolName, timing);
    this.payload.set(observation.toolName, payload);

    // Call-rate (tool-call pattern) over a sliding window.
    const inWindow = this.pruneAndAppend(observation.toolName, now);
    const windowSeconds = this.thresholds.rateWindowMs / 1000;
    const rate = inWindow / windowSeconds;
    if (rate > this.thresholds.maxCallsPerSecond) {
      alerts.push({
        dimension: "call-rate",
        toolName: observation.toolName,
        observed: rate,
        baseline: this.thresholds.maxCallsPerSecond,
        score: rate,
        reason: `call rate ${rate.toFixed(2)}/s exceeds ceiling of ${this.thresholds.maxCallsPerSecond}/s`,
      });
    }

    return alerts;
  }

  /** Current statistical snapshot for a tool, or `undefined` if unseen. */
  statsFor(toolName: string, now: number = Date.now()): ToolStats | undefined {
    const timing = this.timing.get(toolName);
    const payload = this.payload.get(toolName);
    if (!timing || !payload) return undefined;
    const cutoff = now - this.thresholds.rateWindowMs;
    const inWindow = (this.callTimes.get(toolName) ?? []).filter((t) => t >= cutoff).length;
    return {
      samples: timing.n,
      meanDurationMs: timing.mean,
      stddevDurationMs: timing.stddev,
      meanPayloadBytes: payload.mean,
      stddevPayloadBytes: payload.stddev,
      callsInWindow: inWindow,
      callsPerSecond: inWindow / (this.thresholds.rateWindowMs / 1000),
    };
  }

  /** Flag a z-score outlier against a warmed-up, non-degenerate baseline. */
  private scoreZScore(args: {
    dimension: "timing" | "payload";
    label: string;
    unit: string;
    toolName: string;
    stats: RunningStats;
    value: number;
    zThreshold: number;
    alerts: AnomalyAlert[];
  }): void {
    const { dimension, label, unit, toolName, stats, value, zThreshold, alerts } = args;
    // Need a warmed-up baseline with real variance to compute a z-score.
    if (stats.n < this.thresholds.minSamples || stats.stddev === 0) return;
    const z = (value - stats.mean) / stats.stddev;
    if (Math.abs(z) > zThreshold) {
      alerts.push({
        dimension,
        toolName,
        observed: value,
        baseline: stats.mean,
        score: z,
        reason: `${label} ${value}${unit} is ${z.toFixed(2)}σ from baseline ${stats.mean.toFixed(2)}${unit}`,
      });
    }
  }

  /** Drop timestamps outside the window, append the current one, return count. */
  private pruneAndAppend(toolName: string, now: number): number {
    const cutoff = now - this.thresholds.rateWindowMs;
    const kept = (this.callTimes.get(toolName) ?? []).filter((t) => t >= cutoff);
    kept.push(now);
    this.callTimes.set(toolName, kept);
    return kept.length;
  }
}
