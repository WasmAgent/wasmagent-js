/**
 * Explicit structured security metadata for tools (P0-03) + unknown-profile
 * fail-safe (P1-04).
 *
 * Heuristic classification relies on tool and argument names — but an
 * adversarial MCP server controls its own names, descriptions, and schemas.
 * This module makes security classification AUTHORITATIVE instead:
 *
 *   1. explicit trusted ToolSecurityProfile (registered per tool snapshot)
 *   2. structural policy (value-driven: paths, URLs, capability sinks)
 *   3. name heuristics — supplementary signal only, never the root of trust
 *
 * Unknown-profile fail-safe: a tool with no registered profile and no
 * recognizable structural signal classifies as `unknown_effect` and is
 * escalated (ask_user by default). A benign-looking unknown name must never
 * earn read-only treatment.
 */

import { createHash } from "node:crypto";
import type { McpToolEntry } from "@wasmagent/mcp-server";
import { classifyEffect, type EffectClass } from "./capability.js";
import type { PolicyRule } from "./policy.js";
import { classifyResourcePath, deepStringValues } from "./resource-path.js";
import {
  classifyArgSource,
  classifyToolSinks,
  type DataSink,
  FULL_DEFAULT_RULES,
} from "./sink-policy.js";
import { classifyUrlTarget } from "./url-policy.js";

// ── Profile model ────────────────────────────────────────────────────────────

/**
 * Operator-reviewed security metadata for one tool snapshot.
 * Independent of tool naming: effects and sinks are declared facts, not
 * guesses from strings an attacker controls.
 */
export interface ToolSecurityProfile {
  /** Snapshot hash this profile is bound to (see `computeToolSnapshotHash`). */
  toolSnapshotHash: string;
  /** Declared effect classes. Empty array = operator declares side-effect-free. */
  effects: EffectClass[];
  /** Declared data sinks the tool writes to. */
  sinks: DataSink[];
  /** Capability labels a principal must hold for this tool to run unescalated. */
  capabilitiesRequired: string[];
  /**
   * Argument paths (top-level or dotted, e.g. `auth.token`) whose values are
   * secret sources regardless of what the argument is called.
   */
  sensitiveArgPaths?: string[];
  /** Whether the tool may act across tenants. Default: same_tenant. */
  tenantScope?: "same_tenant" | "cross_tenant_allowed";
}

/** Lookup interface for tool security profiles. */
export interface ToolSecurityProfileRegistry {
  /** Bind a profile to its snapshot hash. */
  register(profile: ToolSecurityProfile): void;
  lookup(toolSnapshotHash: string): ToolSecurityProfile | undefined;
}

/** In-memory registry. For production use, back with a reviewed manifest. */
export class InMemoryToolSecurityProfileRegistry implements ToolSecurityProfileRegistry {
  readonly #profiles = new Map<string, ToolSecurityProfile>();

  register(profile: ToolSecurityProfile): void {
    this.#profiles.set(profile.toolSnapshotHash, profile);
  }

  lookup(toolSnapshotHash: string): ToolSecurityProfile | undefined {
    return this.#profiles.get(toolSnapshotHash);
  }

