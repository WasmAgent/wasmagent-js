/**
 * MCP Gateway layer — identity propagation, server card, state-changing action approval.
 *
 * Extends the existing firewall (vetting + policy + consent + taint) with:
 *   1. RequestIdentity — who is making the call (principal + session)
 *   2. ServerCard — cached metadata about a trusted MCP server
 *   3. isStateChangingTool() — heuristic for tools that mutate external state
 *   4. GatewayContext — per-request context bundle
 *   5. MCPGateway — stateful gateway that wraps a set of firewall primitives
 */

import { createHash, randomUUID } from "node:crypto";
import type { McpToolEntry } from "@wasmagent/mcp-server";
import type { CapabilityRegistry, EffectClass } from "./capability.js";
import { makeCapabilityPolicyRule, makeTenantIsolationRule } from "./capability.js";
import type { ConsentRecord, PolicyRule, ToolInvocationDecision } from "./policy.js";
import { DEFAULT_RULES, evaluatePolicy } from "./policy.js";
import {
  computeToolSnapshotHash,
  evaluateUnprofiledToolPolicy,
  type HardenedRuleStackOptions,
  makeHardenedRuleStack,
  type ResolvedToolSecurityContext,
  resolveToolSecurityContext,
  type ToolSecurityProfile,
  type ToolSecurityProfileRegistry,
  type UnprofiledToolPolicy,
} from "./security-profile.js";
import type { TaintedObservation } from "./taint.js";
import { taintObservation } from "./taint.js";
import type { FirewallSecurityVerdict } from "./verdict.js";
import { composeVerdict } from "./verdict.js";
import type { VettingResult } from "./vetting.js";
import { buildVettingCacheKey, vetTool } from "./vetting.js";

// ── Identity ─────────────────────────────────────────────────────────────────

export interface RequestIdentity {
  /** Stable hash of the principal (e.g. user id, agent id). */
  principalHash: string;
  /** Session identifier — ties all requests in one run together. */
  sessionId: string;
  /** Optional: propagated from upstream caller (for multi-agent chains). */
  parentSessionId?: string;
  /** ISO-8601 timestamp when this identity was established. */
  issuedAt: string;
}

export function createRequestIdentity(opts: {
  principal: string;
  sessionId: string;
  parentSessionId?: string;
}): RequestIdentity {
  return {
    principalHash: createHash("sha256").update(opts.principal).digest("hex").slice(0, 16),
    sessionId: opts.sessionId,
    ...(opts.parentSessionId !== undefined ? { parentSessionId: opts.parentSessionId } : {}),
    issuedAt: new Date().toISOString(),
  };
}

// ── Server Card ───────────────────────────────────────────────────────────────

export interface ServerCard {
  serverId: string;
  displayName?: string;
  /** SHA-256 of the full tool manifest JSON at registration time. */
  toolManifestDigest: string;
  /** ISO-8601 when this server was registered. */
  registeredAt: string;
  /** Human-readable capabilities list (informational, not enforced). */
  declaredCapabilities?: string[];
  /** True if the server has been reviewed and marked trusted by an operator. */
  operatorVerified: boolean;
}

export function buildServerCard(opts: {
  serverId: string;
  displayName?: string;
  tools: McpToolEntry[];
  declaredCapabilities?: string[];
  operatorVerified?: boolean;
}): ServerCard {
  const manifest = JSON.stringify(opts.tools.map((t) => ({ name: t.name, schema: t.inputSchema })));
  return {
    serverId: opts.serverId,
    ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
    toolManifestDigest: createHash("sha256").update(manifest).digest("hex"),
    registeredAt: new Date().toISOString(),
    ...(opts.declaredCapabilities !== undefined
      ? { declaredCapabilities: opts.declaredCapabilities }
      : {}),
    operatorVerified: opts.operatorVerified ?? false,
  };
}

// ── Scope Lease ───────────────────────────────────────────────────────────────

/**
 * ScopeLease — a time-bounded permission grant for state-changing tools.
 * Prevents indefinite privilege accumulation.
 */
export interface ScopeLease {
  leaseId: string;
  principalHash: string;
  serverId: string;
  /** List of tool names covered by this lease. */
  grantedTools: string[];
  /** ISO-8601 expiry time. */
  expiresAt: string;
  /** Whether this lease covers state-changing tools. */
  stateChanging: boolean;
  /** Optional: max number of invocations allowed. */
  maxInvocations?: number;
  /** Current invocation count. */
  invocationCount: number;
}

