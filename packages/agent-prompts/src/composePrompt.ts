/**
 * Prompt composer — combines fragments into a full system prompt.
 *
 * Use this when you want the agentkit conventions (reasoning-first,
 * output contract, error recovery, card blocks) bundled into one prompt
 * along with your own product-specific instructions (persona, tool
 * surface, file conventions, etc.).
 *
 * @example
 *   const prompt = composePrompt({
 *     persona: "You are MyAgent, an expert SQL analyst.",
 *     fragments: [
 *       REASONING_FIRST,
 *       SANDBOX_NODE,
 *       OUTPUT_CONTRACT_STDOUT,
 *       DIAGRAMS_GENERIC,
 *       ERROR_RECOVERY,
 *     ],
 *     trailing: "When in doubt, prefer explicit JOINs over implicit ones.",
 *   });
 */

export interface ComposePromptInput {
  /** Opening line(s). Typically the agent's role / persona declaration. */
  persona?: string;
  /** Ordered list of fragments to include. Each is separated by a blank line. */
  fragments?: string[];
  /** Optional trailing text appended after all fragments. */
  trailing?: string;
}

/**
 * Compose a system prompt from a persona, ordered fragments, and an
 * optional trailing block. Joins everything with double newlines.
 *
 * Empty / undefined sections are skipped — call sites can conditionally
 * include fragments without having to filter null values themselves.
 */
export function composePrompt(input: ComposePromptInput): string {
  const parts: string[] = [];
  if (input.persona?.trim()) parts.push(input.persona.trim());
  for (const f of input.fragments ?? []) {
    if (f?.trim()) parts.push(f.trim());
  }
  if (input.trailing?.trim()) parts.push(input.trailing.trim());
  return parts.join("\n\n");
}
