import type { InvocationDecision, PolicyRule } from "@wasmagent/mcp-gateway";
import { load } from "js-yaml";

export type GuardPolicyDecision = InvocationDecision;
export type GuardPolicyMode = "enforce" | "audit" | "dry_run";

export interface GuardPolicy {
  mode: GuardPolicyMode;
  maxToolCalls?: number;
  maxShellSeconds?: number;
  redactionPatterns: string[];
  rules: PolicyRule[];
}

type PolicyYaml = {
  allow?: unknown;
  require_approval?: unknown;
  deny?: unknown;
  budgets?: unknown;
  mode?: unknown;
  redaction?: unknown;
};

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`${field} must be a list of non-empty strings`);
  }
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function rule(policyId: string, tools: string[], decision: GuardPolicyDecision): PolicyRule {
  const names = new Set(tools);
  return {
    policyId,
    evaluate(toolName, _args, _vetting) {
      return names.has(toolName) ? decision : undefined;
    },
  };
}

/** Parse the subset of the policy schema that applies while guarding MCP tools. */
export function parseGuardPolicy(source: string): GuardPolicy {
  const parsed = load(source);
  const yaml = object(parsed, "policy") as PolicyYaml;

  if (yaml.mode !== undefined && !["enforce", "audit", "dry_run"].includes(String(yaml.mode))) {
    throw new Error("mode must be enforce, audit, or dry_run");
  }

  const mode = (yaml.mode ?? "enforce") as GuardPolicyMode;
  const budgets = yaml.budgets === undefined ? {} : object(yaml.budgets, "budgets");
  const maxToolCalls = budgets.max_tool_calls;
  const maxShellSeconds = budgets.max_shell_seconds;
  for (const [field, value] of [
    ["budgets.max_tool_calls", maxToolCalls],
    ["budgets.max_shell_seconds", maxShellSeconds],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    ) {
      throw new Error(`${field} must be a non-negative integer`);
    }
  }

  const redaction = yaml.redaction === undefined ? {} : object(yaml.redaction, "redaction");
  const redactionPatterns = stringList(redaction.patterns, "redaction.patterns");

  return {
    mode,
    ...(maxToolCalls === undefined ? {} : { maxToolCalls: maxToolCalls as number }),
    ...(maxShellSeconds === undefined ? {} : { maxShellSeconds: maxShellSeconds as number }),
    redactionPatterns,
    rules: [
      rule("allow-config", stringList(yaml.allow, "allow"), "allow"),
      rule("approval-config", stringList(yaml.require_approval, "require_approval"), "ask_user"),
      rule("deny-config", stringList(yaml.deny, "deny"), "deny"),
    ],
  };
}

export function redactGuardReport(value: string, patterns: string[]): string {
  return patterns.reduce((result, pattern) => result.replaceAll(pattern, "[REDACTED]"), value);
}