export function createScopeLease(opts: {
  principalHash: string;
  serverId: string;
  grantedTools: string[];
  ttlSeconds?: number;
  stateChanging?: boolean;
  maxInvocations?: number;
}): ScopeLease {
  const ttl = opts.ttlSeconds ?? 300;
  const expiry = new Date(Date.now() + ttl * 1000).toISOString();
  return {
    // RandomUUID salt: without it two leases for the same principal+server
    // created in the same millisecond collide, making receipts that
    // reference leaseId ambiguous.
    leaseId: createHash("sha256")
      .update(opts.principalHash + opts.serverId + expiry + randomUUID())
      .digest("hex")
      .slice(0, 16),
    principalHash: opts.principalHash,
    serverId: opts.serverId,
    grantedTools: opts.grantedTools,
    expiresAt: expiry,
    stateChanging: opts.stateChanging ?? false,
    ...(opts.maxInvocations !== undefined ? { maxInvocations: opts.maxInvocations } : {}),
    invocationCount: 0,
  };
}

export function isScopeLeaseValid(lease: ScopeLease): boolean {
  if (new Date(lease.expiresAt) <= new Date()) return false;
  if (lease.maxInvocations !== undefined && lease.invocationCount >= lease.maxInvocations)
    return false;
  return true;
}

// ── Approval Receipt ──────────────────────────────────────────────────────────

/**
 * ApprovalReceipt — immutable record of a user approving a state-changing action.
 */
export interface ApprovalReceipt {
  receiptId: string;
  leaseId?: string;
  principalHash: string;
  toolName: string;
  /** SHA-256 of the approval UI text shown to user. */
  uiTextHash: string;
  /** SHA-256 of the tool descriptor at approval time. */
  toolDescriptorHash: string;
  /** SHA-256 digest of the tool call arguments. */
  argsDigest: string;
  approvedAt: string;
  expiresAt: string;
}

/**
 * Deterministic JSON serialisation (sorted object keys) for digest inputs.
 * `JSON.stringify` is key-insertion-order dependent, so the same logical
 * args re-serialised with a different key order produced different
 * argsDigests and legitimately-approved calls failed receipt matching.
 * BigInt is stringified (JSON.stringify would throw).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (typeof value === "undefined") return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  // Functions / symbols have no JSON representation.
  return "null";
}

export function createApprovalReceipt(opts: {
  leaseId?: string;
  principalHash: string;
  toolName: string;
  uiText: string;
  toolDescriptor: string;
  args: unknown;
  ttlSeconds?: number;
}): ApprovalReceipt {
  const ttl = opts.ttlSeconds ?? 60;
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + ttl * 1000).toISOString();
  return {
    receiptId: createHash("sha256")
      .update(opts.principalHash + opts.toolName + now)
      .digest("hex")
      .slice(0, 16),
    ...(opts.leaseId !== undefined ? { leaseId: opts.leaseId } : {}),
    principalHash: opts.principalHash,
    toolName: opts.toolName,
    uiTextHash: createHash("sha256").update(opts.uiText).digest("hex").slice(0, 16),
    toolDescriptorHash: createHash("sha256").update(opts.toolDescriptor).digest("hex").slice(0, 16),
    argsDigest: createHash("sha256").update(stableStringify(opts.args)).digest("hex").slice(0, 16),
    approvedAt: now,
    expiresAt: expiry,
  };
}

// ── State-changing heuristic ──────────────────────────────────────────────────

const STATE_CHANGING_PATTERNS = [
  /\bwrite\b/,
  /\bcreate\b/,
  /\bdelete\b/,
  /\bremove\b/,
  /\bmodify\b/,
  /\bupdate\b/,
  /\bcommit\b/,
  /\bpush\b/,
  /\bpublish\b/,
  /\bdeploy\b/,
  /\bexecute\b/,
  /\brun\b/,
  /\bpost\b/,
  /\bsend\b/,
  /\bsubmit\b/,
  // Found missing in review: common mutating verbs that previously classified
  // as read-only (e.g. `upload_file`, `drop_table`, `rename_column`).
  /\bupload\b/,
  /\binstall\b/,
  /\bimport\b/,
  /\bdrop\b/,
  /\binsert\b/,
  /\btruncate\b/,
  /\brename\b/,
  /\bmove\b/,
  /\bmkdir\b/,
  /\bpatch\b/,
  /\bmerge\b/,
  /\bkill\b/,
  /\bformat\b/,
  /\bapply\b/,
];

/** Heuristic: returns true if the tool's name or description suggests it mutates state. */
export function isStateChangingTool(tool: McpToolEntry): boolean {
  const text = (tool.name + " " + tool.description).toLowerCase();
  return STATE_CHANGING_PATTERNS.some((p) => p.test(text));
}

