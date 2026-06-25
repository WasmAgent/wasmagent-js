/**
 * Compile CapabilityManifest → trace validator spec.
 *
 * A TraceValidatorSpec is a set of deterministic checks that can be run
 * against a recorded rollout trace to verify the agent respected the manifest.
 *
 * Used by evomerge evidence gate: traces that violate the manifest are
 * downgraded from "admitted" to "diagnostic" and flagged for review.
 */

import type { CapabilityManifest } from "@wasmagent/core";

export interface TraceViolation {
  ruleId: string;
  stepIndex: number;
  toolName: string;
  description: string;
  severity: "error" | "warning";
}

export interface TraceValidatorSpec {
  manifestSummary: string;
  /** Validate a flat list of ADP-style step dicts. Returns violations found. */
  validate(steps: TraceStep[]): TraceViolation[];
}

export interface TraceStep {
  step_index: number;
  role: string;
  tool_name: string | null;
  tool_args: Record<string, unknown> | null;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Compile a CapabilityManifest into a TraceValidatorSpec.
 */
export function compileToTraceValidator(manifest: CapabilityManifest): TraceValidatorSpec {
  const manifestSummary = `network:${manifest.allowedHosts.length === 0 ? "none" : manifest.allowedHosts.join(",")}`;

  function validate(steps: TraceStep[]): TraceViolation[] {
    const violations: TraceViolation[] = [];

    for (const step of steps) {
      if (step.role !== "agent" || !step.tool_name) continue;

      const args = step.tool_args ?? {};
      const toolLower = step.tool_name.toLowerCase();

      // Network check
      const urlArg = findUrlArg(args);
      if (urlArg) {
        const host = extractHost(urlArg);
        if (host) {
          if (manifest.allowedHosts.length === 0) {
            violations.push({
              ruleId: "network:deny-all",
              stepIndex: step.step_index,
              toolName: step.tool_name,
              description: `Network call to ${host} but manifest denies all network access`,
              severity: "error",
            });
          } else if (!manifest.allowedHosts.includes(host)) {
            violations.push({
              ruleId: "network:host-not-allowed",
              stepIndex: step.step_index,
              toolName: step.tool_name,
              description: `Host ${host} not in manifest allowedHosts`,
              severity: "error",
            });
          }
        }
      }

      // Write path check
      const pathArg = findPathArg(args);
      if (
        pathArg &&
        (toolLower.includes("write") || toolLower.includes("delete") || toolLower.includes("patch"))
      ) {
        if (manifest.allowedWritePaths.length === 0) {
          violations.push({
            ruleId: "fs:deny-write",
            stepIndex: step.step_index,
            toolName: step.tool_name,
            description: `Write to ${pathArg} but manifest denies all write access`,
            severity: "error",
          });
        } else if (!manifest.allowedWritePaths.some((p) => pathArg.startsWith(p))) {
          violations.push({
            ruleId: "fs:write-path-violation",
            stepIndex: step.step_index,
            toolName: step.tool_name,
            description: `Path ${pathArg} outside manifest allowedWritePaths`,
            severity: "error",
          });
        }
      }

      // Env access check — if tool is trying to read env vars
      if (toolLower.includes("env") || toolLower.includes("secret")) {
        violations.push({
          ruleId: "env:suspicious-tool",
          stepIndex: step.step_index,
          toolName: step.tool_name,
          description: `Tool name suggests env/secret access — verify against manifest`,
          severity: "warning",
        });
      }
    }

    return violations;
  }

  return { manifestSummary, validate };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findUrlArg(args: Record<string, unknown>): string | null {
  for (const key of ["url", "href", "endpoint", "host", "baseUrl", "base_url"]) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return null;
}

function findPathArg(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file", "filepath", "file_path", "dest", "destination"]) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return null;
}

function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
