/**
 * Taint tracking — mark tool outputs as untrusted observations.
 *
 * Prevents tool results from being re-interpreted as agent instructions
 * by wrapping them in a typed boundary before prompt assembly.
 */

export type TrustLevel = "untrusted" | "verified" | "system";
export type ContentType = "text" | "json" | "html" | "markdown" | "binary_ref";

export interface TaintedObservation {
  sourceTool: string;
  trust: TrustLevel;
  contentType: ContentType;
  /** First 64 hex chars of SHA-256 of the raw content. */
  contentHash: string;
  /** Names of sanitizers applied (empty = none). */
  sanitizers: string[];
  /** True if the content contains instruction-like text. */
  instructionLikeTextDetected: boolean;
}

import { createHash } from "node:crypto";

const INSTRUCTION_LIKE_PATTERNS = [
  "you must",
  "you should",
  "ignore previous",
  "your new task",
  "new instruction",
  "system:",
  "<system>",
];

function detectInstructionLike(text: string): boolean {
  const lower = text.toLowerCase();
  return INSTRUCTION_LIKE_PATTERNS.some((p) => lower.includes(p));
}

function detectContentType(content: string): ContentType {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (trimmed.startsWith("<")) return "html";
  if (/^#{1,6}\s/.test(trimmed) || trimmed.includes("**")) return "markdown";
  return "text";
}

/**
 * Wrap a raw tool result string in a `TaintedObservation`.
 *
 * By default all tool results are `untrusted`. Callers can elevate
 * to `verified` after applying their own validation checks.
 */
export function taintObservation(
  sourceTool: string,
  rawContent: string,
  opts?: { trust?: TrustLevel; sanitizers?: string[] }
): TaintedObservation {
  const hash = createHash("sha256").update(rawContent, "utf8").digest("hex").slice(0, 64);
  return {
    sourceTool,
    trust: opts?.trust ?? "untrusted",
    contentType: detectContentType(rawContent),
    contentHash: hash,
    sanitizers: opts?.sanitizers ?? [],
    instructionLikeTextDetected: detectInstructionLike(rawContent),
  };
}

/**
 * Render a `TaintedObservation` as a tagged string for prompt assembly.
 * The tag boundary prevents the model from treating tool output as instructions.
 */
export function renderTaintedObservation(obs: TaintedObservation, rawContent: string): string {
  return [
    `<untrusted_tool_output tool="${obs.sourceTool}" trust="${obs.trust}" content_type="${obs.contentType}">`,
    rawContent,
    `</untrusted_tool_output>`,
  ].join("\n");
}
