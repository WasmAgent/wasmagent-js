/**
 * Utility heuristics for AEP consumers.
 *
 * The `isStateChangingTool()` heuristic helps integrators decide the
 * `state_changing` flag on ActionEvidence without depending on the
 * mcp-firewall package.
 */

/**
 * Regex patterns that indicate a tool mutates external state.
 * Used by `isStateChangingTool()` to classify tools heuristically.
 *
 * Patterns use lookahead/lookbehind for word boundaries that also treat
 * underscores and hyphens as separators (unlike \b which treats _ as word-char).
 */
export const STATE_CHANGING_PATTERNS: RegExp[] = [
  /(?:^|[\s_-])write(?:$|[\s_-])/,
  /(?:^|[\s_-])create(?:$|[\s_-])/,
  /(?:^|[\s_-])delete(?:$|[\s_-])/,
  /(?:^|[\s_-])remove(?:$|[\s_-])/,
  /(?:^|[\s_-])modify(?:$|[\s_-])/,
  /(?:^|[\s_-])update(?:$|[\s_-])/,
  /(?:^|[\s_-])commit(?:$|[\s_-])/,
  /(?:^|[\s_-])push(?:$|[\s_-])/,
  /(?:^|[\s_-])publish(?:$|[\s_-])/,
  /(?:^|[\s_-])deploy(?:$|[\s_-])/,
  /(?:^|[\s_-])execute(?:$|[\s_-])/,
  /(?:^|[\s_-])save(?:$|[\s_-])/,
  /(?:^|[\s_-])send(?:$|[\s_-])/,
  /(?:^|[\s_-])submit(?:$|[\s_-])/,
];

/**
 * Minimal tool descriptor — only the fields needed for the heuristic.
 * Compatible with MCP's McpToolEntry but does not require it.
 */
export interface ToolDescriptor {
  name: string;
  description?: string;
}

/**
 * Heuristic: returns true if the tool's name or description suggests it mutates state.
 *
 * This is a best-effort classification. Integrators should override with explicit
 * metadata when available (e.g., MCP tool annotations or a curated allow-list).
 *
 * @example
 * ```ts
 * import { isStateChangingTool } from "@wasmagent/aep";
 *
 * const stateChanging = isStateChangingTool({ name: "write_file", description: "Writes content to a file" });
 * // stateChanging === true
 * ```
 */
export function isStateChangingTool(tool: ToolDescriptor): boolean {
  const text = (tool.name + " " + (tool.description ?? "")).toLowerCase();
  return STATE_CHANGING_PATTERNS.some((p) => p.test(text));
}
