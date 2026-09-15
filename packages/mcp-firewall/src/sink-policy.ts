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
import { classifyResourcePath, deepStringValues } from "./resource-path.js";
import { classifyUrlTarget } from "./url-policy.js";
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
  if (/\btoken\b|\bkey\b|\bsecret\b|\bpassword\b|\bcredential\b|\bauth\b/i.test(n)) return "secret";
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
  evaluate(
    toolName: string,
    _args: Record<string, unknown>,
    _vetting: VettingResult | null
  ): InvocationDecision | undefined {
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
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
    _vetting: VettingResult | null
  ): InvocationDecision | undefined {
    if (!classifyToolSinksByName(toolName).includes("network_send")) return undefined;
    for (const key of deepArgKeys(args)) {
      if (classifyArgSource(key, undefined) === "secret") return "deny";
    }
    return undefined;
  },
};

/**
 * Collect argument key names from an arbitrary argument tree (deep, bounded).
 * An attacker controls nesting, so secret-arg detection must see
 * `wrapper: { api_token: "..." }` as well as top-level `api_token`.
 * Returns the key names at every object level; array elements are traversed
 * without introducing synthetic key names.
 */
function deepArgKeys(value: unknown, opts?: { maxDepth?: number; maxNodes?: number }): string[] {
  const maxDepth = opts?.maxDepth ?? 8;
  const maxNodes = opts?.maxNodes ?? 512;
  const out: string[] = [];
  const queue: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  let visited = 0;

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const { v, d } = next;
    visited++;
    if (visited > maxNodes) break;
    if (v === null || typeof v !== "object") continue;
    if (d >= maxDepth) continue;
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

const _SSRF_RE = /\blocalhost\b|127\.0\.0\.1|169\.254\.|::1|metadata\.google|169\.254\.169\.254/i;

/**
 * Structural SSRF check for one argument value: normalized URL/host/IP
 * classification (P1-02) plus the legacy textual patterns for values that
 * mention a forbidden host inside longer prose.
 */
function isSsrfTarget(v: string): boolean {
  if (_SSRF_RE.test(v)) return true;
  return classifyUrlTarget(v).blocked;
}

/**
 * Rule: deny SSRF targets — localhost, loopback, private/link-local ranges,
 * and cloud metadata endpoints, across textual and alternate IP encodings
 * (decimal/hex/octal IPv4, IPv6, IPv4-mapped IPv6).
 *
 * These addresses are never reachable from the internet and are the canonical
 * targets of Server-Side Request Forgery. An agent autonomously sending requests
 * to them is almost always either confused or actively exploited.
 *
 * Boundary: this is a PRE-flight check on argument strings. DNS rebinding
 * (a public name resolving to a private IP) must be enforced post-resolution
 * in the runtime network layer — see the README security model.
 */
export const SSRF_LOCALHOST_RULE: PolicyRule = {
  policyId: "sink-ssrf-localhost-deny",
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
    _vetting: VettingResult | null
  ): InvocationDecision | undefined {
    if (!classifyToolSinksByName(toolName).includes("network_send")) return undefined;
    for (const v of deepStringValues(args)) {
      if (isSsrfTarget(v)) return "deny";
    }
    return undefined;
  },
};

/**
 * Rule: deny access to well-known credential and secret-store paths.
 *
 * Values are lexically normalized first (P1-01) so the same real path is
 * caught regardless of representation: `~/.ssh/id_rsa`,
 * `${HOME}/.ssh/id_rsa`, `file:///home/u/.ssh/id_rsa`,
 * `~/.ssh/../.ssh/id_rsa`, `C:\Users\u\.ssh\id_rsa`, and percent-encoded
 * file URIs all classify as sensitive. SSH keys, AWS/GCP/Azure credentials,
 * GnuPG keyrings, kubeconfig, /etc/passwd and /etc/shadow are the
 * highest-value targets on any system. Block any tool invocation whose
 * arguments reference these paths — regardless of what the tool claims to do.
 */
export const CREDENTIAL_PATH_RULE: PolicyRule = {
  policyId: "sink-credential-path-deny",
  evaluate(
    _toolName: string,
    args: Record<string, unknown>,
    _vetting: VettingResult | null
  ): InvocationDecision | undefined {
    for (const v of deepStringValues(args)) {
      if (classifyResourcePath(v).isSensitive) return "deny";
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
    evaluate(
      _toolName: string,
      args: Record<string, unknown>,
      _vetting: VettingResult | null
    ): InvocationDecision | undefined {
      // shell exec: always ask
      if (sinks.includes("shell_exec")) return "ask_user";

      // secret arg → network: deny (deep — nested arg names count too)
      if (sinks.includes("network_send")) {
        for (const key of deepArgKeys(args)) {
          if (classifyArgSource(key, undefined) === "secret") return "deny";
        }
        for (const v of deepStringValues(args)) {
          if (isSsrfTarget(v)) return "deny";
        }
      }

      // credential paths
      for (const v of deepStringValues(args)) {
        if (classifyResourcePath(v).isSensitive) return "deny";
      }

      return undefined;
    },
  };
}