/** Max vetting results cached (LRU) — cache keys are descriptor hashes. */
const VETTING_CACHE_CAP = 500;

// ── Gateway Context ───────────────────────────────────────────────────────────

export interface GatewayRequest {
  identity: RequestIdentity;
  serverId: string;
  tool: McpToolEntry;
  args: Record<string, unknown>;
  /**
   * Authoritative tenant identifier. Under tenant enforcement this is
   * REQUIRED — the gateway never infers tenant identity from serverId,
   * tool names, or resource strings (P0-04: a server is not a tenant).
   */
  tenant?: string;
}

export interface GatewayDecision {
  invocation: ToolInvocationDecision;
  stateChanging: boolean;
  serverCard?: ServerCard;
  resultTrustLevel: "untrusted" | "verified" | "system";
  /**
   * Effect class for the tool invocation, from the layered classifier:
   * registered security profile → structural value signals → name
   * heuristics → unknown_effect (fail-safe).
   */
  capabilityEffect: EffectClass;
  /** AEP evidence fields for this decision. */
  evidenceRef: {
    principalHash: string;
    sessionId: string;
    toolManifestDigest?: string;
    policyDecision: string;
    /** Effective gateway security profile (final-audit C5 — a custom rule
     * stack reports "custom", never "hardened"). */
    securityProfile: GatewaySecurityProfile;
  };
  /** Multi-layer security verdict for this invocation. */
  verdict?: FirewallSecurityVerdict;
}

// ── MCPGateway ────────────────────────────────────────────────────────────────

/**
 * Gateway security profile:
 * - "hardened" (default) — full structural rule stack (FULL_DEFAULT_RULES +
 *   security-profile rules), unknown tools fail safe, tenant enforcement
 *   available via `tenantEnforcement`.
 * - "legacy" — the pre-hardening DEFAULT_RULES stack. Opt in only for
 *   backward compatibility; not eligible for F2 containment claims.
 * - "custom" — the caller supplied an explicit `rules` stack, which by
 *   definition replaces the hardened default. Never report "hardened" for a
 *   custom stack (final-audit C5): `securityProfile` returns the EFFECTIVE
 *   profile; `requestedSecurityProfile` returns what was requested.
 */
export type GatewaySecurityProfile = "legacy" | "hardened" | "custom";

export interface MCPGatewayOptions {
  /**
   * Explicit policy rules. When set, takes full responsibility for the
   * rule stack — custom rules do NOT imply F2 structural protection
   * (documented caller responsibility; effective profile reports "custom").
   */
  rules?: PolicyRule[];
  /** Security profile. Default "hardened" (Beta package: secure by default). */
  securityProfile?: GatewaySecurityProfile;
  /** Server cards registered at startup. */
  serverCards?: ServerCard[];
  /** Optional capability registry for explicit grants. */
  capabilityRegistry?: CapabilityRegistry;
  /**
   * Registry of operator-reviewed ToolSecurityProfiles. Recommended in
   * hardened mode — profiles make classification authoritative instead of
   * name-heuristic (P0-03).
   */
  profileRegistry?: ToolSecurityProfileRegistry;
  /** Passed through to the hardened rule stack. */
  hardenedRuleOptions?: Omit<HardenedRuleStackOptions, "profileRegistry">;
  /**
   * Tenant isolation enforcement (P0-04). When true, every request MUST
   * carry an explicit authoritative `tenant`; requests without one are
   * denied (fail-closed), and cross-tenant resource references are denied
   * via the tenant isolation rule. Default false.
   */
  tenantEnforcement?: boolean;
  /**
   * Policy for tools with NO trusted ToolSecurityProfile on UNVERIFIED
   * servers (final-audit C3). The threat model includes malicious servers
   * that choose benign read-like tool names, so the hardened default is
   * "ask_user"; "deny" is strict mode; "allow_read_heuristic" restores
   * name-heuristic trust (legacy compatibility). Operator-VERIFIED servers
   * keep the read heuristic regardless — verification is the trust anchor.
   * Default: "ask_user" (hardened) / "allow_read_heuristic" (legacy).
   */
  unprofiledToolPolicy?: UnprofiledToolPolicy;
}

