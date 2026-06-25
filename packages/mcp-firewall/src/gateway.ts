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

import { createHash } from "node:crypto";
import type { McpToolEntry } from "@wasmagent/mcp-server";
import type { ConsentRecord, PolicyRule, ToolInvocationDecision } from "./policy.js";
import { DEFAULT_RULES, evaluatePolicy } from "./policy.js";
import type { TaintedObservation } from "./taint.js";
import { taintObservation } from "./taint.js";
import type { VettingResult } from "./vetting.js";
import { vetTool } from "./vetting.js";

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
    leaseId: createHash("sha256")
      .update(opts.principalHash + opts.serverId + expiry)
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
    argsDigest: createHash("sha256").update(JSON.stringify(opts.args)).digest("hex").slice(0, 16),
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
];

/** Heuristic: returns true if the tool's name or description suggests it mutates state. */
export function isStateChangingTool(tool: McpToolEntry): boolean {
  const text = (tool.name + " " + tool.description).toLowerCase();
  return STATE_CHANGING_PATTERNS.some((p) => p.test(text));
}

// ── Gateway Context ───────────────────────────────────────────────────────────

export interface GatewayRequest {
  identity: RequestIdentity;
  serverId: string;
  tool: McpToolEntry;
  args: Record<string, unknown>;
}

export interface GatewayDecision {
  invocation: ToolInvocationDecision;
  stateChanging: boolean;
  serverCard?: ServerCard;
  resultTrustLevel: "untrusted" | "verified" | "system";
  /** AEP evidence fields for this decision. */
  evidenceRef: {
    principalHash: string;
    sessionId: string;
    toolManifestDigest?: string;
    policyDecision: string;
  };
}

// ── MCPGateway ────────────────────────────────────────────────────────────────

export interface MCPGatewayOptions {
  /** Policy rules (defaults to DEFAULT_RULES). */
  rules?: PolicyRule[];
  /** Server cards registered at startup. */
  serverCards?: ServerCard[];
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
  readonly #serverCards: Map<string, ServerCard>;
  readonly #vettingCache: Map<string, VettingResult>;
  readonly #consentRecords: ConsentRecord[];

  constructor(opts: MCPGatewayOptions = {}) {
    this.#rules = opts.rules ?? DEFAULT_RULES;
    this.#serverCards = new Map((opts.serverCards ?? []).map((c) => [c.serverId, c]));
    this.#vettingCache = new Map();
    this.#consentRecords = [];
  }

  registerServerCard(card: ServerCard): void {
    this.#serverCards.set(card.serverId, card);
  }

  addConsentRecord(record: ConsentRecord): void {
    this.#consentRecords.push(record);
  }

  evaluate(req: GatewayRequest): GatewayDecision {
    const cacheKey = req.serverId + "/" + req.tool.name;
    let vetting = this.#vettingCache.get(cacheKey);
    if (!vetting) {
      vetting = vetTool(req.tool);
      this.#vettingCache.set(cacheKey, vetting);
    }

    const invocation = evaluatePolicy(
      req.tool.name,
      req.args,
      vetting,
      this.#consentRecords,
      this.#rules
    );

    const stateChanging = isStateChangingTool(req.tool);
    const serverCard = this.#serverCards.get(req.serverId);

    const resultTrustLevel =
      invocation.decision === "allow" && serverCard?.operatorVerified ? "verified" : "untrusted";

    return {
      invocation,
      stateChanging,
      ...(serverCard !== undefined ? { serverCard } : {}),
      resultTrustLevel,
      evidenceRef: {
        principalHash: req.identity.principalHash,
        sessionId: req.identity.sessionId,
        ...(serverCard?.toolManifestDigest !== undefined
          ? { toolManifestDigest: serverCard.toolManifestDigest }
          : {}),
        policyDecision: invocation.decision,
      },
    };
  }

  wrapResult(toolName: string, rawResult: string, decision: GatewayDecision): TaintedObservation {
    return taintObservation(toolName, rawResult, { trust: decision.resultTrustLevel });
  }
}
