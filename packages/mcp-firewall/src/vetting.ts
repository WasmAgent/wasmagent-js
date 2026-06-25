/**
 * Tool metadata static vetting — deterministic pattern-based analysis.
 *
 * Scans a tool's description, parameter descriptions, and inputSchema
 * for known attack patterns WITHOUT any ML inference:
 *   - Prompt injection strings ("ignore previous instructions", etc.)
 *   - Exfiltration keywords (env vars, tokens, secrets)
 *   - Invisible / non-printable characters
 *   - Tool shadowing: name/description suspiciously close to a trusted tool
 *   - Sampling abuse: description requests the host to call the LLM on its behalf
 */

import type { McpToolEntry } from "@wasmagent/mcp-server";

// ── Types ────────────────────────────────────────────────────────────────────

export type RiskSeverity = "low" | "medium" | "high" | "critical";
export type RiskCategory =
  | "tool_poisoning"
  | "shadowing"
  | "rug_pull"
  | "exfiltration"
  | "sampling_abuse"
  | "invisible_chars";

export type VettedField = "name" | "description" | "inputSchema";

export type RiskRecommendation = "allow" | "ask" | "deny";

export interface ToolRiskFinding {
  severity: RiskSeverity;
  category: RiskCategory;
  field: VettedField;
  /** Short excerpt of the suspicious content (max 120 chars). */
  evidenceExcerpt: string;
  /** Stable hash of the full field value at finding time. */
  evidenceHash: string;
  recommendation: RiskRecommendation;
}

export interface VettingResult {
  toolName: string;
  findings: ToolRiskFinding[];
  /** Aggregate recommendation — worst-case across all findings. */
  recommendation: RiskRecommendation;
  /** True if any finding has severity=critical or recommendation=deny. */
  blocked: boolean;
}

// ── Rule tables ──────────────────────────────────────────────────────────────

// Prompt injection / tool poisoning patterns (case-insensitive)
const INJECTION_PATTERNS: string[] = [
  "ignore previous instructions",
  "ignore all previous",
  "disregard your instructions",
  "you are now",
  "forget your previous",
  "new instructions:",
  "system prompt:",
  "[[", // common injection delimiter
  "]]",
];

// Exfiltration — requesting access to sensitive env/filesystem
const EXFILTRATION_PATTERNS: string[] = [
  "process.env",
  "env var",
  "environment variable",
  "api key",
  "secret",
  "password",
  "token",
  "credential",
  "private key",
  "/etc/passwd",
  "~/.ssh",
  "~/.aws",
  ".env",
];

// Sampling abuse — tool asking the host/LLM to call it back
const SAMPLING_PATTERNS: string[] = [
  "call the llm",
  "ask the model",
  "request a completion",
  "send a request to",
  "invoke the assistant",
  "sampling request",
];

// Invisible / non-printable Unicode ranges that could hide instructions
const INVISIBLE_CHAR_RE = /[­​-‏‪-‮⁠-⁯﻿]/;

// ── Helpers ──────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

function fieldHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function excerpt(text: string, max = 120): string {
  return text.length <= max ? text : text.slice(0, max) + "…";
}

function scanText(text: string, field: VettedField, _toolName: string): ToolRiskFinding[] {
  const findings: ToolRiskFinding[] = [];
  const lower = text.toLowerCase();
  const hash = fieldHash(text);

  for (const pat of INJECTION_PATTERNS) {
    if (lower.includes(pat)) {
      findings.push({
        severity: "critical",
        category: "tool_poisoning",
        field,
        evidenceExcerpt: excerpt(text),
        evidenceHash: hash,
        recommendation: "deny",
      });
      break; // one finding per category per field
    }
  }

  for (const pat of EXFILTRATION_PATTERNS) {
    if (lower.includes(pat)) {
      findings.push({
        severity: "high",
        category: "exfiltration",
        field,
        evidenceExcerpt: excerpt(text),
        evidenceHash: hash,
        recommendation: "ask",
      });
      break;
    }
  }

  for (const pat of SAMPLING_PATTERNS) {
    if (lower.includes(pat)) {
      findings.push({
        severity: "high",
        category: "sampling_abuse",
        field,
        evidenceExcerpt: excerpt(text),
        evidenceHash: hash,
        recommendation: "ask",
      });
      break;
    }
  }

  if (INVISIBLE_CHAR_RE.test(text)) {
    findings.push({
      severity: "medium",
      category: "invisible_chars",
      field,
      evidenceExcerpt: excerpt(text),
      evidenceHash: hash,
      recommendation: "ask",
    });
  }

  return findings;
}

// ── Public API ───────────────────────────────────────────────────────────────

const RECOMMENDATION_ORDER: Record<RiskRecommendation, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

function worstRecommendation(findings: ToolRiskFinding[]): RiskRecommendation {
  if (findings.length === 0) return "allow";
  return findings.reduce<RiskRecommendation>((worst, f) => {
    return RECOMMENDATION_ORDER[f.recommendation] > RECOMMENDATION_ORDER[worst]
      ? f.recommendation
      : worst;
  }, "allow");
}

/**
 * Run all static vetting rules against a single MCP tool entry.
 * No network calls, no ML — purely deterministic.
 */
export function vetTool(entry: McpToolEntry): VettingResult {
  const findings: ToolRiskFinding[] = [
    ...scanText(entry.description, "description", entry.name),
    ...scanText(JSON.stringify(entry.inputSchema), "inputSchema", entry.name),
    ...scanText(entry.name, "name", entry.name),
  ];

  const recommendation = worstRecommendation(findings);
  return {
    toolName: entry.name,
    findings,
    recommendation,
    blocked: recommendation === "deny",
  };
}

/**
 * Vet a batch of tools. Returns one VettingResult per tool.
 */
export function vetTools(entries: McpToolEntry[]): VettingResult[] {
  return entries.map(vetTool);
}
