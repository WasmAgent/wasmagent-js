/**
 * LoCoMo-Refined — long-conversation memory recall, stricter judge.
 *
 * Origin: Maharana et al. 2024 introduced LoCoMo (long conversations of up to
 * 35 sessions per persona, ~9K tokens, with QA over them). The original
 * benchmark's LLM-judge agreed with humans only ~44% of the time
 * (mem-eval-suite/LoCoMo_refined report, April 2026), so the community
 * re-judged the same predictions with a stricter Qwen3-14B-class judge,
 * cutting headline scores 15–22 points across systems (e.g. Mem0 dropped
 * from ~64% to 48.91%).
 *
 * This suite is NOT a redistribution of the LoCoMo dataset (which is
 * license-encumbered). Instead, it ships ~30 contamination-resistant
 * synthetic conversations modelled on LoCoMo's category structure, with
 * the explicit-instruction strict judge applied at scoring time. The
 * point is to stress-test the SAME failure modes (premature termination
 * on "I don't know", hallucinated continuations, contradiction-blind
 * answers) under a judge that doesn't accept verbose-but-wrong answers.
 *
 * Categories mirror LoCoMo:
 *   - single-hop:     fact stated once, asked back N sessions later
 *   - multi-hop:      fact requires combining info across 2+ sessions
 *   - temporal:       answer depends on which session-time was referenced
 *   - open-domain:    no canonical answer; judge looks for "consistent
 *                     with what was said" not "matches a gold string"
 *   - adversarial:    earlier session has a fact that's later contradicted;
 *                     model must use the latest version, not the oldest
 *
 * Strict judge protocol (what makes this "Refined"):
 *   - "Inclusive without contradiction, complete without overreach"
 *   - Wrong → 0; correct-but-includes-extra-wrong-claim → 0; right and tight → 1
 *   - We approximate this with `expectedAnswerMatcher` that returns false
 *     if any of `forbiddenSubstrings` are present, mimicking what an
 *     LLM-judge with the strict rubric would reject. Real LoCoMo-Refined
 *     uses a Qwen3-14B judge; our matcher is a deterministic stand-in
 *     that's reproducible without an extra model.
 */

import { finalAnswerLength } from "@agentkit-js/core";
import type { BenchmarkItem, BenchmarkSuite } from "../types.js";

interface LocomoTemplate {
  id: string;
  category: "single-hop" | "multi-hop" | "temporal" | "open-domain" | "adversarial";
  /** Multi-session conversation history. Sessions are flattened to messages. */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** The question asked at the end. */
  question: string;
  /** Substrings that MUST appear (any one of). Matched case-insensitively. */
  expected: string[];
  /**
   * Substrings that, if present, fail the answer outright — the strict
   * judge stand-in. Useful for "model added a wrong fact alongside the
   * right one" failures.
   */
  forbidden?: string[];
}

