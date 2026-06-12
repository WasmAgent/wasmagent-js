/**
 * Multi-turn memory suite — generalised LongMemEval-style fixture.
 *
 * Tests whether a model can recall facts dropped across multiple turns
 * (and across artificially padded "noise" turns) in a conversation. This
 * is the same fixture we used in the 2026-06-12 docs/benchmarks.md
 * cross-model run, refactored into a reusable BenchmarkSuite.
 */

import { exactMatch, finalAnswerLength } from "@agentkit-js/core";
import type { BenchmarkItem, BenchmarkSuite } from "../types.js";

function pad(tail: Array<{ role: "user" | "assistant"; content: string }>) {
  const noise: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = 0; i < 12; i++) {
    noise.push({ role: "user", content: `Noise turn ${i}: ${"x".repeat(200)}` });
    noise.push({ role: "assistant", content: `Acknowledged ${i}.` });
  }
  return [...noise, ...tail];
}

const ITEMS: BenchmarkItem[] = [
  {
    id: "S1",
    category: "single-session-user",
    task: "What breed is my dog?",
    expectedAnswer: "beagle",
    expectedAnswerMatcher: (a) => /\bbeagle\b/i.test(a),
    messages: [
      {
        role: "system",
        content: "Use the conversation history to answer. Reply with the answer ONLY.",
      },
      { role: "user", content: "I just adopted a beagle named Pepper." },
      { role: "assistant", content: "Congrats on adopting Pepper!" },
      { role: "user", content: "She is 14 weeks old today." },
      { role: "assistant", content: "Beagle puppies are full of energy at that age." },
      { role: "user", content: "What breed is my dog?" },
    ],
  },
  {
    id: "S2",
    category: "multi-session",
    task: "When is my birthday?",
    expectedAnswer: "march 12",
    expectedAnswerMatcher: (a) => /march\s*1?2/i.test(a),
    messages: [
      {
        role: "system",
        content: "Use the conversation history to answer. Reply with the answer ONLY.",
      },
      { role: "user", content: "(session 1) My birthday is March 12." },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "(session 2) I live in Singapore." },
      { role: "assistant", content: "Tropical year-round." },
      { role: "user", content: "When is my birthday?" },
    ],
  },
  {
    id: "S3",
    category: "knowledge-update",
    task: "What car do I drive?",
    expectedAnswer: "rivian r1s",
    expectedAnswerMatcher: (a) => /rivian/i.test(a),
    messages: [
      {
        role: "system",
        content: "Use the conversation history to answer. Reply with the answer ONLY.",
      },
      { role: "user", content: "I drive a Tesla Model 3." },
      { role: "assistant", content: "Nice EV." },
      { role: "user", content: "Actually, I sold the Model 3 and bought a Rivian R1S last week." },
      { role: "assistant", content: "Even nicer EV." },
      { role: "user", content: "What car do I drive?" },
    ],
  },
  {
    id: "S4",
    category: "temporal-reasoning",
    task: "How long have I been at Acme Corp?",
    expectedAnswer: "1 year",
    expectedAnswerMatcher: (a) => /\b1\s*year|\bone\s*year|12\s*months/i.test(a),
    messages: [
      {
        role: "system",
        content: "Use the conversation history to answer. Reply with the answer ONLY.",
      },
      { role: "user", content: "I started a new job at Acme Corp on January 5, 2025." },
      { role: "assistant", content: "Congrats!" },
      { role: "user", content: "Today is January 5, 2026." },
      { role: "assistant", content: "Happy work-anniversary." },
      { role: "user", content: "How long have I been at Acme Corp?" },
    ],
  },
  {
    id: "S5",
    category: "single-session-user",
    task: "What's my favourite number?",
    expectedAnswer: "17",
    expectedAnswerMatcher: (a) => /\b17\b/.test(a),
    messages: [
      {
        role: "system",
        content: "Use the conversation history to answer. Reply with the answer ONLY.",
      },
      { role: "user", content: "My favourite colour is teal." },
      { role: "assistant", content: "Cool choice." },
      { role: "user", content: "And my favourite number is 17." },
      { role: "assistant", content: "Prime!" },
      { role: "user", content: "What's my favourite number?" },
    ],
  },
  {
    id: "S6",
    category: "long-context",
    task: "What colour am I considering for my room?",
    expectedAnswer: "blue",
    expectedAnswerMatcher: (a) => /\bblue\b/i.test(a),
    messages: [
      {
        role: "system",
        content: "Use the conversation history to answer. Reply with the answer ONLY.",
      },
      ...pad([
        { role: "user", content: "Today's weather is sunny." },
        { role: "assistant", content: "Enjoy it." },
        { role: "user", content: "I am thinking about painting my room blue." },
        { role: "assistant", content: "Calming colour." },
        { role: "user", content: "What colour am I considering for my room?" },
      ]),
    ],
  },
];

export const multiTurnMemorySuite: BenchmarkSuite = {
  name: "multi-turn-memory",
  title: "Multi-turn memory recall (LongMemEval-style, 6 items)",
  description:
    "Conversation-history recall across 5 categories. Each item is a 4–28 turn dialog ending with a question; the model must answer using facts from earlier turns. Mirrors the bundled longmemeval.mjs fixture.",
  items: ITEMS,
  scorers: [exactMatch, finalAnswerLength(50)],
};
