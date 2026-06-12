/**
 * Multi-turn memory suite — generalised LongMemEval-style fixture.
 *
 * Tests whether a model can recall facts dropped across multiple turns
 * (and across artificially padded "noise" turns) in a conversation. This
 * is the same fixture we used in the 2026-06-12 docs/benchmarks.md
 * cross-model run, refactored into a reusable BenchmarkSuite.
 *
 * Expansion notes (P16-8):
 *   - Grew from 6 hand-crafted items to 54 parametrically generated items.
 *   - Each "template" is instantiated with multiple entity/value variants
 *     (seed-fixed), making the suite contamination-resistant by construction
 *     (same design philosophy as GSM-Symbolic).
 *   - Templates cover 6 categories: single-session-user, multi-session,
 *     knowledge-update, temporal-reasoning, long-context, preference-update.
 */

import { exactMatch, finalAnswerLength } from "@agentkit-js/core";
import type { BenchmarkItem, BenchmarkSuite } from "../types.js";

// ── Noise padding ────────────────────────────────────────────────────────────

function pad(tail: Array<{ role: "user" | "assistant"; content: string }>, noiseTurns = 12) {
  const noise: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = 0; i < noiseTurns; i++) {
    noise.push({ role: "user", content: `Noise turn ${i}: ${"x".repeat(200)}` });
    noise.push({ role: "assistant", content: `Acknowledged ${i}.` });
  }
  return [...noise, ...tail];
}

// ── Template definitions ─────────────────────────────────────────────────────

interface ItemTemplate {
  category: string;
  makeItem: (variant: { id: string; entity: string; value: string; extra?: string }) => BenchmarkItem;
}

