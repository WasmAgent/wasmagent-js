/**
 * Auto-upgrade plain AI output to card blocks when the AI didn't follow
 * the card syntax instructions.
 *
 * Strategy: scan top-level fenced code blocks and raw content sections.
 * If we find a D2 diagram or rich Markdown that isn't already wrapped in
 * a card fence, wrap it automatically.
 *
 * Called before {@link parseCardBlocks} — acts as a pre-processor on
 * AI-generated text. Use it in your UI layer when you want resilience
 * against agents that miss the card-block convention.
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

/** Returns true if the text is rich Markdown worth wrapping in a card. */
function looksLikeRichMarkdown(text: string): boolean {
  const t = text.trim();
  // Has at least one heading
  const hasHeading = /^#{1,4}\s+\S/m.test(t);
  // Has a GFM table
  const hasTable = /^\|.+\|$/m.test(t) && /^\|[-: |]+\|$/m.test(t);
  // Has multiple bold/italic markers suggesting formatted doc
  const hasBold = (t.match(/\*\*[^*]+\*\*/g) ?? []).length >= 2;
  return hasHeading || hasTable || (hasBold && t.split("\n").length > 4);
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
 * If the response is entirely rich Markdown (no card fences, no HTML),
 * wrap it in a card:markdown block so it renders as a card.
 */
function upgradeBareMarkdown(text: string): string {
  // Already has card fences → leave it
  if (/```card:/.test(text)) return text;
  // Has HTML → not a Markdown card candidate
  if (/<[a-z][a-z0-9]*[\s>]/i.test(text)) return text;
  // Has code fences for other languages (d2/js/ts/py…) → structural response, leave it
  if (/```[a-z]/.test(text)) return text;

  if (looksLikeRichMarkdown(text)) {
    return `\`\`\`card:markdown\n${text.trim()}\n\`\`\``;
  }
  return text;
}

/**
 * Upgrade plain AI output to use card-block syntax.
 *
 * Three passes (each idempotent and stable):
 *
 * 1. ` ```d2 ` fences → ` ```card:d2 `
 * 2. Bare D2 content (no fences but looks like D2) → wrapped in ` ```card:d2 `
 * 3. Bare rich Markdown (headings/tables/bold) → wrapped in ` ```card:markdown `
 *
 * Already-fenced card blocks, HTML content, and other-language code
 * fences are left untouched.
 */
export function upgradeCardSyntax(text: string): string {
  let result = upgradeD2Fence(text);
  result = upgradeBareD2(result);
  result = upgradeBareMarkdown(result);
  return result;
}
