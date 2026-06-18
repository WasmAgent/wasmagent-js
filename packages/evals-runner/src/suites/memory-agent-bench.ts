/**
 * MemoryAgentBench — 4-competency agent memory eval.
 *
 * Origin: HUST-AI-HYZ/MemoryAgentBench (ICLR 2026). Defines four
 * competency axes for agent memory:
 *
 *   AR  — Accurate Retrieval:    can the agent fetch a specific fact
 *                                that was injected once, far back?
 *   TTL — Test-Time Learning:    can it learn from in-context examples
 *                                and apply them?
 *   LRU — Long-Range Understanding: can it reason about long sequences
 *                                of events (causality, ordering)?
 *   CR  — Conflict Resolution:   when sources contradict, which wins?
 *
 * "Inject once, query many" design — the conversation history is dosed
 * with facts at known positions, then a barrage of queries tests each
 * competency on that same dosed history. agentkit's adaptation: each
 * item carries a single canonical query (one shot per item), but the
 * 4 competencies are represented as separate items rather than separate
 * queries on shared histories. This trades data efficiency for
 * compatibility with the existing `BenchmarkItem` shape.
 *
 * Like locomo-refined, this is NOT a verbatim port of the
 * MemoryAgentBench dataset (license + size). It's a 20-item synthetic
 * suite modelled on the same 4 competencies, useful for sanity-checking
 * a memory-equipped agent before plugging in the real dataset.
 */

import { finalAnswerLength } from "@wasmagent/core";
import type { BenchmarkItem, BenchmarkSuite } from "../types.js";

interface MABTemplate {
  id: string;
  competency: "AR" | "TTL" | "LRU" | "CR";
  history: Array<{ role: "user" | "assistant"; content: string }>;
  query: string;
  expected: string[];
  forbidden?: string[];
}

