/**
 * Source → sink structural policy layer.
 *
 * Classifies data sources and sinks, then enforces hard rules without
 * relying on semantic detection. These rules are deterministic and operate
 * on tool names and argument keys/values only.
 *
 * ## Design
 *
 * - `DataSource` — where argument values come from (heuristic, argName-based)
 * - `DataSink` — what a tool writes to (heuristic, toolName/description-based)
 * - `classifyToolSinks` — full descriptor (name + description) → DataSink[]
 * - `classifyToolSinksByName` — name-only variant used by PolicyRule (no descriptor available)
 * - `classifyArgSource` — argName → DataSource
 * - Four built-in `PolicyRule` objects covering the most critical sink flows
 * - `makeSinkAwarePolicyRule` — factory that accepts the full descriptor for
 *   richer sink detection in MCPGateway
 * - `FULL_DEFAULT_RULES` — drop-in replacement for `DEFAULT_RULES` that adds
 *   all four sink rules
 */

import type { InvocationDecision, PolicyRule } from "./policy.js";
import { DEFAULT_RULES } from "./policy.js";
import type { VettingResult } from "./vetting.js";

// ── Labels ────────────────────────────────────────────────────────────────────

export type DataSource =
  | "user_input"
  | "tool_output"
  | "secret"
  | "filesystem"
  | "environment"
  | "network_response"
  | "unknown";

export type DataSink =
  | "network_send"
  | "filesystem_write"
  | "shell_exec"
  | "credential_use"
  | "external_tool"
  | "model_context"
  | "unknown";

// ── Sink classification ───────────────────────────────────────────────────────

/**
 * Return the set of sinks a piece of text (name or description) indicates.
 * Internal helper used by both `classifyToolSinks` and `classifyToolSinksByName`.
 */
function sinksFromText(text: string): Set<DataSink> {
  const t = text.toLowerCase();
  const sinks = new Set<DataSink>();

  if (/exec|shell|bash|\bsh\b|cmd|command|\brun\b|spawn|subprocess|process/.test(t)) {
    sinks.add("shell_exec");
  }
  if (
    /write|create_file|delete_file|mkdir|move_file|rename|append|truncate|write_file|save_file|\bcreate\b|\bdelete\b|\brm\b|\bmv\b|\bcp\b/.test(
      t
    )
  ) {
    sinks.add("filesystem_write");
  }
  if (/http|request|fetch|\bpost\b|\bsend\b|upload|webhook|curl|\burl\b/.test(t)) {
    sinks.add("network_send");
  }
  if (/auth|login|credential|token|api_key|password|secret|\bssh\b|\bkey\b/.test(t)) {
    sinks.add("credential_use");
  }

  return sinks;
}

/**
 * Classify which sink(s) a tool touches based on its name and description.
 * Returns an array because a tool may touch multiple sinks (e.g. read file + send network).
 */
export function classifyToolSinks(tool: { name: string; description?: string }): DataSink[] {
  const sinks = new Set<DataSink>();

  for (const s of sinksFromText(tool.name)) sinks.add(s);
  if (tool.description) {
    for (const s of sinksFromText(tool.description)) sinks.add(s);
  }

  return sinks.size > 0 ? [...sinks] : ["unknown"];
}

/**
 * Simplified sink classification using tool name only.
 * Used inside `PolicyRule.evaluate` because the rule receives only the
 * tool name string, not the full descriptor.
 */
function classifyToolSinksByName(toolName: string): DataSink[] {
  const sinks = sinksFromText(toolName);
  return sinks.size > 0 ? [...sinks] : ["unknown"];
}

// ── Source classification ─────────────────────────────────────────────────────

/**
 * Classify the source of a given argument value (heuristic, deterministic).
 * Classification is based purely on argument name patterns.
 */
export function classifyArgSource(argName: string, _argValue: unknown): DataSource {
  // Replace underscores with spaces so that compound names like "file_path"
  // split into words and match \b word-boundary patterns correctly.
  const n = argName.replace(/_/g, " ");
  if (/\bpath\b|\bfile\b|\bdir\b|\bdirectory\b/i.test(n)) return "filesystem";
  if (/\burl\b|\bendpoint\b|\bhost\b|\buri\b/i.test(n)) return "network_response";
  if (/\btoken\b|\bkey\b|\bsecret\b|\bpassword\b|\bcredential\b|\bauth\b/i.test(n))
    return "secret";
  if (/\benv\b|\benviron\b|\bvar\b/i.test(n)) return "environment";
  return "user_input";
}

// ── Sink policy rules ─────────────────────────────────────────────────────────

/**
 * Rule: any tool whose name indicates shell execution requires user confirmation.
 *
 * Shell execution is the highest-impact sink — arbitrary code runs in the host.
 * Always escalate to ask_user so the human can verify intent before execution.
 */
