/**
 * Compile CapabilityManifest → runtime policy rules.
 *
 * Policy rules are deterministic predicates that can be evaluated against
 * a tool invocation at runtime — no ML, no LLM, just manifest-derived logic.
 *
 * Each rule produces a `PolicyCheckResult`: pass (allowed), deny (blocked),
 * or warn (allowed with audit log).
 */

import type { CapabilityManifest } from "@wasmagent/core";

export type PolicyOutcome = "allow" | "deny" | "warn";

export interface PolicyRule {
  ruleId: string;
  description: string;
  /** Evaluate a tool call. Returns outcome + optional reason. */
  check(call: ToolCall): PolicyCheckResult;
}

export interface ToolCall {
  toolName: string;
  /** Raw arguments as passed by the model. */
  args: Record<string, unknown>;
  /** Optional: hostname extracted from URL argument, if any. */
  resolvedHost?: string;
  /** Optional: filesystem path argument, if any. */
  resolvedPath?: string;
}

export interface PolicyCheckResult {
  ruleId: string;
  outcome: PolicyOutcome;
  reason?: string;
}

export interface CompiledPolicy {
  manifestSummary: string;
  rules: PolicyRule[];
  /** Evaluate all rules against a tool call. Returns first deny, else all warns, else allow. */
  evaluate(call: ToolCall): { decision: PolicyOutcome; results: PolicyCheckResult[] };
}

/**
 * Compile a CapabilityManifest into an executable set of PolicyRules.
 *
 * Rules are ordered: deny rules first, then warn rules.
 * Short-circuit on first deny.
 */
export function compileToPolicy(manifest: CapabilityManifest): CompiledPolicy {
  const rules: PolicyRule[] = [];

  // Network deny rule
  if (manifest.allowedHosts.length === 0) {
    rules.push({
      ruleId: "network:deny-all",
      description: "Manifest allows no outbound network — deny any call with a host argument",
      check(call) {
        if (call.resolvedHost) {
          return { ruleId: "network:deny-all", outcome: "deny", reason: `Network access denied by manifest (host: ${call.resolvedHost})` };
        }
        return { ruleId: "network:deny-all", outcome: "allow" };
      },
    });
  } else {
    const allowed = new Set(manifest.allowedHosts);
    rules.push({
      ruleId: "network:allowlist",
      description: `Only allow connections to: ${manifest.allowedHosts.join(", ")}`,
      check(call) {
        if (call.resolvedHost && !allowed.has(call.resolvedHost)) {
          return { ruleId: "network:allowlist", outcome: "deny", reason: `Host ${call.resolvedHost} not in manifest allowedHosts` };
        }
        return { ruleId: "network:allowlist", outcome: "allow" };
      },
    });
  }

  // Filesystem read rule
  if (manifest.allowedReadPaths.length === 0) {
    rules.push({
      ruleId: "fs:deny-read",
      description: "Manifest allows no filesystem reads",
      check(call) {
        if (call.resolvedPath && (call.toolName.includes("read") || call.toolName.includes("list"))) {
          return { ruleId: "fs:deny-read", outcome: "deny", reason: `Filesystem read denied by manifest (path: ${call.resolvedPath})` };
        }
        return { ruleId: "fs:deny-read", outcome: "allow" };
      },
    });
  } else {
    const readPaths = manifest.allowedReadPaths;
    rules.push({
      ruleId: "fs:read-allowlist",
      description: `Read allowed under: ${readPaths.join(", ")}`,
      check(call) {
        if (call.resolvedPath && (call.toolName.includes("read") || call.toolName.includes("list"))) {
          const allowed = readPaths.some((p) => call.resolvedPath!.startsWith(p));
          if (!allowed) {
            return { ruleId: "fs:read-allowlist", outcome: "deny", reason: `Path ${call.resolvedPath} outside allowedReadPaths` };
          }
        }
        return { ruleId: "fs:read-allowlist", outcome: "allow" };
      },
    });
  }

  // Filesystem write rule
  if (manifest.allowedWritePaths.length === 0) {
    rules.push({
      ruleId: "fs:deny-write",
      description: "Manifest allows no filesystem writes",
      check(call) {
        if (call.resolvedPath && (call.toolName.includes("write") || call.toolName.includes("delete") || call.toolName.includes("patch"))) {
          return { ruleId: "fs:deny-write", outcome: "deny", reason: `Filesystem write denied by manifest (path: ${call.resolvedPath})` };
        }
        return { ruleId: "fs:deny-write", outcome: "allow" };
      },
    });
  } else {
    const writePaths = manifest.allowedWritePaths;
    rules.push({
      ruleId: "fs:write-allowlist",
      description: `Write allowed under: ${writePaths.join(", ")}`,
      check(call) {
        if (call.resolvedPath && (call.toolName.includes("write") || call.toolName.includes("delete") || call.toolName.includes("patch"))) {
          const allowed = writePaths.some((p) => call.resolvedPath!.startsWith(p));
          if (!allowed) {
            return { ruleId: "fs:write-allowlist", outcome: "deny", reason: `Path ${call.resolvedPath} outside allowedWritePaths` };
          }
        }
        return { ruleId: "fs:write-allowlist", outcome: "allow" };
      },
    });
  }

  // CPU budget warn rule
  if (manifest.cpuMs !== undefined) {
    const limit = manifest.cpuMs;
    rules.push({
      ruleId: "cpu:budget-warn",
      description: `Warn if estimated CPU > ${limit}ms`,
      check(call) {
        const est = typeof call.args["_estimated_cpu_ms"] === "number" ? call.args["_estimated_cpu_ms"] : 0;
        if (est > limit) {
          return { ruleId: "cpu:budget-warn", outcome: "warn", reason: `Estimated ${est}ms exceeds manifest cpuMs=${limit}` };
        }
        return { ruleId: "cpu:budget-warn", outcome: "allow" };
      },
    });
  }

  const manifestSummary = [
    `network:${manifest.allowedHosts.length === 0 ? "none" : manifest.allowedHosts.join(",")}`,
    `read:${manifest.allowedReadPaths.length === 0 ? "none" : manifest.allowedReadPaths.join(",")}`,
    `write:${manifest.allowedWritePaths.length === 0 ? "none" : manifest.allowedWritePaths.join(",")}`,
    manifest.cpuMs !== undefined ? `cpu:${manifest.cpuMs}ms` : null,
    manifest.memoryLimitBytes !== undefined ? `mem:${Math.round(manifest.memoryLimitBytes / 1048576)}mb` : null,
  ].filter(Boolean).join(" | ");

  return {
    manifestSummary,
    rules,
    evaluate(call: ToolCall) {
      const results: PolicyCheckResult[] = [];
      for (const rule of rules) {
        const r = rule.check(call);
        results.push(r);
        if (r.outcome === "deny") {
          return { decision: "deny" as PolicyOutcome, results };
        }
      }
      const hasWarn = results.some((r) => r.outcome === "warn");
      return { decision: (hasWarn ? "warn" : "allow") as PolicyOutcome, results };
    },
  };
}
