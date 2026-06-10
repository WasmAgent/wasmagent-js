/**
 * @agentkit-js/ui-cards — Card block parser.
 *
 * Parses ```card:<type>\n...\n``` fenced blocks embedded in AI reply text,
 * producing a structured list of segments (plain text interleaved with cards).
 *
 * Syntax:
 *   ```card:markdown
 *   ## Hello
 *   | col | val |
 *   ```
 *
 *   ```card:d2
 *   direction: right
 *   A -> B -> C
 *   ```
 *
 * The fence opener is /^```card:([\w-]+)(\s.*)?$/ and the closer is /^```\s*$/.
 * Inner fences (e.g. nested code blocks inside a card) are preserved as content
 * using a depth counter.
 */

/** Known first-party card types. Open string type for future extension. */
export type CardType = "markdown" | "d2" | string;

/** A single extracted card block. */
export interface CardBlock {
  /** Stable index-based id, e.g. "card-0", "card-1". */
  id: string;
  type: CardType;
  /** Raw content inside the fence (excluding the opener/closer lines). */
  content: string;
  /** Optional meta string after the type on the opener line, e.g. "my-diagram" in ```card:d2 my-diagram. */
  meta?: string;
}

/** A plain-text segment between (or around) cards. */
export interface TextSegment {
  kind: "text";
  content: string;
}

/** A card segment extracted from the text. */
export interface CardSegment {
  kind: "card";
  card: CardBlock;
}

export type MessageSegment = TextSegment | CardSegment;

/** Result of parsing a message that may contain card blocks. */
export interface ParsedMessage {
  segments: MessageSegment[];
  /** All extracted cards in order, for easy iteration. */
  cards: CardBlock[];
}

const CARD_OPENER = /^```card:([\w-]+)(?:\s+(.*))?$/;
const FENCE_CLOSER = /^```\s*$/;
const INNER_FENCE_OPENER = /^```/;

/**
 * Parse card blocks from an AI reply text.
 *
 * Text outside card fences becomes TextSegment nodes.
 * Each card fence becomes a CardSegment containing a CardBlock.
 *
 * Handles nested inner fences (e.g. ```js code inside a markdown card)
 * by counting depth — only a bare ``` on its own line closes the card.
 */
export function parseCardBlocks(text: string): ParsedMessage {
  const lines = text.split("\n");
  const segments: MessageSegment[] = [];
  const cards: CardBlock[] = [];

  let cardIndex = 0;
  let inCard = false;
  let cardType = "";
  let cardMeta: string | undefined;
  let cardLines: string[] = [];
  let innerDepth = 0;
  let textLines: string[] = [];

  const flushText = () => {
    if (textLines.length === 0) return;
    const content = textLines.join("\n");
    // Only emit non-empty text segments (avoid segments that are only whitespace between cards).
    if (content.trim() || segments.length === 0) {
      segments.push({ kind: "text", content });
    }
    textLines = [];
  };

  for (const line of lines) {
    if (!inCard) {
      const m = CARD_OPENER.exec(line);
      if (m) {
        flushText();
        inCard = true;
        cardType = m[1] ?? "";
        cardMeta = m[2]?.trim() || undefined;
        cardLines = [];
        innerDepth = 0;
      } else {
        textLines.push(line);
      }
    } else {
      if (FENCE_CLOSER.test(line) && innerDepth === 0) {
        // Close this card block.
        const card: CardBlock = {
          id: `card-${cardIndex++}`,
          type: cardType,
          content: cardLines.join("\n"),
          ...(cardMeta !== undefined && { meta: cardMeta }),
        };
        cards.push(card);
        segments.push({ kind: "card", card });
        inCard = false;
        cardType = "";
        cardMeta = undefined;
        cardLines = [];
      } else {
        // Track inner fence depth so nested ``` don't close the card prematurely.
        if (INNER_FENCE_OPENER.test(line)) {
          if (FENCE_CLOSER.test(line)) {
            innerDepth = Math.max(0, innerDepth - 1);
          } else {
            innerDepth++;
          }
        }
        cardLines.push(line);
      }
    }
  }

  // If text stream is cut off mid-card (streaming partial), treat remainder as text.
  if (inCard) {
    textLines.push(`\`\`\`card:${cardType}${cardMeta ? ` ${cardMeta}` : ""}`);
    textLines.push(...cardLines);
  }

  flushText();

  // Deduplicate consecutive empty text segments.
  const deduped = segments.filter((s, i) => {
    if (s.kind !== "text") return true;
    if (!s.content.trim()) {
      const prev = segments[i - 1];
      const next = segments[i + 1];
      // Drop empty text segments sandwiched between two cards.
      if (prev?.kind === "card" && next?.kind === "card") return false;
    }
    return true;
  });

  return { segments: deduped, cards };
}
