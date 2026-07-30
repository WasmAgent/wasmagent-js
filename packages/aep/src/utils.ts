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
  /(?:^|[\s_-])convert(?:$|[\s_-])/,
  /(?:^|[\s_-])approve(?:$|[\s_-])/,
  /(?:^|[\s_-])reject(?:$|[\s_-])/,
  /(?:^|[\s_-])insert(?:$|[\s_-])/,
  /(?:^|[\s_-])patch(?:$|[\s_-])/,
  /(?:^|[\s_-])apply(?:$|[\s_-])/,
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
 * Module-level registry of custom stateful verb prefixes registered via
 * `registerStatefulVerbs`. Kept as a `Set<string>` for O(n) lookup —
 * registration is a one-time startup cost.
 */
const customStatefulVerbs: Set<string> = new Set();

/**
 * Register additional verb prefixes that `isStateChangingTool` should treat
 * as state-changing, in addition to the built-in `STATE_CHANGING_PATTERNS`.
 *
 * Eliminates the need to maintain a parallel `MUTATING` Set alongside
 * `isStateChangingTool` — after calling `registerStatefulVerbs` once at
 * startup, `isStateChangingTool` becomes the single source of truth for
 * both AEP evidence classification and application-level audit branching.
 *
 * Verb matching follows the same word-boundary convention as
 * `STATE_CHANGING_PATTERNS`: underscores and hyphens are treated as
 * separators.
 *
 * @param verbs - Array of verb strings (e.g. `["submit", "approve", "run_invoice"]`).
 *
 * @example
 * ```ts
 * import { registerStatefulVerbs, isStateChangingTool } from "@wasmagent/aep";
 *
 * // Register once at application startup
 * registerStatefulVerbs(['submit', 'convert', 'approve', 'reject', 'post', 'run_invoice']);
 *
 * isStateChangingTool({ name: 'submit_pr' })        // → true
 * isStateChangingTool({ name: 'convert_pr_to_po' }) // → true
 * isStateChangingTool({ name: 'run_invoice_batch' }) // → true
 * ```
 */
export function registerStatefulVerbs(verbs: string[]): void {
  for (const verb of verbs) {
    // Normalise to lowercase; keep underscores/hyphens as-is so the
    // pattern builder can treat them as word separators.
    customStatefulVerbs.add(verb.toLowerCase());
  }
}

/**
 * Clear all custom verb registrations added via `registerStatefulVerbs`.
 *
 * Intended for test isolation — call in `afterEach` to reset global state
 * between test cases.
 */
export function clearStatefulVerbs(): void {
  customStatefulVerbs.clear();
}

/** Escape a string for use inside a `RegExp` pattern. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Heuristic: returns true if the tool's name or description suggests it mutates state.
 *
 * Checks the built-in `STATE_CHANGING_PATTERNS` first, then any verbs
 * registered via `registerStatefulVerbs`. This is a best-effort
 * classification. Integrators should override with explicit metadata when
 * available (e.g., MCP tool annotations or a curated allow-list).
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
  if (STATE_CHANGING_PATTERNS.some((p) => p.test(text))) return true;
  if (customStatefulVerbs.size > 0) {
    for (const verb of customStatefulVerbs) {
      const pattern = new RegExp(`(?:^|[\\s_-])${escapeRegex(verb)}(?:$|[\\s_-])`);
      if (pattern.test(text)) return true;
    }
  }
  return false;
}
