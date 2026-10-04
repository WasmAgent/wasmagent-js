/**
 * Provenance-preserving information-flow gate (IF-07a).
 *
 * Denies a tool invocation when EXPLICIT taint provenance from earlier tool
 * results — threaded through `GatewayRequest.inputProvenance`, either by the
 * caller or per run by a wired agent runtime (`RunPolicyGateway`, IF-07c) —
 * reaches a dangerous sink. The deny keys on propagated LABELS and value
 * IDENTITY, never on the value's shape, so encodings that defeat shape
 * detection (base64, rename, restructure) no longer bypass the gate.
 *
 * Two independent deny conditions, both requiring explicit threading:
 *
 * 1. LABEL THREADING (`sink-tainted-provenance-deny`) — a threaded
 *    observation carries a sensitive label. Threading a provenance set into
 *    a call is the caller's declaration that this call consumes data derived
 *    from those observations; a sensitive label headed for a dangerous sink
 *    is denied.
 *
 * 2. IDENTITY MATCH (`sink-tainted-identity-deny`) — a string argument value
 *    hashes to the `contentHash` of a sensitive-labeled threaded observation.
 *    `propagateTaint` hashes the DERIVED content, so the encoded form
 *    (e.g. base64) matches wherever the caller placed it — any argument
 *    name, any nesting depth.
 *
 * Design boundary (honest claim ceiling): provenance enters the decision ONLY
 * when it is threaded — by the caller, or per run by a wired agent runtime.
 * Threading is run-scoped; there is NO automatic process-wide taint ledger
 * (the FI-TAINT-PROPAGATION posture is unchanged), and a transform nobody
 * runs through `propagateTaint` (or a labeled result nobody observes) is
 * outside this gate. Operator profiles (`sensitiveArgPaths`, IF-07b) remain
 * the independent structural fallback.
 *
 * Deny decisions are never downgraded by consent (evaluatePolicy contract).
 * A legitimate flow that must act on tainted data does so through the
 * operator-profile / capability path, which records the deliberate approval.
 */

import { createHash } from "node:crypto";
import type { InvocationDecision, PolicyRule } from "./policy.js";
import { deepStringValues } from "./resource-path.js";
import type { DataSink } from "./sink-policy.js";
import type { TaintedObservation, TaintLabel } from "./taint.js";
import type { VettingResult } from "./vetting.js";

// ── Deny matrix ───────────────────────────────────────────────────────────────

/**
 * Labels whose flow into a dangerous sink is denied. Deliberately narrow:
 * `tool_supplied` / `external_network` reaching a network sink is the normal
 * agent use case, so only data explicitly marked as secret material gates.
 */
export const PROVENANCE_SENSITIVE_LABELS: readonly TaintLabel[] = ["secret", "credential"] as const;

/**
 * Sinks that sensitive provenance must never reach autonomously.
 * An unclassifiable sink ("unknown") does NOT match — fail-open for sink
 * classification only; unprofiled/unknown-effect tools remain guarded by the
 * unprofiled-tool and capability rules.
 */
export const PROVENANCE_DENY_SINKS: readonly DataSink[] = [
  "network_send",
  "credential_use",
  "shell_exec",
  "filesystem_write",
] as const;

export const TAINT_PROVENANCE_LABEL_RULE_ID = "sink-tainted-provenance-deny";
export const TAINT_PROVENANCE_IDENTITY_RULE_ID = "sink-tainted-identity-deny";

function hasSensitiveLabels(obs: TaintedObservation): boolean {
  return obs.taintLabels.some((l) =>
    (PROVENANCE_SENSITIVE_LABELS as readonly string[]).includes(l)
  );
}

function sinkDenied(sinks: readonly DataSink[]): boolean {
  return sinks.some((s) => (PROVENANCE_DENY_SINKS as readonly string[]).includes(s));
}

/** Same hash discipline as `taintObservation`: first 64 hex of SHA-256, utf8. */
function contentHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 64);
}

// ── Rule factory ──────────────────────────────────────────────────────────────

export interface TaintProvenanceRuleOptions {
  /** Observations threaded by the caller via `GatewayRequest.inputProvenance`. */
  provenance: readonly TaintedObservation[];
  /** Sinks of the target tool (profile-declared when authoritative, else heuristic). */
  sinks: readonly DataSink[];
}

/**
 * Build the IF-07a provenance gate rules for one invocation.
 *
 * Returns TWO rules so `matchedPolicyIds` records exactly which condition
 * fired: label threading (`sink-tainted-provenance-deny`) and/or value
 * identity (`sink-tainted-identity-deny`). Append both to the per-request
 * rule stack whenever `GatewayRequest.inputProvenance` is present; append
 * neither when it is absent (no provenance, no gate — the honest boundary).
 */
export function makeTaintProvenanceRules(opts: TaintProvenanceRuleOptions): PolicyRule[] {
  const sensitive = opts.provenance.filter(hasSensitiveLabels);
  const dangerousSink = sinkDenied(opts.sinks);

  // Precomputed once per invocation: identity matching is O(1) hash-set
  // lookups at evaluate time (args are walked once per rule).
  const sensitiveHashes = new Set(sensitive.map((o) => o.contentHash));

  const labelRule: PolicyRule = {
    policyId: TAINT_PROVENANCE_LABEL_RULE_ID,
    evaluate(
      _toolName: string,
      _args: Record<string, unknown>,
      _vetting: VettingResult | null
    ): InvocationDecision | undefined {
      if (!dangerousSink || sensitive.length === 0) return undefined;
      return "deny";
    },
  };

  const identityRule: PolicyRule = {
    policyId: TAINT_PROVENANCE_IDENTITY_RULE_ID,
    evaluate(
      _toolName: string,
      args: Record<string, unknown>,
      _vetting: VettingResult | null
    ): InvocationDecision | undefined {
      if (!dangerousSink || sensitiveHashes.size === 0) return undefined;
      for (const v of deepStringValues(args)) {
        if (sensitiveHashes.has(contentHash(v))) return "deny";
      }
      return undefined;
    },
  };

  return [labelRule, identityRule];
}

/**
 * Union of taint labels across the threaded provenance set — the value that
 * lands in `GatewayDecision.evidenceRef.inputTaintLabels` and, downstream,
 * in AEP `input_taint_labels` (the producer the record schema has been
 * missing). Empty when no provenance is threaded.
 */
export function collectInputTaintLabels(
  provenance: readonly TaintedObservation[] | undefined
): TaintLabel[] {
  if (!provenance) return [];
  return [...new Set(provenance.flatMap((o) => o.taintLabels))];
}