/**
 * MCPGateway — stateful gateway that combines all firewall layers with
 * identity propagation, server card validation, and state-changing action approval.
 *
 * Usage:
 *   const gw = new MCPGateway({ serverCards: [card] });
 *   const decision = gw.evaluate({ identity, serverId, tool, args });
 *   if (decision.invocation.decision !== "allow") throw new Error("blocked");
 *   const result = await callTool(tool, args);
 *   const obs = gw.wrapResult(tool.name, result, decision);
 */
export class MCPGateway {
  readonly #rules: PolicyRule[];
  readonly #requestedSecurityProfile: GatewaySecurityProfile;
  readonly #effectiveSecurityProfile: GatewaySecurityProfile;
  readonly #serverCards: Map<string, ServerCard>;
  /** LRU-capped: keys are full descriptor hashes, so a hostile server rotating
   * its tool description on every tools/list mints a fresh key per cycle. */
  readonly #vettingCache: Map<string, VettingResult>;
  readonly #consentRecords: ConsentRecord[];
  readonly #capabilityRegistry: CapabilityRegistry | undefined;
  readonly #profileRegistry: ToolSecurityProfileRegistry | undefined;
  readonly #tenantEnforcement: boolean;
  readonly #unprofiledToolPolicy: UnprofiledToolPolicy;
  /** Snapshot hash of the request currently being evaluated — read by the
   * profile rule closure during rule evaluation (single-threaded, per-call). */
  #currentSnapshotHash: string | undefined;
  readonly #getSnapshotHash = (): string | undefined => this.#currentSnapshotHash;