const TEMPLATES: MABTemplate[] = [
  // ── AR — Accurate Retrieval (5) ───────────────────────────────────────────
  {
    id: "mab-AR-1",
    competency: "AR",
    history: [
      { role: "user", content: "My WiFi password is `bluedolphin42`." },
      { role: "assistant", content: "Stored." },
      ...noise(15),
    ],
    query: "What's my WiFi password?",
    expected: ["bluedolphin42"],
    forbidden: ["dolphinblue", "bluefish"],
  },
  {
    id: "mab-AR-2",
    competency: "AR",
    history: [
      { role: "user", content: "Office hours: Tuesdays 2–4pm." },
      { role: "assistant", content: "Got it." },
      ...noise(12),
    ],
    query: "When are office hours?",
    expected: ["Tuesday", "2", "4"],
  },
  {
    id: "mab-AR-3",
    competency: "AR",
    history: [
      { role: "user", content: "Order ID 9472-X. ETA Friday." },
      { role: "assistant", content: "Logged." },
      ...noise(20),
    ],
    query: "What's the order ID?",
    expected: ["9472-X", "9472"],
  },
  {
    id: "mab-AR-4",
    competency: "AR",
    history: [
      { role: "user", content: "API endpoint: https://api.acme.io/v3/widgets" },
      { role: "assistant", content: "Cached." },
      ...noise(18),
    ],
    query: "What was that API endpoint URL?",
    expected: ["api.acme.io/v3/widgets", "/v3/widgets"],
  },
  {
    id: "mab-AR-5",
    competency: "AR",
    history: [
      { role: "user", content: "PIN for the safe is 8321." },
      { role: "assistant", content: "Got it." },
      ...noise(25),
    ],
    query: "What's the safe PIN?",
    expected: ["8321"],
    forbidden: ["1238", "8231"],
  },
  // ── TTL — Test-Time Learning (5) ──────────────────────────────────────────
  {
    id: "mab-TTL-1",
    competency: "TTL",
    history: [
      {
        role: "user",
        content:
          "I'll teach you a code: when I say 'red', I mean priority 1. " +
          "When I say 'amber', priority 2. When I say 'green', priority 3.",
      },
      { role: "assistant", content: "Understood." },
      ...noise(8),
    ],
    query: "What priority is 'amber' in my code?",
    expected: ["2", "two"],
    forbidden: ["1", "3"],
  },
  {
    id: "mab-TTL-2",
    competency: "TTL",
    history: [
      {
        role: "user",
        content:
          "Custom abbreviations for our team: ENG = engineering, OPS = operations, BIZ = business.",
      },
      { role: "assistant", content: "Saved." },
      ...noise(10),
    ],
    query: "What does OPS stand for in our team's vocabulary?",
    expected: ["operation"],
    forbidden: ["engineering", "business"],
  },
  {
    id: "mab-TTL-3",
    competency: "TTL",
    history: [
      {
        role: "user",
        content:
          "Project naming convention: <client>-<year>-<sequence>. " +
          "Example: acme-2024-001 was our first Acme project of 2024.",
      },
      { role: "assistant", content: "Got it." },
      ...noise(6),
    ],
    query: "What would be the third Acme project of 2025 named?",
    expected: ["acme-2025-003"],
  },
  {
    id: "mab-TTL-4",
    competency: "TTL",
    history: [
      {
        role: "user",
        content:
          "Convention: I write 'ETA T+N' to mean 'expected in N business days'. " +
          "So 'ETA T+3' means 3 business days from now.",
      },
      { role: "assistant", content: "Understood." },
      ...noise(8),
    ],
    query: "If I say 'ETA T+5', when do I expect it?",
    expected: ["5 business days", "five business days", "5 days"],
  },
  {
    id: "mab-TTL-5",
    competency: "TTL",
    history: [
      {
        role: "user",
        content:
          "Use these temperature labels: 'cold' = below 50F, 'mild' = 50-70F, 'warm' = 70-85F, 'hot' = above 85F.",
      },
      { role: "assistant", content: "Saved." },
      ...noise(10),
    ],
    query: "What label do I use for 75F?",
    expected: ["warm"],
    forbidden: ["mild", "hot", "cold"],
  },
  // ── LRU — Long-Range Understanding (5) ────────────────────────────────────
  {
    id: "mab-LRU-1",
    competency: "LRU",
    history: [
      { role: "user", content: "Step 1: I went to the bank." },
      { role: "assistant", content: "OK." },
      ...noise(4),
      { role: "user", content: "Step 2: I deposited a check." },
      { role: "assistant", content: "OK." },
      ...noise(4),
      { role: "user", content: "Step 3: I drove to the airport." },
      { role: "assistant", content: "OK." },
      ...noise(4),
    ],
    query: "What did I do between the bank and the airport?",
    expected: ["deposit", "check"],
  },
  {
    id: "mab-LRU-2",
    competency: "LRU",
    history: [
      { role: "user", content: "Met Alice in 2020." },
      { role: "assistant", content: "OK." },
      ...noise(4),
      { role: "user", content: "Hired Alice in 2022." },
      { role: "assistant", content: "OK." },
      ...noise(4),
      { role: "user", content: "Promoted Alice in 2024." },
      { role: "assistant", content: "OK." },
      ...noise(4),
    ],
    query: "How many years did it take from meeting Alice to promoting her?",
    expected: ["4 years", "four years", "4"],
  },
  {
    id: "mab-LRU-3",
    competency: "LRU",
    history: [
      { role: "user", content: "Books I read this year, in order: Dune, Foundation, Hyperion." },
      { role: "assistant", content: "Logged." },
      ...noise(10),
    ],
    query: "What was the second book I read this year?",
    expected: ["Foundation"],
    forbidden: ["Dune", "Hyperion"],
  },
  {
    id: "mab-LRU-4",
    competency: "LRU",
    history: [
      {
        role: "user",
        content: "I went to Tokyo, then Seoul, then Bangkok, then Singapore on my trip.",
      },
      { role: "assistant", content: "Sounds great." },
      ...noise(8),
    ],
    query: "What was the last city before Singapore?",
    expected: ["Bangkok"],
    forbidden: ["Tokyo", "Seoul"],
  },
  {
    id: "mab-LRU-5",
    competency: "LRU",
    history: [
      { role: "user", content: "First I bought eggs. Then milk. Then bread. Then I went home." },
      { role: "assistant", content: "Got it." },
      ...noise(6),
    ],
    query: "What was the second thing I bought?",
    expected: ["milk"],
    forbidden: ["eggs", "bread"],
  },
  // ── CR — Conflict Resolution (5) ──────────────────────────────────────────
  {
    id: "mab-CR-1",
    competency: "CR",
    history: [
      { role: "user", content: "My phone number is 555-0100." },
      { role: "assistant", content: "OK." },
      ...noise(6),
      { role: "user", content: "Update: my new phone number is 555-0200." },
      { role: "assistant", content: "Updated." },
      ...noise(4),
    ],
    query: "What's my phone number?",
    expected: ["555-0200"],
    forbidden: ["555-0100"],
  },
  {
    id: "mab-CR-2",
    competency: "CR",
    history: [
      { role: "user", content: "I live in Seattle." },
      { role: "assistant", content: "OK." },
      ...noise(8),
      { role: "user", content: "I moved to Portland last month." },
      { role: "assistant", content: "Updated." },
      ...noise(4),
    ],
    query: "Where do I live?",
    expected: ["Portland"],
    forbidden: ["Seattle"],
  },
  {
    id: "mab-CR-3",
    competency: "CR",
    history: [
      { role: "user", content: "Project deadline: October 1." },
      { role: "assistant", content: "OK." },
      ...noise(6),
      { role: "user", content: "Deadline pushed to November 15." },
      { role: "assistant", content: "Updated." },
      ...noise(4),
    ],
    query: "When is the project deadline?",
    expected: ["November 15", "Nov 15"],
    forbidden: ["October 1", "Oct 1"],
  },
  {
    id: "mab-CR-4",
    competency: "CR",
    history: [
      { role: "user", content: "I'm allergic to cats." },
      { role: "assistant", content: "Noted." },
      ...noise(6),
      {
        role: "user",
        content: "Correction: I was misdiagnosed. I'm actually allergic to dogs, not cats.",
      },
      { role: "assistant", content: "Updated." },
      ...noise(4),
    ],
    query: "What am I allergic to?",
    expected: ["dog"],
    forbidden: ["cat"],
  },
  {
    id: "mab-CR-5",
    competency: "CR",
    history: [
      { role: "user", content: "I drive a Tesla Model 3." },
      { role: "assistant", content: "OK." },
      ...noise(8),
      { role: "user", content: "Sold the Tesla. Now I drive a Toyota Prius." },
      { role: "assistant", content: "Updated." },
      ...noise(4),
    ],
    query: "What car do I currently drive?",
    expected: ["Prius", "Toyota"],
    forbidden: ["Tesla", "Model 3"],
  },
];

