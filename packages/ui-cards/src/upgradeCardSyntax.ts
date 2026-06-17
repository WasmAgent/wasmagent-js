/**
 * Auto-upgrade plain AI output to card blocks when the AI didn't follow
 * the card syntax instructions.
 *
 * **Cards are reserved for first-class artefacts only — diagrams,
 * documents, presentations, spreadsheets.** Plain Markdown (headings,
 * lists, bold, tables in normal chat replies) renders inline in the
 * chat thread; wrapping it in a card creates a collapsed placeholder
 * that obscures the content.
 *
 * Strategy: scan top-level fenced code blocks and raw content sections.
 * If we find a D2 diagram that isn't already wrapped in a card fence,
 * wrap it automatically. Conversational Markdown is left alone.
 *
 * Called before {@link parseCardBlocks} — acts as a pre-processor on
 * AI-generated text. Use it in your UI layer when you want resilience
 * against agents that miss the card-block convention for diagrams.
 *
 * Historical note (2026-06-17): an earlier version also auto-wrapped
 * any "rich Markdown" (≥1 heading, ≥2 bold spans, etc.) into a
 * `card:markdown` block. That mis-fired on routine chat replies — a
 * "你好" greeting that happened to include a heading-formatted intro
 * was turned into a card placeholder rather than rendered inline. The
 * Markdown auto-wrap was removed; explicit `card:markdown` blocks the
 * agent emits are still parsed and rendered as cards.
 */

/** Returns true if the text looks like D2 diagram source. */
function looksLikeD2(text: string): boolean {
  const t = text.trim();
  // Must have connection arrows
  const hasArrow = /\s*->\s*|\s*<-\s*/.test(t);
  if (!hasArrow) return false;
  // Must have at least 2 lines with identifier-like patterns
  const lines = t.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  const identifierLines = lines.filter(
    (l) => /^[\w一-鿿][\w一-鿿\s]*[:{]/.test(l.trim()) || /->|<-/.test(l)
  );
  return identifierLines.length >= 2;
}

/**
 * Wrap a fenced code block's content in a card fence if it matches D2.
 * Handles ```d2 ... ``` blocks specifically.
 */
function upgradeD2Fence(text: string): string {
  // Replace ```d2 blocks that aren't already ```card:d2
  return text.replace(/```d2\n([\s\S]*?)```/g, (_, body: string) => `\`\`\`card:d2\n${body}\`\`\``);
}

/**
 * Detect if the entire response (or a large portion) is a D2 diagram
 * not wrapped in any fence, and wrap it.
 */
function upgradeBareD2(text: string): string {
  // If the text has no existing ``` fences and looks like D2, wrap the whole thing
  if (!/```/.test(text) && looksLikeD2(text)) {
    return `\`\`\`card:d2\n${text.trim()}\n\`\`\``;
  }
  return text;
}

/**
 * Upgrade plain AI output to use card-block syntax.
 *
 * Two passes (each idempotent and stable):
 *
 * 1. ` ```d2 ` fences → ` ```card:d2 `
 * 2. Bare D2 content (no fences but looks like D2) → wrapped in ` ```card:d2 `
 *
 * Already-fenced card blocks, HTML content, plain Markdown chat
 * replies, and other-language code fences are left untouched. Plain
 * Markdown is rendered inline by the chat UI — cards are reserved
 * for produced artefacts (diagrams, documents, presentations).
 */
export function upgradeCardSyntax(text: string): string {
  let result = upgradeD2Fence(text);
  result = upgradeBareD2(result);
  return result;
}