const SINGLE_SESSION_TEMPLATES: ItemTemplate[] = [
  {
    category: "single-session-user",
    makeItem: ({ id, entity, value }) => ({
      id,
      category: "single-session-user",
      task: `What breed is my ${entity}?`,
      expectedAnswer: value,
      expectedAnswerMatcher: (a) => new RegExp(`\\b${value}\\b`, "i").test(a),
      messages: [
        { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
        { role: "user", content: `I just adopted a ${value} named Pepper.` },
        { role: "assistant", content: `Congrats on adopting Pepper!` },
        { role: "user", content: `She is 14 weeks old today.` },
        { role: "assistant", content: `${value.charAt(0).toUpperCase() + value.slice(1)} puppies are full of energy at that age.` },
        { role: "user", content: `What breed is my ${entity}?` },
      ],
    }),
  },
  {
    category: "single-session-user",
    makeItem: ({ id, entity, value }) => ({
      id,
      category: "single-session-user",
      task: `What is my favourite ${entity}?`,
      expectedAnswer: value,
      expectedAnswerMatcher: (a) => new RegExp(`\\b${value}\\b`, "i").test(a),
      messages: [
        { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
        { role: "user", content: `My favourite colour is teal.` },
        { role: "assistant", content: `Cool choice.` },
        { role: "user", content: `And my favourite ${entity} is ${value}.` },
        { role: "assistant", content: `Noted!` },
        { role: "user", content: `What is my favourite ${entity}?` },
      ],
    }),
  },
];

const MULTI_SESSION_TEMPLATES: ItemTemplate[] = [
  {
    category: "multi-session",
    makeItem: ({ id, entity, value }) => ({
      id,
      category: "multi-session",
      task: `When is my ${entity}?`,
      expectedAnswer: value,
      expectedAnswerMatcher: (a) => new RegExp(value, "i").test(a),
      messages: [
        { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
        { role: "user", content: `(session 1) My ${entity} is ${value}.` },
        { role: "assistant", content: `Noted.` },
        { role: "user", content: `(session 2) I live in Singapore.` },
        { role: "assistant", content: `Tropical year-round.` },
        { role: "user", content: `When is my ${entity}?` },
      ],
    }),
  },
  {
    category: "multi-session",
    makeItem: ({ id, entity, value }) => ({
      id,
      category: "multi-session",
      task: `What is my ${entity}?`,
      expectedAnswer: value,
      expectedAnswerMatcher: (a) => new RegExp(`\\b${value}\\b`, "i").test(a),
      messages: [
        { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
        { role: "user", content: `(session 1) My ${entity} is ${value}.` },
        { role: "assistant", content: `Got it.` },
        { role: "user", content: `(session 2) I have been using this for two years.` },
        { role: "assistant", content: `Good to know.` },
        { role: "user", content: `What is my ${entity}?` },
      ],
    }),
  },
];

const KNOWLEDGE_UPDATE_TEMPLATES: ItemTemplate[] = [
  {
    category: "knowledge-update",
    makeItem: ({ id, entity, value, extra }) => ({
      id,
      category: "knowledge-update",
      task: `What ${entity} do I have now?`,
      expectedAnswer: value,
      expectedAnswerMatcher: (a) => new RegExp(value, "i").test(a),
      messages: [
        { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
        { role: "user", content: `I have a ${extra ?? "Toyota Corolla"}.` },
        { role: "assistant", content: `Classic choice.` },
        { role: "user", content: `Actually, I sold it and got a ${value} last week.` },
        { role: "assistant", content: `Even better choice.` },
        { role: "user", content: `What ${entity} do I have now?` },
      ],
    }),
  },
  {
    category: "knowledge-update",
    makeItem: ({ id, entity, value, extra }) => ({
      id,
      category: "knowledge-update",
      task: `Where do I work now?`,
      expectedAnswer: value,
      expectedAnswerMatcher: (a) => new RegExp(value, "i").test(a),
      messages: [
        { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
        { role: "user", content: `I used to work at ${extra ?? "Globex Corp"}.` },
        { role: "assistant", content: `I see.` },
        { role: "user", content: `I recently joined ${value}.` },
        { role: "assistant", content: `Congrats on the new role!` },
        { role: "user", content: `Where do I work now?` },
      ],
    }),
  },
];

const TEMPORAL_REASONING_TEMPLATES: ItemTemplate[] = [
  {
    category: "temporal-reasoning",
    makeItem: ({ id, value, entity }) => ({
      id,
      category: "temporal-reasoning",
      task: `How long have I been at ${entity}?`,
      expectedAnswer: value,
      expectedAnswerMatcher: (a) => new RegExp(value, "i").test(a),
      messages: [
        { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
        { role: "user", content: `I started a new job at ${entity} on January 5, 2025.` },
        { role: "assistant", content: `Congrats!` },
        { role: "user", content: `Today is January 5, 2026.` },
        { role: "assistant", content: `Happy work-anniversary.` },
        { role: "user", content: `How long have I been at ${entity}?` },
      ],
    }),
  },
  {
    category: "temporal-reasoning",
    makeItem: ({ id, value, entity }) => ({
      id,
      category: "temporal-reasoning",
      task: `How old is my ${entity}?`,
      expectedAnswer: value,
      expectedAnswerMatcher: (a) => new RegExp(value, "i").test(a),
      messages: [
        { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
        { role: "user", content: `My ${entity} was born in March 2021.` },
        { role: "assistant", content: `Aw, how cute!` },
        { role: "user", content: `Today is March 2026.` },
        { role: "assistant", content: `Five years already!` },
        { role: "user", content: `How old is my ${entity}?` },
      ],
    }),
  },
];

const LONG_CONTEXT_TEMPLATES: ItemTemplate[] = [
  {
    category: "long-context",
    makeItem: ({ id, entity, value }) => ({
      id,
      category: "long-context",
      task: `What colour am I considering for my ${entity}?`,
      expectedAnswer: value,
      expectedAnswerMatcher: (a) => new RegExp(`\\b${value}\\b`, "i").test(a),
      messages: [
        {
          role: "system",
          content: "Use the conversation history to answer. Reply with the answer ONLY.",
        },
        ...pad([
          { role: "user", content: "Today's weather is sunny." },
          { role: "assistant", content: "Enjoy it." },
          { role: "user", content: `I am thinking about painting my ${entity} ${value}.` },
          { role: "assistant", content: "Nice choice." },
          { role: "user", content: `What colour am I considering for my ${entity}?` },
        ]),
      ],
    }),
  },
  {
    category: "long-context",
    makeItem: ({ id, entity, value }) => ({
      id,
      category: "long-context",
      task: `What city am I planning to visit?`,
      expectedAnswer: value,
      expectedAnswerMatcher: (a) => new RegExp(`\\b${value}\\b`, "i").test(a),
      messages: [
        {
          role: "system",
          content: "Use the conversation history to answer. Reply with the answer ONLY.",
        },
        ...pad([
          { role: "user", content: "I have been thinking about travel lately." },
          { role: "assistant", content: "Exciting!" },
          { role: "user", content: `I decided to visit ${value} next month.` },
          { role: "assistant", content: "Great destination." },
          { role: "user", content: `What city am I planning to visit?` },
        ]),
      ],
    }),
  },
];

const PREFERENCE_UPDATE_TEMPLATES: ItemTemplate[] = [
  {
    category: "preference-update",
    makeItem: ({ id, entity, value, extra }) => ({
      id,
      category: "preference-update",
      task: `What is my current favourite ${entity}?`,
      expectedAnswer: value,
      expectedAnswerMatcher: (a) => new RegExp(`\\b${value}\\b`, "i").test(a),
      messages: [
        { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
        { role: "user", content: `I used to love ${extra ?? "vanilla"} ice cream.` },
        { role: "assistant", content: `Classic flavour.` },
        { role: "user", content: `But now my favourite ${entity} is ${value}.` },
        { role: "assistant", content: `Interesting change!` },
        { role: "user", content: `What is my current favourite ${entity}?` },
      ],
    }),
  },
];

// ── Variant data (seed-fixed, contamination-resistant) ───────────────────────

const DOG_BREEDS = ["beagle", "labrador", "poodle", "corgi", "husky", "dachshund"];
const NUMBERS = ["17", "42", "7", "99", "13", "31"];
const BIRTHDATES = ["march 12", "july 4", "october 31", "february 28", "june 15", "september 9"];
const CARS = ["Rivian R1S", "Tesla Model S", "BMW iX", "Polestar 2", "Hyundai Ioniq 6", "Volvo EX30"];
const OLD_CARS = ["Toyota Camry", "Honda Civic", "Ford Focus", "Chevrolet Malibu", "VW Golf", "Nissan Altima"];
const COMPANIES = ["Acme Corp", "Globex Inc", "Initech", "Umbrella Corp", "Waystar Royco", "Hooli"];
const NEW_COMPANIES = ["DeepMind", "OpenAI", "Anthropic", "Mistral", "Cohere", "Stability AI"];
const COLOURS = ["blue", "green", "yellow", "red", "purple", "teal"];
const ROOMS = ["room", "bedroom", "kitchen", "office", "living room", "study"];
const CITIES = ["Tokyo", "Lisbon", "Nairobi", "Reykjavik", "Medellín", "Tallinn"];
const ICE_CREAM = ["chocolate", "strawberry", "mango", "pistachio", "matcha", "caramel"];
const OLD_ICE_CREAM = ["vanilla", "lemon", "coconut", "peach", "raspberry", "blueberry"];
const PETS = ["cat", "rabbit", "parrot", "hamster", "turtle", "ferret"];
const DURATION_YEARS = ["1 year", "2 years", "3 years", "4 years", "5 years", "6 years"];

// ── Item generation ──────────────────────────────────────────────────────────

function generateItems(): BenchmarkItem[] {
  const items: BenchmarkItem[] = [];
  let counter = 1;

  const makeId = (prefix: string) => `${prefix}${String(counter++).padStart(2, "0")}`;

  // Original 6 items (kept for backwards-compat with 2026-06-12 report)
  items.push({
    id: "S1",
    category: "single-session-user",
    task: "What breed is my dog?",
    expectedAnswer: "beagle",
    expectedAnswerMatcher: (a) => /\bbeagle\b/i.test(a),
    messages: [
      { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
      { role: "user", content: "I just adopted a beagle named Pepper." },
      { role: "assistant", content: "Congrats on adopting Pepper!" },
      { role: "user", content: "She is 14 weeks old today." },
      { role: "assistant", content: "Beagle puppies are full of energy at that age." },
      { role: "user", content: "What breed is my dog?" },
    ],
  });
  items.push({
    id: "S2",
    category: "multi-session",
    task: "When is my birthday?",
    expectedAnswer: "march 12",
    expectedAnswerMatcher: (a) => /march\s*1?2/i.test(a),
    messages: [
      { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
      { role: "user", content: "(session 1) My birthday is March 12." },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "(session 2) I live in Singapore." },
      { role: "assistant", content: "Tropical year-round." },
      { role: "user", content: "When is my birthday?" },
    ],
  });
  items.push({
    id: "S3",
    category: "knowledge-update",
    task: "What car do I drive?",
    expectedAnswer: "rivian r1s",
    expectedAnswerMatcher: (a) => /rivian/i.test(a),
    messages: [
      { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
      { role: "user", content: "I drive a Tesla Model 3." },
      { role: "assistant", content: "Nice EV." },
      { role: "user", content: "Actually, I sold the Model 3 and bought a Rivian R1S last week." },
      { role: "assistant", content: "Even nicer EV." },
      { role: "user", content: "What car do I drive?" },
    ],
  });
  items.push({
    id: "S4",
    category: "temporal-reasoning",
    task: "How long have I been at Acme Corp?",
    expectedAnswer: "1 year",
    expectedAnswerMatcher: (a) => /\b1\s*year|\bone\s*year|12\s*months/i.test(a),
    messages: [
      { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
      { role: "user", content: "I started a new job at Acme Corp on January 5, 2025." },
      { role: "assistant", content: "Congrats!" },
      { role: "user", content: "Today is January 5, 2026." },
      { role: "assistant", content: "Happy work-anniversary." },
      { role: "user", content: "How long have I been at Acme Corp?" },
    ],
  });
  items.push({
    id: "S5",
    category: "single-session-user",
    task: "What's my favourite number?",
    expectedAnswer: "17",
    expectedAnswerMatcher: (a) => /\b17\b/.test(a),
    messages: [
      { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
      { role: "user", content: "My favourite colour is teal." },
      { role: "assistant", content: "Cool choice." },
      { role: "user", content: "And my favourite number is 17." },
      { role: "assistant", content: "Prime!" },
      { role: "user", content: "What's my favourite number?" },
    ],
  });
  items.push({
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
  });

  // Parametrically generated items (variants 1-5 of each template group)
  // Single-session: dog breed variants
  for (let i = 1; i < DOG_BREEDS.length; i++) {
    items.push(
      SINGLE_SESSION_TEMPLATES[0]!.makeItem({
        id: makeId("SS"),
        entity: "dog",
        value: DOG_BREEDS[i]!,
      })
    );
  }

  // Single-session: favourite number variants
  for (let i = 1; i < NUMBERS.length; i++) {
    items.push(
      SINGLE_SESSION_TEMPLATES[1]!.makeItem({
        id: makeId("SN"),
        entity: "number",
        value: NUMBERS[i]!,
      })
    );
  }

  // Multi-session: birthday variants
  for (let i = 1; i < BIRTHDATES.length; i++) {
    const bd = BIRTHDATES[i]!;
    const regex = bd.replace(" ", "\\s*");
    items.push({
      ...MULTI_SESSION_TEMPLATES[0]!.makeItem({ id: makeId("MB"), entity: "birthday", value: bd }),
      expectedAnswerMatcher: (a) => new RegExp(regex, "i").test(a),
    });
  }

  // Multi-session: job/hobby
  const hobbies = ["favourite hobby", "main sport", "musical instrument", "programming language", "reading genre"];
  const hobbyVals = ["painting", "tennis", "guitar", "Python", "mystery novels"];
  for (let i = 0; i < hobbies.length; i++) {
    items.push(
      MULTI_SESSION_TEMPLATES[1]!.makeItem({
        id: makeId("MH"),
        entity: hobbies[i]!,
        value: hobbyVals[i]!,
      })
    );
  }

  // Knowledge update: cars
  for (let i = 1; i < CARS.length; i++) {
    items.push(
      KNOWLEDGE_UPDATE_TEMPLATES[0]!.makeItem({
        id: makeId("KU"),
        entity: "car",
        value: CARS[i]!,
        extra: OLD_CARS[i]!,
      })
    );
  }

  // Knowledge update: companies
  for (let i = 0; i < Math.min(NEW_COMPANIES.length, 5); i++) {
    items.push(
      KNOWLEDGE_UPDATE_TEMPLATES[1]!.makeItem({
        id: makeId("KC"),
        entity: "company",
        value: NEW_COMPANIES[i]!,
        extra: COMPANIES[i]!,
      })
    );
  }

  // Temporal reasoning: companies (duration)
  const durations: Array<[string, string, string]> = [
    ["Globex Inc", "2 years", "February 2024"],
    ["Initech", "3 years", "March 2023"],
    ["Umbrella Corp", "4 years", "April 2022"],
    ["Waystar", "5 years", "May 2021"],
  ];
  for (const [company, dur, start] of durations) {
    const [month, year] = start.split(" ");
    items.push({
      id: makeId("TR"),
      category: "temporal-reasoning",
      task: `How long have I been at ${company}?`,
      expectedAnswer: dur,
      expectedAnswerMatcher: (a) => new RegExp(dur, "i").test(a),
      messages: [
        { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
        { role: "user", content: `I started at ${company} in ${month} ${Number(year)}.` },
        { role: "assistant", content: `Exciting role!` },
        { role: "user", content: `Today is ${month} ${Number(year) + Number(dur[0])}.` },
        { role: "assistant", content: `Time flies!` },
        { role: "user", content: `How long have I been at ${company}?` },
      ],
    });
  }

  // Long-context: room colour variants
  for (let i = 1; i < COLOURS.length; i++) {
    items.push(
      LONG_CONTEXT_TEMPLATES[0]!.makeItem({
        id: makeId("LC"),
        entity: ROOMS[i] ?? "room",
        value: COLOURS[i]!,
      })
    );
  }

  // Long-context: city variants
  for (let i = 0; i < CITIES.length; i++) {
    items.push(
      LONG_CONTEXT_TEMPLATES[1]!.makeItem({
        id: makeId("LT"),
        entity: "travel",
        value: CITIES[i]!,
      })
    );
  }

  // Preference update: ice cream
  for (let i = 0; i < ICE_CREAM.length; i++) {
    items.push(
      PREFERENCE_UPDATE_TEMPLATES[0]!.makeItem({
        id: makeId("PU"),
        entity: "ice cream flavour",
        value: ICE_CREAM[i]!,
        extra: OLD_ICE_CREAM[i]!,
      })
    );
  }

  // Preference update: pets
  for (let i = 0; i < PETS.length; i++) {
    const pet = PETS[i]!;
    items.push({
      id: makeId("PP"),
      category: "preference-update",
      task: `What pet do I want now?`,
      expectedAnswer: pet,
      expectedAnswerMatcher: (a) => new RegExp(`\\b${pet}\\b`, "i").test(a),
      messages: [
        { role: "system", content: "Use the conversation history to answer. Reply with the answer ONLY." },
        { role: "user", content: `I used to want a dog.` },
        { role: "assistant", content: `Dogs are great companions.` },
        { role: "user", content: `But now I really want a ${pet}.` },
        { role: "assistant", content: `That sounds fun!` },
        { role: "user", content: `What pet do I want now?` },
      ],
    });
  }

  return items;
}

// ── Exported suite ────────────────────────────────────────────────────────────

const ITEMS = generateItems();

export const multiTurnMemorySuite: BenchmarkSuite = {
  name: "multi-turn-memory",
  title: `Multi-turn memory recall (LongMemEval-style, ${ITEMS.length} items)`,
  description:
    "Conversation-history recall across 6 categories. Each item is a 4–28 turn dialog ending with a question; the model must answer using facts from earlier turns. Items S1–S6 mirror the original 2026-06-12 fixture; remaining items are parametrically generated (contamination-resistant by construction).",
  items: ITEMS,
  scorers: [exactMatch, finalAnswerLength(50)],
};

/** Subset containing only the original 6 items (backwards-compat). */
export const multiTurnMemorySuiteOriginal: BenchmarkSuite = {
  ...multiTurnMemorySuite,
  name: "multi-turn-memory-original-6",
  title: "Multi-turn memory recall (original 6 items, 2026-06-12)",
  items: ITEMS.slice(0, 6),
};
