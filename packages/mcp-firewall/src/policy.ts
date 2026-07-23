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

/**
 * Persistent storage + lookup for {@link ConsentRecord}s, so that repeated
 * policy decisions on the same tool reuse prior consent instead of re-asking
 * the user on every call. {@link evaluatePolicy} accepts a `ConsentStore`
 * directly in place of the inline `ConsentRecord[]`.
 *
 * A record is considered valid for lookup only when it has not expired and,
 * when a `currentSnapshotHash` is supplied, its snapshot hash matches —
 * preventing rug-pull attacks where the tool descriptor changes after consent.
 */
export interface ConsentStore {
  /** Persist a consent record for later lookup. */
  record(consent: ConsentRecord): void;
  /**
   * Find a valid (non-expired, snapshot-matching) consent record for a tool.
   * Returns undefined when none is on file.
   *
   * @param userIdHash         When provided, only records for this user match.
   * @param currentSnapshotHash  When provided, only records whose snapshot hash
   *   matches are returned.
   */
  lookup(
    toolName: string,
    userIdHash?: string,
    currentSnapshotHash?: string
  ): ConsentRecord | undefined;
  /** All records recorded for a tool, including expired ones (useful for audit). */
  recordsFor(toolName: string): ConsentRecord[];
  /** Revoke (expire immediately) all non-expiring consent for a tool + user. */
  revoke(toolName: string, userIdHash?: string): void;
  /** Snapshot copy of every recorded consent record. */
  all(): ConsentRecord[];
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
 * @param consent   Either an inline array of consent records for this session,
 *   or a persistent {@link ConsentStore}. A store lets consent recorded for one
 *   call be reused on repeated policy decisions for the same tool without
 *   re-asking the user.
 * @param rules     Policy rules to apply (defaults to DEFAULT_RULES).
 * @param currentSnapshotHash  Current tool descriptor hash — consent is only
 *   valid when it matches, preventing rug-pull after consent was granted.
 */
export function evaluatePolicy(
  toolName: string,
  args: Record<string, unknown>,
  vetting: VettingResult | null,
  consent: ConsentRecord[] | ConsentStore,
  rules: PolicyRule[] = DEFAULT_RULES,
  currentSnapshotHash?: string
): ToolInvocationDecision {
  // Normalize to an array. When a store is passed we read its current contents;
  // the lookup below filters to the relevant, still-valid record.
  const consentRecords = Array.isArray(consent) ? consent : consent.all();

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
  const validConsent = lookupConsent(consentRecords, toolName, currentSnapshotHash);
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

// ── Consent storage + lookup ─────────────────────────────────────────────────

/**
 * Find a valid (non-expired, snapshot-matching) consent record for a tool
 * within the given records. Shared by {@link evaluatePolicy} and
 * {@link ConsentStore.lookup} so "what counts as valid consent" has a single
 * definition.
 *
 * @param consent             Records to search (typically already session-scoped).
 * @param toolName            Tool the policy decision is for.
 * @param currentSnapshotHash  When provided, only records whose snapshot hash
 *   matches are returned (rug-pull guard).
 * @param userIdHash          When provided, only records for this user match.
 *   Omit to match any user (e.g. when the caller has already scoped the array).
 */
export function lookupConsent(
  consent: ConsentRecord[],
  toolName: string,
  currentSnapshotHash?: string,
  userIdHash?: string
): ConsentRecord | undefined {
  const now = new Date();
  return consent.find(
    (c) =>
      c.toolName === toolName &&
      (userIdHash === undefined || c.userIdHash === userIdHash) &&
      (!c.expiresAt || new Date(c.expiresAt) > now) &&
      (!currentSnapshotHash || c.toolSnapshotHash === currentSnapshotHash)
  );
}

/**
 * In-memory {@link ConsentStore}. Consent recorded here persists across repeated
 * `evaluatePolicy` calls for the lifetime of the instance, so a user only has to
 * approve a high-risk tool once even when the policy engine evaluates it many
 * times. Pass the same instance as `evaluatePolicy`'s `consent` argument, or
 * call {@link InMemoryConsentStore.lookup} directly.
 *
 * For production use, back this with KV or a database by implementing
 * {@link ConsentStore} directly.
 */
export class InMemoryConsentStore implements ConsentStore {
  private readonly _records: ConsentRecord[] = [];

  record(consent: ConsentRecord): void {
    this._records.push(consent);
  }

  lookup(
    toolName: string,
    userIdHash?: string,
    currentSnapshotHash?: string
  ): ConsentRecord | undefined {
    return lookupConsent(this._records, toolName, currentSnapshotHash, userIdHash);
  }

  recordsFor(toolName: string): ConsentRecord[] {
    return this._records.filter((c) => c.toolName === toolName);
  }

  revoke(toolName: string, userIdHash?: string): void {
    const now = new Date().toISOString();
    for (const c of this._records) {
      if (
        c.toolName === toolName &&
        (userIdHash === undefined || c.userIdHash === userIdHash) &&
        !c.expiresAt
      ) {
        c.expiresAt = now; // expire immediately
      }
    }
  }

  all(): ConsentRecord[] {
    return [...this._records];
  }
}
