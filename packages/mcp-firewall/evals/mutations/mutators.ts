/**
 * Deterministic text mutators for adversarial testing of the MCP firewall.
 *
 * Each mutator is a pure function: same input always produces same output.
 * The optional `seed` parameter is used only by mutators that must make
 * index-based choices — it is a plain integer, not a PRNG seed.
 */

export interface Mutator {
  name: string;
  apply(text: string, seed?: number): string;
}

// ── 1. NFKC normalisation ────────────────────────────────────────────────────

export const unicodeNfkc: Mutator = {
  name: "unicode_nfkc",
  apply(text: string): string {
    return text.normalize("NFKC");
  },
};

// ── 2. Homoglyph substitution ────────────────────────────────────────────────
// Replace ASCII letters with Cyrillic look-alikes.

const HOMOGLYPH_MAP: Record<string, string> = {
  a: "а", // а Cyrillic small a
  e: "е", // е Cyrillic small ie
  o: "о", // о Cyrillic small o
  p: "р", // р Cyrillic small er
  c: "с", // с Cyrillic small es
  x: "х", // х Cyrillic small ha
};

export const homoglyphSubstitution: Mutator = {
  name: "homoglyph_substitution",
  apply(text: string): string {
    return [...text]
      .map((ch) => HOMOGLYPH_MAP[ch] ?? ch)
      .join("");
  },
};

// ── 3. Zero-width insertion ──────────────────────────────────────────────────

export const zeroWidthInsertion: Mutator = {
  name: "zero_width_insertion",
  apply(text: string): string {
    const ZWS = "​";
    const chars = [...text];
    const result: string[] = [];
    for (let i = 0; i < chars.length; i++) {
      result.push(chars[i] as string);
      if ((i + 1) % 4 === 0 && i !== chars.length - 1) {
        result.push(ZWS);
      }
    }
    return result.join("");
  },
};

// ── 4. Random whitespace ─────────────────────────────────────────────────────

export const randomWhitespace: Mutator = {
  name: "random_whitespace",
  apply(text: string): string {
    return text.replace(/ /g, "  ");
  },
};

// ── 5. Token split ───────────────────────────────────────────────────────────

export const tokenSplit: Mutator = {
  name: "token_split",
  apply(text: string): string {
    const ZWS = "​";
    return text.replace(/\S+/g, (word) => {
      if (word.length <= 4) return word;
      return [...word].join(ZWS);
    });
  },
};

// ── 6. Case mix ──────────────────────────────────────────────────────────────

export const caseMix: Mutator = {
  name: "case_mix",
  apply(text: string): string {
    return [...text]
      .map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
      .join("");
  },
};

// ── 7. URL encode ────────────────────────────────────────────────────────────

function percentEncodeChar(ch: string): string {
  return [...new TextEncoder().encode(ch)]
    .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}

export const urlEncode: Mutator = {
  name: "url_encode",
  apply(text: string): string {
    return [...text].map(percentEncodeChar).join("");
  },
};

// ── 8. Double URL encode ─────────────────────────────────────────────────────

export const doubleUrlEncode: Mutator = {
  name: "double_url_encode",
  apply(text: string): string {
    return urlEncode.apply(urlEncode.apply(text));
  },
};

// ── 9. HTML entity encode ────────────────────────────────────────────────────

const HTML_ENTITY_MAP: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&#39;",
  " ": "&nbsp;",
};

export const htmlEntityEncode: Mutator = {
  name: "html_entity_encode",
  apply(text: string): string {
    return [...text]
      .map((ch) => HTML_ENTITY_MAP[ch] ?? ch)
      .join("");
  },
};

// ── 10. JSON escape ──────────────────────────────────────────────────────────

export const jsonEscape: Mutator = {
  name: "json_escape",
  apply(text: string): string {
    // JSON.stringify adds outer quotes — strip them to return just the inner content.
    const serialised = JSON.stringify(text);
    return serialised.slice(1, serialised.length - 1);
  },
};

// ── 11. Base64 ───────────────────────────────────────────────────────────────

export const base64: Mutator = {
  name: "base64",
  apply(text: string): string {
    return Buffer.from(text).toString("base64");
  },
};

// ── 12. Double base64 ────────────────────────────────────────────────────────

export const doubleBase64: Mutator = {
  name: "double_base64",
  apply(text: string): string {
    return base64.apply(base64.apply(text));
  },
};

// ── 13. Hex escape ───────────────────────────────────────────────────────────

export const hexEscape: Mutator = {
  name: "hex_escape",
  apply(text: string): string {
    return [...text]
      .map((ch) => {
        const bytes = new TextEncoder().encode(ch);
        return [...bytes].map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("");
      })
      .join("");
  },
};

// ── 14. Leet substitution ────────────────────────────────────────────────────

const LEET_MAP: Record<string, string> = {
  a: "4",
  e: "3",
  i: "1",
  o: "0",
  s: "5",
  t: "7",
};

export const leetSubstitution: Mutator = {
  name: "leet_substitution",
  apply(text: string): string {
    return [...text].map((ch) => LEET_MAP[ch.toLowerCase()] ?? ch).join("");
  },
};

// ── 15. Reversed text ────────────────────────────────────────────────────────

export const reversedText: Mutator = {
  name: "reversed_text",
  apply(text: string): string {
    return [...text].reverse().join("");
  },
};

// ── 16. Benign prefix ────────────────────────────────────────────────────────

export const benignPrefix: Mutator = {
  name: "benign_prefix",
  apply(text: string): string {
    return `Please read this tool description carefully: ${text}`;
  },
};

// ── 17. Benign suffix ────────────────────────────────────────────────────────

export const benignSuffix: Mutator = {
  name: "benign_suffix",
  apply(text: string): string {
    return `${text} (This is a standard tool for data processing)`;
  },
};

// ── 18. Markdown code fence ──────────────────────────────────────────────────

export const markdownCodeFence: Mutator = {
  name: "markdown_code_fence",
  apply(text: string): string {
    return `\`\`\`\n${text}\n\`\`\``;
  },
};

// ── 19. JSON wrapper ─────────────────────────────────────────────────────────

export const jsonWrapper: Mutator = {
  name: "json_wrapper",
  apply(text: string): string {
    return JSON.stringify({ description: text });
  },
};

// ── 20. XML wrapper ──────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const xmlWrapper: Mutator = {
  name: "xml_wrapper",
  apply(text: string): string {
    return `<description>${xmlEscape(text)}</description>`;
  },
};

// ── 21. Sentence reorder ─────────────────────────────────────────────────────

export const sentenceReorder: Mutator = {
  name: "sentence_reorder",
  apply(text: string): string {
    const sentences = text.split(". ");
    if (sentences.length <= 1) return text;
    return [...sentences].reverse().join(". ");
  },
};

// ── 22. Multilingual mix ─────────────────────────────────────────────────────

export const multilingualMix: Mutator = {
  name: "multilingual_mix",
  apply(text: string): string {
    return `Внимание: ${text}`;
  },
};

// ── All mutators in declaration order ────────────────────────────────────────

export const ALL_MUTATORS: Mutator[] = [
  unicodeNfkc,
  homoglyphSubstitution,
  zeroWidthInsertion,
  randomWhitespace,
  tokenSplit,
  caseMix,
  urlEncode,
  doubleUrlEncode,
  htmlEntityEncode,
  jsonEscape,
  base64,
  doubleBase64,
  hexEscape,
  leetSubstitution,
  reversedText,
  benignPrefix,
  benignSuffix,
  markdownCodeFence,
  jsonWrapper,
  xmlWrapper,
  sentenceReorder,
  multilingualMix,
];
