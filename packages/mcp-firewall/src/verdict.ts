/**
 * Layered verdict model — aggregates the outputs of every firewall layer into
 * a single `FirewallSecurityVerdict` that captures the multi-layer decision.
 *
 * The "defense-in-depth success" scenario — detection=missed, policy=deny,
 * containment=contained — proves that a semantic bypass does NOT imply an
 * unsafe effect; policy or taint layers caught what detection missed.
 */

import type { TaintedObservation } from "./taint.js";
import type { ToolInvocationDecision } from "./policy.js";
import type { VettingResult } from "./vetting.js";

// ── Verdict types ─────────────────────────────────────────────────────────────

/** Signal from the semantic/keyword detection layer. */
export type DetectionVerdict = "blocked" | "warned" | "missed" | "not_applicable";

/** Decision from the policy engine. */
export type PolicyVerdict = "allow" | "deny" | "ask_user";

/** Whether any unsafe effect was contained despite a detector miss. */
export type ContainmentVerdict = "contained" | "escaped" | "not_executed";

/** Consent ledger state for this invocation. */
export type ConsentVerdict = "valid" | "invalid" | "not_required";

/** Whether the tool output (if any) is tainted. */
export type TaintVerdict = "clean" | "tainted";

export interface FirewallSecurityVerdict {
  /** Signal from semantic/keyword detection layer. */
  detection: DetectionVerdict;
  /** Decision from the policy engine. */
  policy: PolicyVerdict;
  /** Whether any unsafe effect was contained despite a detector miss. */
  containment: ContainmentVerdict;
  /** Consent ledger state for this invocation. */
  consent: ConsentVerdict;
  /** Whether the tool output (if any) is tainted. */
  taint: TaintVerdict;
  /** Final binding decision (worst-case composition of above). */
  final: PolicyVerdict;
}

// ── Verdict composition ───────────────────────────────────────────────────────

/**
 * Compose a FirewallSecurityVerdict from the outputs of each firewall layer.
 *
 * @param vetting     Result of static vetting (null if skipped).
 * @param decision    Output of evaluatePolicy().
 * @param taint       TaintedObservation for the tool result (undefined if pre-call).
 * @param hasConsent  Whether valid consent exists for this call.
 */
export function composeVerdict(opts: {
  vetting: VettingResult | null;
  decision: ToolInvocationDecision;
  taint?: TaintedObservation;
  hasConsent: boolean;
}): FirewallSecurityVerdict {
  // ── detection ─────────────────────────────────────────────────────────────
  let detection: DetectionVerdict;
  if (opts.vetting === null) {
    detection = "not_applicable";
  } else if (
    opts.vetting.blocked === true ||
    opts.vetting.findings.some((f) => f.severity === "critical" || f.severity === "high")
  ) {
    detection = "blocked";
  } else if (opts.vetting.findings.some((f) => f.severity === "medium")) {
    detection = "warned";
  } else {
    // vetting ran but found nothing — the interesting adversarial case
    detection = "missed";
  }

  // ── policy ────────────────────────────────────────────────────────────────
  // dry_run is treated as allow for verdict purposes; it has the same effect
  // on whether the action executes.
  let policy: PolicyVerdict;
  const rawDecision = opts.decision.decision;
  if (rawDecision === "deny") {
    policy = "deny";
  } else if (rawDecision === "ask_user") {
    policy = "ask_user";
  } else {
    policy = "allow";
  }

  // ── taint ─────────────────────────────────────────────────────────────────
  const taintVerdict: TaintVerdict =
    opts.taint?.instructionLikeTextDetected === true ||
    (opts.taint?.adversarialScore ?? 0) > 0.5
      ? "tainted"
      : "clean";

  // ── containment ───────────────────────────────────────────────────────────
  // Only meaningful when detection missed; otherwise the first or second layer
  // caught the problem and execution never reached containment.
  let containment: ContainmentVerdict;
  if (detection === "missed") {
    if (policy === "deny") {
      // semantic bypass attempted but policy layer caught it
      containment = "contained";
    } else if (taintVerdict === "tainted" && policy !== "allow") {
      // taint boundary held; policy did not allow the action outright
      containment = "contained";
    } else if (policy === "allow" && taintVerdict !== "tainted") {
      // nothing stopped it — this is the worst-case gap
      containment = "escaped";
    } else {
      // detection missed, but action blocked pending user confirmation (ask_user + clean taint)
      containment = "not_executed";
    }
  } else {
    containment = "not_executed";
  }

  // ── consent ───────────────────────────────────────────────────────────────
  let consent: ConsentVerdict;
  if (opts.hasConsent === true) {
    consent = "valid";
  } else if (policy === "allow" && detection !== "blocked") {
    consent = "not_required";
  } else {
    consent = "invalid";
  }

  // ── final ─────────────────────────────────────────────────────────────────
  // The policy verdict IS the final binding decision; other layers inform it
  // but do not override it in this model.
  return { detection, policy, containment, consent, taint: taintVerdict, final: policy };
}
