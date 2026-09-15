/**
 * Capability and tenant enforcement module.
 *
 * Provides structured CapabilityEnvelope evaluation, effect classification,
 * capability grant registry, cross-tenant access detection, and policy rule
 * factories for enforcing capability and tenant constraints.
 */

import type { PolicyRule } from "./policy.js";
import { deepStringValues } from "./resource-path.js";

// ── Effect class ──────────────────────────────────────────────────────────────

export type EffectClass =
  | "read_only"
  | "read_secret"
  | "write_local"
  | "write_external"
  | "exec"
  | "network"
  | "cross_tenant"
  | "unknown_effect";

// ── Capability envelope ───────────────────────────────────────────────────────

export interface CapabilityEnvelope {
  /** Stable hash of the requesting principal (e.g. agent ID). */
  principal: string;
  /** Tenant identifier (used to detect cross-tenant access). */
  tenant: string;
  /** Tool being invoked. */
  tool: string;
  /** Capability label required (e.g. "fs.read", "fs.write", "network.send"). */
  capability: string;
  /** Resource being accessed (e.g. "~/.ssh/id_rsa", "https://api.example.com"). */
  resource: string;
  /** Effect class — what type of action this represents. */
  effect: EffectClass;
}

// ── Effect classification ─────────────────────────────────────────────────────

const EXEC_PATTERN = /exec|shell|bash|spawn|subprocess|run_command/;
const SECRET_ARG_SUBSTRINGS = ["~/.ssh", "~/.aws", "~/.gnupg", "/etc/shadow", "/etc/passwd"];
const WRITE_LOCAL_PATTERN = /write|create|delete|mkdir|move|rename|append|truncate/;
const NETWORK_PATTERN = /http|request|fetch|send|upload|webhook|post/;
const SECRET_TOOL_PATTERN = /token|auth|credential|secret|password|api_key/;
/**
 * Explicit read verbs. A tool whose name signals none of exec / write /
 * network / secret and none of these read verbs is NOT silently read-only:
 * it classifies as `unknown_effect` so policy can fail safe (P1-04).
 */
const READ_ONLY_PATTERN = /read|get|list|search|view|describe|query|\bshow\b|\bfetch_info\b/;

/**
 * Classify the effect class of a tool + args combination.
 * Uses heuristics: tool name patterns + arg patterns.
 *
 * This heuristic layer is a SUPPLEMENTARY signal (P0-03) — the root of trust
 * is an explicit {@link ToolSecurityProfile} when one is registered; see
 * `classifyToolEffect` in `security-profile.ts` for the layered classifier.
 *
 * Fallback is `unknown_effect`, never a silent read_only: an attacker-chosen
 * benign name must not earn low-risk treatment by being unrecognized.
 */
export function classifyEffect(toolName: string, args: Record<string, unknown>): EffectClass {
  const name = toolName.toLowerCase();

  // exec has highest precedence
  if (EXEC_PATTERN.test(name)) return "exec";

  // read_secret: check arg values before tool name
  for (const v of Object.values(args)) {
    if (typeof v === "string" && SECRET_ARG_SUBSTRINGS.some((s) => v.includes(s))) {
      return "read_secret";
    }
  }
  if (SECRET_TOOL_PATTERN.test(name)) return "read_secret";

  const writes = WRITE_LOCAL_PATTERN.test(name);
  const networks = NETWORK_PATTERN.test(name);
  // write + network = writing through an external boundary (upload/publish).
  if (writes && networks) return "write_external";
  if (writes) return "write_local";
  if (networks) return "network";

  if (READ_ONLY_PATTERN.test(name)) return "read_only";

  return "unknown_effect";
}

// ── Required capability mapping ───────────────────────────────────────────────

/**
 * Map an effect class to its required capability label.
 */
export function requiredCapabilityForEffect(effect: EffectClass): string {
  switch (effect) {
    case "exec":
      return "exec.shell";
    case "read_secret":
      return "fs.secret";
    case "write_local":
      return "fs.write";
    case "write_external":
      return "fs.write_external";
    case "network":
      return "network.send";
    case "cross_tenant":
      return "tenant.cross";
    case "unknown_effect":
      return "tool.unknown";
    case "read_only":
      return "fs.read";
  }
}