function noise(n: number): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: `(noise ${i}) random topic chatter.` });
    out.push({ role: "assistant", content: `(noise ${i}) acknowledged.` });
  }
  return out;
}

function buildItem(t: MABTemplate): BenchmarkItem {
  return {
    id: t.id,
    category: t.competency,
    task: t.query,
    expectedAnswer: t.expected[0] ?? "",
    expectedAnswerMatcher: (answer: string) => {
      const lower = answer.toLowerCase();
      if (t.forbidden) {
        for (const f of t.forbidden) {
          if (lower.includes(f.toLowerCase())) return false;
        }
      }
      return t.expected.some((e) => lower.includes(e.toLowerCase()));
    },
    messages: [
      {
        role: "system" as const,
        content:
          "Use the conversation history to answer. If facts conflict, the most recent one wins. " +
          "Reply with the answer ONLY — no preamble.",
      },
      ...t.history,
      { role: "user" as const, content: t.query },
    ],
  };
}

export const memoryAgentBenchSuite: BenchmarkSuite = {
  name: "memory-agent-bench",
  title: "MemoryAgentBench (4 competencies: AR / TTL / LRU / CR)",
  description:
    "20-item synthetic suite modelled on MemoryAgentBench (HUST-AI-HYZ, ICLR 2026). 5 items per competency: Accurate Retrieval, Test-Time Learning, Long-Range Understanding, Conflict Resolution. Strict judge stand-in via forbidden-substring check.",
  items: TEMPLATES.map(buildItem),
  scorers: [finalAnswerLength(200)],
};