  constructor(opts: MCPGatewayOptions = {}) {
    this.#requestedSecurityProfile = opts.securityProfile ?? "hardened";
    // C5: a caller-supplied rule stack REPLACES the hardened default, so the
    // effective profile is "custom" — never report "hardened" for a custom
    // stack.
    this.#effectiveSecurityProfile =
      opts.rules !== undefined && this.#requestedSecurityProfile !== "legacy"
        ? "custom"
        : this.#requestedSecurityProfile;
    if (opts.rules !== undefined) {
      // Explicit caller-supplied stack — full caller responsibility.
      this.#rules = opts.rules;
    } else if (this.#effectiveSecurityProfile === "hardened") {
      const stackOpts: HardenedRuleStackOptions = {
        ...(opts.profileRegistry !== undefined ? { profileRegistry: opts.profileRegistry } : {}),
        ...(opts.hardenedRuleOptions ?? {}),
        getSnapshotHash: this.#getSnapshotHash,
      };
      this.#rules = makeHardenedRuleStack(stackOpts);
    } else {
      this.#rules = DEFAULT_RULES;
    }
    this.#serverCards = new Map((opts.serverCards ?? []).map((c) => [c.serverId, c]));
    this.#vettingCache = new Map();
    this.#consentRecords = [];
    this.#capabilityRegistry = opts.capabilityRegistry;
    this.#profileRegistry = opts.profileRegistry;
    this.#tenantEnforcement = opts.tenantEnforcement ?? false;
    this.#unprofiledToolPolicy =
      opts.unprofiledToolPolicy ??
      (this.#effectiveSecurityProfile === "hardened" ? "ask_user" : "allow_read_heuristic");
  }

  /** The EFFECTIVE security profile — "custom" when explicit rules replaced
   * the hardened stack (final-audit C5). */
  get securityProfile(): GatewaySecurityProfile {
    return this.#effectiveSecurityProfile;
  }

  /** The profile as requested at construction, before the "custom" rewrite. */
  get requestedSecurityProfile(): GatewaySecurityProfile {
    return this.#requestedSecurityProfile;
  }

  get tenantEnforcementEnabled(): boolean {
    return this.#tenantEnforcement;
  }

  /** The active unprofiled-tool policy (final-audit C3). */
  get unprofiledToolPolicy(): UnprofiledToolPolicy {
    return this.#unprofiledToolPolicy;
  }

  registerServerCard(card: ServerCard): void {
    this.#serverCards.set(card.serverId, card);
  }

  registerToolSecurityProfile(
    entry: McpToolEntry,
    serverId: string,
    profile: Omit<ToolSecurityProfile, "toolSnapshotHash">
  ): void {
    if (!this.#profileRegistry) {
      throw new Error(
        "registerToolSecurityProfile requires a profileRegistry in MCPGatewayOptions"
      );
    }
    this.#profileRegistry.register({
      ...profile,
      toolSnapshotHash: computeToolSnapshotHash(entry, serverId),
    });
  }

  addConsentRecord(record: ConsentRecord): void {
    this.#consentRecords.push(record);
    // Prune expired entries so long-lived gateways don't accumulate dead
    // consent records forever. Non-expiring records (no expiresAt) are kept.
    const now = new Date();
    for (let i = this.#consentRecords.length - 1; i >= 0; i--) {
      const c = this.#consentRecords[i];
      if (c?.expiresAt && new Date(c.expiresAt) <= now) {
        this.#consentRecords.splice(i, 1);
      }
    }
  }

  evaluate(req: GatewayRequest): GatewayDecision {
    const cacheKey = buildVettingCacheKey(req.tool, req.serverId);
    let vetting = this.#vettingCache.get(cacheKey);
    if (!vetting) {
      vetting = vetTool(req.tool);
      // LRU: refresh insertion order and evict the least-recently used entry
      // beyond the cap.
      this.#vettingCache.delete(cacheKey);
      this.#vettingCache.set(cacheKey, vetting);
      if (this.#vettingCache.size > VETTING_CACHE_CAP) {
        const oldest = this.#vettingCache.keys().next().value;
        if (oldest !== undefined) this.#vettingCache.delete(oldest);
      }
    }

    // Layered effect classification — resolved ONCE per request (final-audit
    // C4): profile-authoritative when a profile is registered for this exact
    // descriptor, otherwise structural + heuristic with provenance.
    const serverCard = this.#serverCards.get(req.serverId);
    const verified = serverCard?.operatorVerified ?? false;

    let snapshotHash: string | undefined;
    if (this.#profileRegistry) {
      snapshotHash = computeToolSnapshotHash(req.tool, req.serverId);
      this.#currentSnapshotHash = snapshotHash;
    }
    const resolved: ResolvedToolSecurityContext = resolveToolSecurityContext({
      toolName: req.tool.name,
      args: req.args,
      ...(snapshotHash !== undefined ? { snapshotHash } : {}),
      ...(this.#profileRegistry !== undefined ? { registry: this.#profileRegistry } : {}),
    });
    const capabilityEffect = resolved.effect;
    const hasTrustedProfile = resolved.provenance === "trusted_profile";

    // P0-04: under tenant enforcement the tenant is authoritative and
    // mandatory; outside enforcement, req.tenant ?? req.serverId remains
    // the DOCUMENTED COMPATIBILITY fallback for capability-scope matching
    // only — it never substitutes for tenant isolation.
    const capabilityTenant =
      req.tenant ?? (this.#tenantEnforcement ? "__tenant_unspecified__" : req.serverId);

    // Build per-request rules: start with the gateway-level rules, then
    // append capability / tenant / trust-boundary guards for this request.
    const requestRules: PolicyRule[] = [...this.#rules];
    // Heuristic capability guard ONLY for unprofiled tools (final-audit C4):
    // when a trusted profile exists, re-running name heuristics here would
    // diverge from the operator's declaration — the profile's own
    // capabilitiesRequired (below) is the single source of truth.
    if (this.#capabilityRegistry !== undefined && !hasTrustedProfile) {
      requestRules.push(
        makeCapabilityPolicyRule(
          this.#capabilityRegistry,
          req.identity.principalHash,
          capabilityTenant
        )
      );
    }
    // C4: enforce the TRUSTED profile's declared capability requirements —
    // never a heuristic re-classification. Without a CapabilityRegistry the
    // grants cannot be checked, so enforcement is left to the profile and
    // fail-safe rules (documented in the README security model).
    if (hasTrustedProfile && resolved.capabilitiesRequired.length > 0 && this.#capabilityRegistry) {
      const registry = this.#capabilityRegistry;
      const principal = req.identity.principalHash;
      const required = resolved.capabilitiesRequired;
      const highRiskEffect =
        resolved.effect === "exec" ||
        resolved.effect === "read_secret" ||
        resolved.effect === "write_external" ||
        resolved.effect === "cross_tenant";
      requestRules.push({
        policyId: "profile-capability-required",
        evaluate: () => {
          const granted = required.every((cap) =>
            registry.hasCapability(principal, capabilityTenant, cap)
          );
          if (granted) return undefined;
          return highRiskEffect ? "deny" : "ask_user";
        },
      });
    }
    if (this.#tenantEnforcement) {
      if (req.tenant === undefined || req.tenant === "") {
        // Fail closed: no authoritative tenant, no execution.
        requestRules.push({
          policyId: "tenant-enforcement-missing-tenant",
          evaluate: () => "deny",
        });
      } else {
        requestRules.push(makeTenantIsolationRule(req.identity.principalHash, req.tenant));
      }
    }
    // C3: unprofiled tool on an UNVERIFIED server — a benign read-like name
    // is not evidence of safety. Trusted profiles and verified servers are
    // the two trust anchors that bypass this boundary.
    if (!hasTrustedProfile && !verified && this.#unprofiledToolPolicy !== "allow_read_heuristic") {
      const policyDecision = evaluateUnprofiledToolPolicy(resolved, this.#unprofiledToolPolicy);
      if (policyDecision !== undefined) {
        requestRules.push({
          policyId: `unprofiled-tool-${this.#unprofiledToolPolicy}`,
          evaluate: () => policyDecision,
        });
      }
    }

    // Consent is principal-scoped (a principal's approval never serves another
    // principal) AND binding-authoritative (final-audit C1): when a consent
    // record carries an argScopeDigest or session binding, the CURRENT call
    // must present the same digest / session — omission cannot satisfy a
    // scoped record. Digest is computed here with the same canonicalization
    // as `hashArgScope` (stableStringify), kept local to avoid a circular
    // import with consent.ts.
    const currentArgScopeDigest = createHash("sha256")
      .update(stableStringify(req.args))
      .digest("hex")
      .slice(0, 16);
    const invocation = evaluatePolicy(
      req.tool.name,
      req.args,
      vetting,
      this.#consentRecords,
      requestRules,
      cacheKey,
      req.identity.principalHash,
      currentArgScopeDigest,
      req.identity.sessionId
    );

    this.#currentSnapshotHash = undefined;

    const stateChanging = isStateChangingTool(req.tool);

    const resultTrustLevel =
      invocation.decision === "allow" && serverCard?.operatorVerified ? "verified" : "untrusted";

    const verdict = composeVerdict({
      vetting,
      decision: invocation,
      hasConsent: !!invocation.userConsentRef,
    });

    return {
      invocation,
      stateChanging,
      ...(serverCard !== undefined ? { serverCard } : {}),
      resultTrustLevel,
      capabilityEffect,
      evidenceRef: {
        principalHash: req.identity.principalHash,
        sessionId: req.identity.sessionId,
        ...(serverCard?.toolManifestDigest !== undefined
          ? { toolManifestDigest: serverCard.toolManifestDigest }
          : {}),
        policyDecision: invocation.decision,
        // C5: machine-visible effective profile (never "hardened" for a
        // custom rule stack).
        securityProfile: this.#effectiveSecurityProfile,
      },
      verdict,
    };
  }

  wrapResult(toolName: string, rawResult: string, decision: GatewayDecision): TaintedObservation {
    return taintObservation(toolName, rawResult, { trust: decision.resultTrustLevel });
  }

  /**
   * Produce a post-result verdict that incorporates taint analysis of the tool
   * output. Call after `wrapResult` once the tool has executed.
   */
  wrapResultVerdict(
    taintObs: TaintedObservation,
    priorDecision: GatewayDecision
  ): FirewallSecurityVerdict {
    return composeVerdict({
      vetting: null,
      decision: priorDecision.invocation,
      taint: taintObs,
      hasConsent: !!priorDecision.invocation.userConsentRef,
    });
  }
}
