/**
 * Taint tracking — mark tool outputs as untrusted observations.
 *
 * Prevents tool results from being re-interpreted as agent instructions
 * by wrapping them in a typed boundary before prompt assembly.
 */

export type TrustLevel = "untrusted" | "verified" | "system";
export type ContentType = "text" | "json" | "html" | "markdown" | "binary_ref";

/**
 * Semantic taint labels that describe the origin or sensitivity of data.
 * Multiple labels may coexist on a single observation.
 */
export type TaintLabel =
  | "user_supplied"
  | "tool_supplied"
  | "external_network"
  | "secret"
  | "credential"
  | "filesystem"
  | "untrusted_descriptor"
  | "generated_code"
  | "cross_tenant";

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
  /** Adversarial classifier score from evaluateAdversarial() (0..1). */
  adversarialScore: number;
  /** Semantic taint labels. Empty = no specific labels assigned. */
  taintLabels: TaintLabel[];
}

/**
 * Structured JSON output of renderTaintedObservation.
 * The raw content is base64-encoded to prevent any re-interpretation as instructions.
 */
export interface RenderedTaintedObservation {
  trust: TrustLevel;
  tool: string;
  content_b64: string;
}

import { createHash } from "node:crypto";
import { evaluateAdversarial } from "./vetting.js";

/** Regex whitelist for tool names used in renderTaintedObservation. */
const SAFE_TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/;

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
  opts?: { trust?: TrustLevel; sanitizers?: string[]; taintLabels?: TaintLabel[] }
): TaintedObservation {
  const hash = createHash("sha256").update(rawContent, "utf8").digest("hex").slice(0, 64);
  const patternMatch = detectInstructionLike(rawContent);
  const adversarial = evaluateAdversarial(rawContent);
  return {
    sourceTool,
    trust: opts?.trust ?? "untrusted",
    contentType: detectContentType(rawContent),
    contentHash: hash,
    sanitizers: opts?.sanitizers ?? [],
    instructionLikeTextDetected: patternMatch || adversarial.score > 0.5,
    adversarialScore: adversarial.score,
    taintLabels: opts?.taintLabels ?? [],
  };
}

/**
 * Create a new TaintedObservation that inherits taint labels from a source.
 * Models: label applied to source → label must propagate to derived data.
 */
export function propagateTaint(
  source: TaintedObservation,
  derivedTool: string,
  derivedContent: string,
  opts?: { additionalLabels?: TaintLabel[]; trust?: TrustLevel }
): TaintedObservation {
  return taintObservation(derivedTool, derivedContent, {
    trust: opts?.trust ?? source.trust,
    taintLabels: [...source.taintLabels, ...(opts?.additionalLabels ?? [])],
  });
}

/**
 * Returns true if the observation carries any taint that warrants scrutiny:
 * explicit semantic labels, detected instruction-like text, or a high
 * adversarial score.
 */
export function isTainted(obs: TaintedObservation): boolean {
  return obs.taintLabels.length > 0 || obs.instructionLikeTextDetected || obs.adversarialScore > 0.5;
}

/**
 * Render a `TaintedObservation` as a JSON structure for prompt assembly.
 *
 * The raw content is base64-encoded so that any embedded instruction strings
 * (e.g. "<trust=verified>", "ignore previous instructions") cannot be
 * misinterpreted by an LLM reading the serialized output.
 *
 * The tool name is validated against a safe-identifier whitelist before
 * inclusion; an invalid name is replaced with "<invalid_tool_name>".
 *
 * Returns a `RenderedTaintedObservation` object. Callers that need a string
 * for prompt assembly should use `JSON.stringify(renderTaintedObservation(...))`.
 */
export function renderTaintedObservation(
  obs: TaintedObservation,
  rawContent: string
): RenderedTaintedObservation {
  const safeTool = SAFE_TOOL_NAME_RE.test(obs.sourceTool) ? obs.sourceTool : "<invalid_tool_name>";
  const content_b64 = Buffer.from(rawContent, "utf8").toString("base64");
  return {
    trust: obs.trust,
    tool: safeTool,
    content_b64,
  };
}
