/**
 * Per-call policy decision — deterministic allow / deny / ask / dry_run
 * evaluation before each MCP tool invocation.
 *
 * Evaluates capability requirements, consent records, and tool risk findings
 * to produce a binding `ToolInvocationDecision`.
 */

import type { VettingResult } from "./vetting.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type InvocationDecision = "allow" | "deny" | "ask_user" | "dry_run";

export interface ToolInvocationDecision {
  decision: InvocationDecision;
  reasons: string[];
  requiredCapabilities: string[];
  matchedPolicyIds: string[];
  userConsentRef?: string;
}

export interface PolicyRule {
  policyId: string;
  /** Return a decision only when the rule applies; undefined = rule skipped. */
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
    vetting: VettingResult | null
  ): InvocationDecision | undefined;
}

export interface ConsentRecord {
  userIdHash: string;
  toolName: string;
  /** ISO-8601 string or undefined for no expiry. */
  expiresAt?: string;
  /** The snapshot hash the consent was given for. */
  toolSnapshotHash: string;
}

// ── Built-in rules ───────────────────────────────────────────────────────────

/**
 * Deny any tool flagged as blocked by static vetting.
 */
export const DENY_BLOCKED_RULE: PolicyRule = {
  policyId: "deny-blocked-vetting",
  evaluate(_name, _args, vetting) {
    if (vetting?.blocked) return "deny";
    return undefined;
  },
};

/**
 * Ask the user before calling any tool with high/critical findings.
 */
export const ASK_HIGH_RISK_RULE: PolicyRule = {
  policyId: "ask-high-risk",
  evaluate(_name, _args, vetting) {
    if (!vetting) return undefined;
    const worst = vetting.findings.reduce<string | null>((w, f) => {
      if (f.severity === "critical" || f.severity === "high") return f.severity;
      return w;
    }, null);
    if (worst) return "ask_user";
    return undefined;
  },
};

export const DEFAULT_RULES: PolicyRule[] = [DENY_BLOCKED_RULE, ASK_HIGH_RISK_RULE];

// ── Policy engine ────────────────────────────────────────────────────────────

const DECISION_ORDER: Record<InvocationDecision, number> = {
  allow: 0,
  dry_run: 1,
  ask_user: 2,
  deny: 3,
};

function worstDecision(decisions: InvocationDecision[]): InvocationDecision {
  if (decisions.length === 0) return "allow";
  return decisions.reduce((w, d) => (DECISION_ORDER[d] > DECISION_ORDER[w] ? d : w));
}

/**
 * Evaluate policy rules for a tool invocation.
 *
 * @param toolName  Name of the tool being called.
 * @param args      Arguments the agent is passing.
 * @param vetting   Result of static vetting (null if not yet vetted).
 * @param consent   Active consent records for this session.
 * @param rules     Policy rules to apply (defaults to DEFAULT_RULES).
 * @param currentSnapshotHash  Current tool descriptor hash — consent is only
 *   valid when it matches, preventing rug-pull after consent was granted.
 */
export function evaluatePolicy(
  toolName: string,
  args: Record<string, unknown>,
  vetting: VettingResult | null,
  consent: ConsentRecord[],
  rules: PolicyRule[] = DEFAULT_RULES,
  currentSnapshotHash?: string
): ToolInvocationDecision {
  const decisions: InvocationDecision[] = [];
  const matchedPolicyIds: string[] = [];
  const reasons: string[] = [];

  for (const rule of rules) {
    const d = rule.evaluate(toolName, args, vetting);
    if (d !== undefined) {
      decisions.push(d);
      matchedPolicyIds.push(rule.policyId);
      if (d === "deny") reasons.push(`Denied by policy: ${rule.policyId}`);
      if (d === "ask_user") reasons.push(`User confirmation required: ${rule.policyId}`);
    }
  }

  // Check consent records — if valid consent exists, downgrade ask_user → allow.
  // Consent is only honoured when the tool's snapshot hash matches, preventing
  // rug-pull attacks where the MCP server changes tool behavior post-consent.
  const validConsent = consent.find(
    (c) =>
      c.toolName === toolName &&
      (!c.expiresAt || new Date(c.expiresAt) > new Date()) &&
      (!currentSnapshotHash || c.toolSnapshotHash === currentSnapshotHash)
  );
  if (validConsent) {
    const idx = decisions.indexOf("ask_user");
    if (idx !== -1) decisions.splice(idx, 1);
    reasons.push(`User consent on file: ${validConsent.toolSnapshotHash}`);
  }

  const decision = worstDecision(decisions.length > 0 ? decisions : ["allow"]);

  // Required capabilities from vetting findings
  const requiredCapabilities =
    vetting?.findings.filter((f) => f.category === "exfiltration").map((f) => `read:${f.field}`) ??
    [];

  return {
    decision,
    reasons,
    requiredCapabilities,
    matchedPolicyIds,
    ...(validConsent ? { userConsentRef: validConsent.toolSnapshotHash } : {}),
  };
}
