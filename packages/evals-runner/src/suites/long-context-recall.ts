/**
 * Long-context recall — needle-in-haystack at ~16K context.
 *
 * Inserts a key-value fact at a known depth in a long passage of filler
 * text and asks the model to retrieve the value. Three depth buckets
 * (10%, 50%, 90% through the document) catch models that work well at
 * boundaries but lose mid-context items — the classic "lost in the
 * middle" failure mode.
 */

import { exactMatch } from "@wasmagent/core/beta";
import type { BenchmarkItem, BenchmarkSuite } from "../types.js";

/**
 * Generate a haystack with a single needle.
 *
 * The filler is a deterministic seeded pseudo-paragraph generator —
 * variety enough that the needle stands out only by its content, not by
 * being the only "real" sentence. Length tuned to ~16K tokens (~64K
 * chars) at default `paragraphs=200`.
 */
function buildHaystack(
  needle: string,
  depth: number, // 0..1 fraction
  paragraphs = 200,
  seed = 0
): string {
  const filler = [
    "The seasonal rotation of the magnetosphere produces measurable shifts in atmospheric pressure across all temperate latitudes.",
    "A consortium of regional grain cooperatives has historically resisted attempts to standardise the moisture-content reporting threshold.",
    "Late-medieval astronomical instruments preserved at the Greenwich annex include three previously uncatalogued nocturnals.",
    "Biofilm formation on stainless-steel surfaces is governed primarily by the substrate's microscopic surface roughness rather than its bulk composition.",
    "Following the 2003 charter revision, the city's transit authority retained the right to operate cross-jurisdictional shuttle service in perpetuity.",
    "Small-scale luthiers in the upper Loire valley have largely abandoned wild-pear back plates in favour of imported Rocky Mountain spruce.",
    "Quarterly inventory audits at the Brussels facility consistently overestimate cycle-stock by approximately 4.2 percent due to a known formula error.",
  ] as const;
  let s = seed;
  function rng() {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const out: string[] = [];
  const insertAt = Math.floor(depth * paragraphs);
  for (let i = 0; i < paragraphs; i++) {
    if (i === insertAt) {
      out.push(needle);
    } else {
      const idx = Math.floor(rng() * filler.length);
      out.push(filler[idx] ?? filler[0]);
    }
  }
  return out.join("\n\n");
}

const ITEMS: BenchmarkItem[] = [
  {
    id: "needle-shallow",
    category: "long-context",
    task: "What is the secret access code?",
    expectedAnswer: "mango-1729",
    expectedAnswerMatcher: (a) => /\bmango[-\s]?1729\b/i.test(a),
    messages: [
      {
        role: "system",
        content:
          "Read the document below carefully. Then answer the question by quoting the relevant fact. Reply with the answer ONLY.",
      },
      {
        role: "user",
        content:
          "Document:\n\n" +
          buildHaystack("The secret access code for this run is mango-1729.", 0.1, 200, 1) +
          "\n\nQuestion: What is the secret access code?",
      },
    ],
  },
  {
    id: "needle-middle",
    category: "long-context",
    task: "What is the customer's preferred contact method?",
    expectedAnswer: "carrier pigeon",
    expectedAnswerMatcher: (a) => /\bcarrier\s+pigeon\b/i.test(a),
    messages: [
      {
        role: "system",
        content:
          "Read the document below carefully. Then answer the question by quoting the relevant fact. Reply with the answer ONLY.",
      },
      {
        role: "user",
        content:
          "Document:\n\n" +
          buildHaystack(
            "The customer has explicitly noted that their preferred contact method is carrier pigeon.",
            0.5,
            200,
            2
          ) +
          "\n\nQuestion: What is the customer's preferred contact method?",
      },
    ],
  },
  {
    id: "needle-deep",
    category: "long-context",
    task: "What is the launch window for the Hipparchus probe?",
    expectedAnswer: "april 7",
    expectedAnswerMatcher: (a) => /april\s*7|07\s*april|7\s*april/i.test(a),
    messages: [
      {
        role: "system",
        content:
          "Read the document below carefully. Then answer the question by quoting the relevant fact. Reply with the answer ONLY.",
      },
      {
        role: "user",
        content:
          "Document:\n\n" +
          buildHaystack(
            "The Hipparchus probe is scheduled for launch on April 7 of the following year.",
            0.9,
            200,
            3
          ) +
          "\n\nQuestion: What is the launch window for the Hipparchus probe?",
      },
    ],
  },
];

export const longContextRecallSuite: BenchmarkSuite = {
  name: "long-context-recall",
  title: "Long-context needle-in-haystack (3 depths × ~16K tokens)",
  description:
    "A single fact is inserted at 10%, 50%, or 90% depth in a ~16K-token document of filler. Detects 'lost in the middle' failures common in mid-size models with short effective context.",
  items: ITEMS,
  scorers: [exactMatch],
};