export const SHELL_EXEC_CAPABILITY_RULE: PolicyRule = {
  policyId: "sink-shell-exec-requires-capability",
  evaluate(toolName: string, _args: Record<string, unknown>, _vetting: VettingResult | null): InvocationDecision | undefined {
    if (classifyToolSinksByName(toolName).includes("shell_exec")) return "ask_user";
    return undefined;
  },
};

/**
 * Rule: deny any call that passes a secret-sourced argument to a network sink.
 *
 * Sending credentials (tokens, API keys, passwords) over the network is the
 * classic exfiltration pattern. Deny hard — there is no legitimate reason to
 * let the model autonomously route secrets to an external endpoint.
 */
export const SECRET_NETWORK_SINK_RULE: PolicyRule = {
  policyId: "sink-secret-to-network-deny",
  evaluate(toolName: string, args: Record<string, unknown>, _vetting: VettingResult | null): InvocationDecision | undefined {
    if (!classifyToolSinksByName(toolName).includes("network_send")) return undefined;
    for (const [k, v] of Object.entries(args)) {
      if (classifyArgSource(k, v) === "secret") return "deny";
    }
    return undefined;
  },
};

const _SSRF_RE = /\blocalhost\b|127\.0\.0\.1|169\.254\.|::1|metadata\.google|169\.254\.169\.254/i;

/**
 * Rule: deny SSRF targets — localhost, link-local, and cloud metadata endpoints.
 *
 * These addresses are never reachable from the internet and are the canonical
 * targets of Server-Side Request Forgery. An agent autonomously sending requests
 * to them is almost always either confused or actively exploited.
 */
export const SSRF_LOCALHOST_RULE: PolicyRule = {
  policyId: "sink-ssrf-localhost-deny",
  evaluate(toolName: string, args: Record<string, unknown>, _vetting: VettingResult | null): InvocationDecision | undefined {
    if (!classifyToolSinksByName(toolName).includes("network_send")) return undefined;
    for (const v of Object.values(args)) {
      if (typeof v === "string" && _SSRF_RE.test(v)) return "deny";
    }
    return undefined;
  },
};

const _CRED_PATH_RE =
  /(~\/\.ssh|~\/\.aws|~\/\.gnupg|\/etc\/passwd|\/etc\/shadow|~\/\.config\/gcloud)/i;

/**
 * Rule: deny access to well-known credential and secret-store paths.
 *
 * SSH keys, AWS credentials, GnuPG keyrings, /etc/passwd and /etc/shadow are
 * the highest-value targets on any Unix system. Block any tool invocation whose
 * arguments reference these paths — regardless of what the tool claims to do.
 */
export const CREDENTIAL_PATH_RULE: PolicyRule = {
  policyId: "sink-credential-path-deny",
  evaluate(_toolName: string, args: Record<string, unknown>, _vetting: VettingResult | null): InvocationDecision | undefined {
    for (const v of Object.values(args)) {
      if (typeof v === "string" && _CRED_PATH_RE.test(v)) return "deny";
    }
    return undefined;
  },
};

// ── Rule collections ──────────────────────────────────────────────────────────

export const SINK_POLICY_RULES: PolicyRule[] = [
  SHELL_EXEC_CAPABILITY_RULE,
  SECRET_NETWORK_SINK_RULE,
  SSRF_LOCALHOST_RULE,
  CREDENTIAL_PATH_RULE,
];

/**
 * Drop-in replacement for `DEFAULT_RULES` that also includes all sink rules.
 * Pass to `evaluatePolicy` as the `rules` argument to activate the full stack.
 */
export const FULL_DEFAULT_RULES: PolicyRule[] = [...DEFAULT_RULES, ...SINK_POLICY_RULES];

// ── Descriptor-aware factory ──────────────────────────────────────────────────

/**
 * Create a `PolicyRule` that uses the full tool descriptor (name + description)
 * for richer sink classification. Use this in `MCPGateway` where the descriptor
 * is available at registration time and the rule can be created once per tool.
 *
 * The returned rule bakes in the pre-computed sink set so classification is O(1)
 * at call time.
 */
export function makeSinkAwarePolicyRule(tool: { name: string; description?: string }): PolicyRule {
  const sinks = classifyToolSinks(tool);
  return {
    policyId: `sink-aware:${tool.name}`,
    evaluate(_toolName: string, args: Record<string, unknown>, _vetting: VettingResult | null): InvocationDecision | undefined {
      // shell exec: always ask
      if (sinks.includes("shell_exec")) return "ask_user";

      // secret arg → network: deny
      if (sinks.includes("network_send")) {
        for (const [k, v] of Object.entries(args)) {
          if (classifyArgSource(k, v) === "secret") return "deny";
        }
      }

      // SSRF
      if (sinks.includes("network_send")) {
        for (const v of Object.values(args)) {
          if (typeof v === "string" && _SSRF_RE.test(v)) return "deny";
        }
      }

      // credential paths
      for (const v of Object.values(args)) {
        if (typeof v === "string" && _CRED_PATH_RE.test(v)) return "deny";
      }

      return undefined;
    },
  };
}