// ── Capability grant registry ─────────────────────────────────────────────────

export interface CapabilityGrant {
  principal: string;
  tenant: string;
  capability: string;
  /** ISO-8601 expiry. Absent = no expiry. */
  expiresAt?: string;
}

export class CapabilityRegistry {
  readonly #grants: CapabilityGrant[] = [];

  grant(g: CapabilityGrant): void {
    this.#grants.push(g);
  }

  /** Expire all non-expiring grants for the given principal + capability. */
  revoke(principal: string, capability: string): void {
    const now = new Date().toISOString();
    for (const g of this.#grants) {
      if (g.principal === principal && g.capability === capability && !g.expiresAt) {
        g.expiresAt = now;
      }
    }
  }

  /**
   * Check whether principal has the given capability in the given tenant.
   * Returns false if the grant is expired.
   */
  hasCapability(principal: string, tenant: string, capability: string): boolean {
    const now = new Date();
    return this.#grants.some(
      (g) =>
        g.principal === principal &&
        g.tenant === tenant &&
        g.capability === capability &&
        (!g.expiresAt || new Date(g.expiresAt) > now)
    );
  }

  all(): CapabilityGrant[] {
    return [...this.#grants];
  }
}

// ── Cross-tenant detection ────────────────────────────────────────────────────

const TENANT_ID_PATTERNS = [/tenant:[^\s/,]+/, /org:[^\s/,]+/, /\/tenants\/[^/]+\//];

/**
 * Detect potential cross-tenant resource access.
 * Returns true if any STRING VALUE in the argument tree (deep — nested
 * argument objects are scanned; the escape gate caught the top-level-only
 * scan as a real bypass) contains a tenant/org segment that does NOT contain
 * the expected tenant string.
 *
 * Heuristic: matches `tenant:<id>`, `org:<id>`, or `/tenants/<id>/` patterns.
 */
export function detectCrossTenantAccess(
  args: Record<string, unknown>,
  expectedTenant: string
): boolean {
  for (const value of deepStringValues(args)) {
    const hasTenantSegment = TENANT_ID_PATTERNS.some((p) => p.test(value));
    if (hasTenantSegment && !value.includes(expectedTenant)) {
      return true;
    }
  }
  return false;
}

// ── Policy rule factories ─────────────────────────────────────────────────────

/**
 * Returns a PolicyRule that denies or escalates based on capability checks.
 * Requires a CapabilityRegistry and the requesting principal+tenant context.
 *
 * - exec / read_secret / write_external / cross_tenant: deny when not granted
 * - write_local / network: ask_user when not granted
 * - unknown_effect: ask_user (fail-safe — P1-04: a classification miss must
 *   never be treated as read_only; the caller confirms intent)
 * - read_only: no escalation (returns undefined)
 */
export function makeCapabilityPolicyRule(
  registry: CapabilityRegistry,
  principal: string,
  tenant: string
): PolicyRule {
  return {
    policyId: "capability-guard",
    evaluate(toolName, args, _vetting) {
      const effect = classifyEffect(toolName, args);
      const required = requiredCapabilityForEffect(effect);

      switch (effect) {
        case "exec":
        case "read_secret":
        case "write_external":
        case "cross_tenant":
          return registry.hasCapability(principal, tenant, required) ? undefined : "deny";
        case "write_local":
        case "network":
        case "unknown_effect":
          return registry.hasCapability(principal, tenant, required) ? undefined : "ask_user";
        case "read_only":
          return undefined;
      }
    },
  };
}

/**
 * Returns a PolicyRule that denies cross-tenant access.
 */
export function makeTenantIsolationRule(principal: string, tenant: string): PolicyRule {
  return {
    policyId: `tenant-isolation:${principal}`,
    evaluate(_toolName, args, _vetting) {
      return detectCrossTenantAccess(args, tenant) ? "deny" : undefined;
    },
  };
}
