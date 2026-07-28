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

import type { CapabilityManifest, PosturePolicy, PostureRecordingMode } from "@wasmagent/core";

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

/**
 * Severity rank of a recording mode (validation < delta < full). Mirrors the
 * rank used by {@link inheritPosture} in `@wasmagent/core` so the two agree on
 * "stricter mode" — kept local so this package has no new runtime dependency
 * beyond the type import.
 */
function recordingRankFor(mode: PostureRecordingMode): number {
  switch (mode) {
    case "validation":
      return 0;
    case "delta":
      return 1;
    case "full":
      return 2;
  }
}

// A no-capability manifest for the default path of {@link recordingPolicyForPosture}.
const EMPTY_MANIFEST: CapabilityManifest = {
  allowedHosts: [],
  allowedReadPaths: [],
  allowedWritePaths: [],
  extraCapabilities: [],
};

/**
 * Resolve the recording policy for a tool call under an inherited
 * {@link PosturePolicy} (Milestone 6 — cross-agent policy inheritance).
 *
 * The posture's `recordingMode` is a **floor**: a sub-agent whose effective
 * posture elevated recording (because its parent required it, or it narrowed
 * into a higher-severity context) records at that level even when the per-call
 * {@link RiskContext} would normally allow less. The risk-derived mode can only
 * raise recording further, never lower it below the inherited floor.
 *
 * @param posture     - The effective (post-narrowing) posture the caller runs under.
 * @param riskContext - Per-call runtime risk signals.
 * @param manifest    - Optional manifest (forwarded for future manifest-scoped overrides).
 * @returns The recording policy to apply, honouring the posture floor.
 */
export function recordingPolicyForPosture(
  posture: PosturePolicy,
  riskContext: RiskContext,
  manifest?: CapabilityManifest
): RecordingPolicy {
  const riskDerived = compileToRecordingPolicy(manifest ?? EMPTY_MANIFEST, riskContext);
  if (recordingRankFor(posture.recordingMode) > recordingRankFor(riskDerived.mode)) {
    return {
      mode: posture.recordingMode,
      reason: `posture recording floor "${posture.recordingMode}" overrides risk-derived "${riskDerived.mode}"`,
    };
  }
  return riskDerived;
}