  all(): ToolSecurityProfile[] {
    return [...this.#profiles.values()];
  }
}

/**
 * Snapshot hash binding a profile to an exact tool descriptor.
 * Stable across registration order; changes whenever name, description, or
 * schema changes (a rug-pull invalidates the profile → fail-safe applies).
 */
export function computeToolSnapshotHash(entry: McpToolEntry, serverId: string): string {
  const descriptionHash = createHash("sha256").update(entry.description, "utf8").digest("hex");
  const schemaHash = createHash("sha256")
    .update(JSON.stringify(entry.inputSchema), "utf8")
    .digest("hex");
  return createHash("sha256")
    .update(`${serverId}\u0000${entry.name}\u0000${descriptionHash}\u0000${schemaHash}`, "utf8")
    .digest("hex");
}

// ── Layered effect classification ────────────────────────────────────────────

/** Lightweight secret-shaped-value heuristic (supplementary signal). */
const SECRET_VALUE_RE =
  /sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/;

export interface ClassifyToolEffectOptions {
  /** Descriptor snapshot hash for profile lookup (from `computeToolSnapshotHash`). */
  toolSnapshotHash?: string;
  registry?: ToolSecurityProfileRegistry;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Policy for tools with NO trusted ToolSecurityProfile (final-audit C3).
 *
 * The threat model includes malicious/compromised MCP servers that control
 * their own tool names — a benign read-like name (`query_orders`) proves
 * nothing about hidden server-side effects. How the gateway treats such a
 * tool is therefore an explicit trust decision:
 * - "ask_user"   — hardened default for unverified servers: unprofiled
 *                  read-shaped tools still get human confirmation
 * - "deny"       — strict mode
 * - "allow_read_heuristic" — legacy behavior; only appropriate when the
 *                  operator accepts name-heuristic trust (e.g. operator-
 *                  verified servers via the per-server check, or legacy
 *                  profile deployments)
 */
export type UnprofiledToolPolicy = "allow_read_heuristic" | "ask_user" | "deny";

/** How the resolved effect was determined — provenance of the trust decision. */
export type EffectProvenance = "trusted_profile" | "structural_signal" | "heuristic" | "unknown";

/**
 * The single security context resolved once per request (final-audit C4).
 * Every per-request rule consumes THIS object — heuristic re-classification
 * inside individual rules cannot diverge from the trusted profile.
 */
export interface ResolvedToolSecurityContext {
  snapshotHash: string | undefined;
  profile: ToolSecurityProfile | undefined;
  effect: EffectClass;
  sinks: DataSink[];
  capabilitiesRequired: string[];
  provenance: EffectProvenance;
}

/**
 * Resolve the security context for one tool invocation:
 *   1. trusted profile (operator-registered) → authoritative
 *   2. structural value signals → provenance "structural_signal"
 *   3. name heuristics → provenance "heuristic"
 *   4. fallback unknown_effect → provenance "unknown"
 */
export function resolveToolSecurityContext(opts: {
  registry?: ToolSecurityProfileRegistry;
  snapshotHash?: string;
  toolName: string;
  args: Record<string, unknown>;
}): ResolvedToolSecurityContext {
  const profile = opts.snapshotHash ? opts.registry?.lookup(opts.snapshotHash) : undefined;

  if (profile) {
    return {
      snapshotHash: opts.snapshotHash,
      profile,
      effect:
        profile.effects.length === 0 ? "read_only" : (profile.effects.at(0) ?? "unknown_effect"),
      sinks: profile.sinks,
      capabilitiesRequired: profile.capabilitiesRequired,
      provenance: "trusted_profile",
    };
  }

  const nameSinks = classifyToolSinks({ name: opts.toolName });

  // Value-driven structural signals.
  for (const v of deepStringValues(opts.args)) {
    if (classifyResourcePath(v).isSensitive) {
      return {
        snapshotHash: opts.snapshotHash,
        profile: undefined,
        effect: "read_secret",
        sinks: nameSinks,
        capabilitiesRequired: [],
        provenance: "structural_signal",
      };
    }
  }
  for (const v of deepStringValues(opts.args)) {
    if (classifyUrlTarget(v).host !== undefined) {
      return {
        snapshotHash: opts.snapshotHash,
        profile: undefined,
        effect: "network",
        sinks: nameSinks,
        capabilitiesRequired: [],
        provenance: "structural_signal",
      };
    }
  }
  for (const v of deepStringValues(opts.args)) {
    if (SECRET_VALUE_RE.test(v)) {
      return {
        snapshotHash: opts.snapshotHash,
        profile: undefined,
        effect: "read_secret",
        sinks: nameSinks,
        capabilitiesRequired: [],
        provenance: "structural_signal",
      };
    }
  }

  const heuristic = classifyEffect(opts.toolName, opts.args);
  return {
    snapshotHash: opts.snapshotHash,
    profile: undefined,
    effect: heuristic,
    sinks: nameSinks,
    capabilitiesRequired: [],
    provenance: heuristic === "unknown_effect" ? "unknown" : "heuristic",
  };
}

/**
 * Layered effect classification:
 *   1. registered profile → declared effects (authoritative)
 *   2. registered profile with empty effects → read_only (operator-declared safe)
 *   3. structural signals from VALUES (credential paths, URL targets, secret
 *      shapes) — survive any tool/argument renaming
 *   4. name heuristics (supplementary)
 *   5. fallback `unknown_effect` — never silently read_only
 */
export function classifyToolEffect(opts: ClassifyToolEffectOptions): EffectClass {
  return resolveToolSecurityContext(opts).effect;
}

// ── Policy rules ─────────────────────────────────────────────────────────────

/**
 * Rule: enforce an explicitly registered ToolSecurityProfile.
 * The profile — not the tool's name — decides how the call is treated:
 * - declared network sink + secret-sourced argument (deep / by
 *   sensitiveArgPaths) → deny
 * - declared network sink + SSRF target value → deny
 * - declared exec / read_secret / write_local / write_external → ask_user
 * - declared cross_tenant → deny
 *
 * `getSnapshotHash` supplies the CURRENT request's descriptor snapshot hash
 * (see `computeToolSnapshotHash`). MCPGateway binds it to a per-instance
 * field set at the start of each `evaluate()`; callers invoking rules
 * directly must bind it themselves.
 */
export function makeProfileAuthoritativeRule(
  registry: ToolSecurityProfileRegistry,
  getSnapshotHash: () => string | undefined
): PolicyRule {
  return {
    policyId: "profile-authoritative",
    evaluate(_toolName, args, _vetting) {
      const snapshotHash = getSnapshotHash();
      const profile = snapshotHash ? registry.lookup(snapshotHash) : undefined;
      if (!profile) return undefined;

      // secret → declared network sink: deny (naming-independent exfil guard)
      if (profile.sinks.includes("network_send")) {
        const sensitivePaths = new Set(profile.sensitiveArgPaths ?? []);
        for (const key of deepArgKeysOf(args)) {
          const sensitive =
            sensitivePaths.has(key) || classifyArgSource(key, undefined) === "secret";
          if (sensitive) return "deny";
        }
        for (const v of deepStringValues(args)) {
          if (classifyUrlTarget(v).blocked) return "deny";
        }
      }

      for (const effect of profile.effects) {
        if (effect === "cross_tenant") return "deny";
        if (effect === "unknown_effect") return "ask_user";
        if (
          effect === "exec" ||
          effect === "read_secret" ||
          effect === "write_local" ||
          effect === "write_external"
        ) {
          return "ask_user";
        }
      }
      return undefined;
    },
  };
}

export interface UnknownProfileFailSafeOptions {
  /** Decision for unrecognised tools. Default "ask_user". */
  unknownEffectDecision?: "ask_user" | "deny";
  /** Registry used to detect a TRUSTED profile for the current descriptor —
   * when one exists, the profile rules own the decision and the fail-safe
   * stands down (it must not second-guess operator-declared effects). */
  profileRegistry?: ToolSecurityProfileRegistry;
  /** Supplies the current request's descriptor snapshot hash. */
  getSnapshotHash?: () => string | undefined;
}

/**
 * Rule: fail safe for tools with NO registered profile whose effect cannot
 * be confidently classified (P1-04). Also denies the secret→network flow
 * detected purely from VALUES (URL target + secret-shaped value), which no
 * naming assumption can hide.
 *
 * Stands down entirely when a TRUSTED profile exists for the current
 * descriptor — the profile-authoritative rule owns that decision.
 */
export function makeUnknownProfileFailSafeRule(
  opts: UnknownProfileFailSafeOptions = {}
): PolicyRule {
  return {
    policyId: "unknown-profile-fail-safe",
    evaluate(toolName, args, _vetting) {
      // A trusted operator profile is authoritative — do not second-guess it.
      const snapshotHash = opts.getSnapshotHash?.();
      if (
        opts.profileRegistry !== undefined &&
        snapshotHash !== undefined &&
        opts.profileRegistry.lookup(snapshotHash) !== undefined
      ) {
        return undefined;
      }

      // Value-driven exfil: a URL-shaped destination plus a secret-shaped
      // value is the exfiltration pattern regardless of tool/arg names.
      let sawUrlTarget = false;
      let sawSecretValue = false;
      for (const v of deepStringValues(args)) {
        if (classifyUrlTarget(v).host !== undefined) sawUrlTarget = true;
        if (SECRET_VALUE_RE.test(v)) sawSecretValue = true;
      }
      if (sawUrlTarget && sawSecretValue) return "deny";

      const nameEffect = classifyEffect(toolName, args);
      const layeredEffect = classifyToolEffect({ toolName, args });

      // Unrecognised tool: fail safe (P1-04) — never silently read_only.
      if (layeredEffect === "unknown_effect") {
        return opts.unknownEffectDecision ?? "ask_user";
      }

      // Value-driven network suspicion: the tool's NAME gave no network
      // signal but an argument carries a URL-shaped destination. An
      // unregistered tool reaching an external endpoint without its name
      // admitting it gets escalated, not allowed.
      if (layeredEffect === "network" && nameEffect !== "network") {
        return "ask_user";
      }

      return undefined;
    },
  };
}

/**
 * Per-request decision for an UNPROFILED tool on an UNVERIFIED server
 * (final-audit C3). A benign read-like name is not evidence of safety; how
 * much trust it earns is the operator's explicit `UnprofiledToolPolicy`.
 * Returns undefined when the policy allows the heuristic read or when the
 * tool is not read-only (other rules already own those).
 */
export function evaluateUnprofiledToolPolicy(
  ctx: ResolvedToolSecurityContext,
  policy: UnprofiledToolPolicy
): "ask_user" | "deny" | undefined {
  if (policy === "allow_read_heuristic") return undefined;
  if (ctx.effect === "read_only") return policy;
  return undefined;
}

export interface HardenedRuleStackOptions {
  /** Registry of operator-reviewed profiles (recommended). */
  profileRegistry?: ToolSecurityProfileRegistry;
  /** Decision for unrecognised tools. Default "ask_user". */
  unknownEffectDecision?: "ask_user" | "deny";
  /** Supplies the current request's descriptor snapshot hash (see
   * `computeToolSnapshotHash`); required for profile lookup inside rules. */
  getSnapshotHash?: () => string | undefined;
}

/**
 * Hardened default rule stack: FULL_DEFAULT_RULES plus the profile rule
 * (when a registry is supplied) plus the unknown-profile fail-safe.
 * `MCPGateway` uses this by default in the "hardened" security profile.
 */
export function makeHardenedRuleStack(opts: HardenedRuleStackOptions = {}): PolicyRule[] {
  const rules = [...FULL_DEFAULT_RULES];
  const getSnapshotHash = opts.getSnapshotHash ?? (() => undefined);
  if (opts.profileRegistry !== undefined) {
    rules.push(makeProfileAuthoritativeRule(opts.profileRegistry, getSnapshotHash));
  }
  rules.push(
    makeUnknownProfileFailSafeRule({
      ...(opts.unknownEffectDecision !== undefined
        ? { unknownEffectDecision: opts.unknownEffectDecision }
        : {}),
      ...(opts.profileRegistry !== undefined ? { profileRegistry: opts.profileRegistry } : {}),
      getSnapshotHash,
    })
  );
  return rules;
}

// ── Deep arg helpers (shared with profile rules) ─────────────────────────────

function deepArgKeysOf(value: unknown): string[] {
  const out: string[] = [];
  const queue: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const { v, d } = next;
    visited++;
    if (visited > 512) break;
    if (v === null || typeof v !== "object" || d >= 8) continue;
    if (Array.isArray(v)) {
      for (const item of v) queue.push({ v: item, d: d + 1 });
    } else {
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        out.push(k);
        queue.push({ v: item, d: d + 1 });
      }
    }
  }
  return out;
}