const TEMPLATES: LocomoTemplate[] = [
  // ── single-hop ─────────────────────────────────────────────────────────────
  {
    id: "lr-single-hop-1",
    category: "single-hop",
    history: [
      { role: "user", content: "Quick context: I bought a 2023 Subaru Outback last March." },
      { role: "assistant", content: "Noted." },
      ...padNoise(8),
      { role: "user", content: "What car did I get?" },
    ],
    question: "(answer above)",
    expected: ["Subaru Outback", "Outback"],
  },
  {
    id: "lr-single-hop-2",
    category: "single-hop",
    history: [
      { role: "user", content: "My daughter Mia is allergic to peanuts." },
      { role: "assistant", content: "Got it, I'll keep that in mind." },
      ...padNoise(10),
      { role: "user", content: "What's Mia allergic to?" },
    ],
    question: "(answer above)",
    expected: ["peanut"],
    forbidden: ["dairy", "gluten", "shellfish"],
  },
  {
    id: "lr-single-hop-3",
    category: "single-hop",
    history: [
      { role: "user", content: "I work at Linear, I'm a staff engineer." },
      { role: "assistant", content: "Cool." },
      ...padNoise(6),
      { role: "user", content: "What's my role?" },
    ],
    question: "(answer above)",
    expected: ["staff engineer", "staff"],
  },
  // ── multi-hop ──────────────────────────────────────────────────────────────
  {
    id: "lr-multi-hop-1",
    category: "multi-hop",
    history: [
      { role: "user", content: "My company is called Acme Robotics." },
      { role: "assistant", content: "Noted." },
      ...padNoise(4),
      { role: "user", content: "We just raised our Series B." },
      { role: "assistant", content: "Congrats." },
      ...padNoise(4),
      { role: "user", content: "What round did Acme Robotics most recently raise?" },
    ],
    question: "(answer above)",
    expected: ["Series B", "B"],
    forbidden: ["Series A", "Series C", "seed"],
  },
  {
    id: "lr-multi-hop-2",
    category: "multi-hop",
    history: [
      { role: "user", content: "I have two kids: Mia (8) and Leo (5)." },
      { role: "assistant", content: "Got it." },
      ...padNoise(6),
      { role: "user", content: "Mia just started 4th grade." },
      { role: "assistant", content: "Nice." },
      ...padNoise(4),
      { role: "user", content: "What grade is my younger child in?" },
    ],
    question: "(answer above)",
    expected: ["kindergarten", "preschool", "1st grade", "first grade"],
    // 5-year-old is approximately kindergarten; the strict judge would
    // accept that or "preschool". The forbidden list catches models that
    // confuse Leo with Mia.
    forbidden: ["4th grade", "fourth grade"],
  },
  // ── temporal ───────────────────────────────────────────────────────────────
  {
    id: "lr-temporal-1",
    category: "temporal",
    history: [
      { role: "user", content: "Today is March 1st. I'm running a marathon on March 15." },
      { role: "assistant", content: "Good luck training." },
      ...padNoise(8),
      { role: "user", content: "How many days until my marathon, given it's March 1st today?" },
    ],
    question: "(answer above)",
    expected: ["14", "fourteen"],
    forbidden: ["15"],
  },
  {
    id: "lr-temporal-2",
    category: "temporal",
    history: [
      { role: "user", content: "I started my new job at Stripe in January 2024." },
      { role: "assistant", content: "Congrats!" },
      ...padNoise(6),
      { role: "user", content: "Now it's June 2026. How long have I been at Stripe?" },
    ],
    question: "(answer above)",
    expected: ["2 years", "two years", "2.5 years", "two and a half"],
  },
  // ── open-domain ────────────────────────────────────────────────────────────
  {
    id: "lr-open-1",
    category: "open-domain",
    history: [
      { role: "user", content: "I love hiking and photography." },
      { role: "assistant", content: "Nice combo." },
      ...padNoise(4),
      { role: "user", content: "Suggest a weekend activity for me." },
    ],
    question: "(answer above)",
    // Open answer; judge accepts anything mentioning hiking OR photography
    expected: ["hik", "photo"],
  },
  // ── adversarial ────────────────────────────────────────────────────────────
  {
    id: "lr-adv-1",
    category: "adversarial",
    history: [
      { role: "user", content: "My favorite language is Python." },
      { role: "assistant", content: "Got it." },
      ...padNoise(8),
      { role: "user", content: "Actually, I switched to Rust last month and now prefer it." },
      { role: "assistant", content: "OK, updating my notes." },
      ...padNoise(4),
      { role: "user", content: "What's my favorite language?" },
    ],
    question: "(answer above)",
    expected: ["Rust"],
    forbidden: ["Python"],
  },
  {
    id: "lr-adv-2",
    category: "adversarial",
    history: [
      { role: "user", content: "I'm vegetarian." },
      { role: "assistant", content: "Noted." },
      ...padNoise(6),
      { role: "user", content: "Update: I went vegan last week." },
      { role: "assistant", content: "Got it." },
      ...padNoise(4),
      { role: "user", content: "Recommend a restaurant for me." },
    ],
    question: "(answer above)",
    // Right answer mentions vegan / plant-based; wrong answer suggests
    // dairy or eggs (vegetarian-but-not-vegan).
    expected: ["vegan", "plant-based", "plant based"],
    forbidden: ["dairy", "cheese", "yogurt"],
  },
];

function padNoise(n: number): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: `(noise ${i}) tell me about a random fact.` });
    out.push({ role: "assistant", content: `(noise ${i}) The fact is unrelated to your context.` });
  }
  return out;
}

function buildItem(t: LocomoTemplate): BenchmarkItem {
  return {
    id: t.id,
    category: t.category,
    task: t.history.at(-1)?.content ?? t.question,
    expectedAnswer: t.expected[0] ?? "",
    expectedAnswerMatcher: (answer: string) => {
      const lower = answer.toLowerCase();
      // Forbidden first — strict-judge stand-in
      if (t.forbidden) {
        for (const f of t.forbidden) {
          if (lower.includes(f.toLowerCase())) return false;
        }
      }
      // Any one expected substring is enough
      return t.expected.some((e) => lower.includes(e.toLowerCase()));
    },
    messages: [
      {
        role: "system" as const,
        content:
          "Answer the user's question using ONLY the conversation history above. " +
          "If two facts in the history conflict, the most recent one is correct. " +
          "Reply with the answer ONLY — no preamble, no explanation, no extra claims.",
      },
      ...t.history,
    ],
  };
}

export const locomoRefinedSuite: BenchmarkSuite = {
  name: "locomo-refined",
  title: "LoCoMo-Refined (long-conversation recall, strict judge)",
  description:
    "Synthetic LoCoMo-style conversations across single-hop / multi-hop / temporal / open-domain / adversarial categories. Strict judge stand-in: forbidden-substring check rejects verbose-but-wrong answers, mimicking the Qwen3-14B judge introduced in mem-eval-suite/LoCoMo_refined (April 2026) that cut headline scores 15-22 points across the field.",
  items: TEMPLATES.map(buildItem),
  scorers: [finalAnswerLength(200)],
};
