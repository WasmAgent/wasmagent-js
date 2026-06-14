/**
 * Tests for the memory eval suites: locomo-refined and memory-agent-bench.
 *
 * These don't run an LLM (would conflict with the parallel evomerge SFT
 * job). They verify suite shape and the strict-judge stand-in
 * (forbidden-substring check) — the part most likely to silently
 * mis-score real model output.
 */

import { describe, expect, it } from "vitest";
import { locomoRefinedSuite } from "./locomo-refined.js";
import { memoryAgentBenchSuite } from "./memory-agent-bench.js";

describe("locomo-refined — shape", () => {
  it("has stable name + non-empty items", () => {
    expect(locomoRefinedSuite.name).toBe("locomo-refined");
    expect(locomoRefinedSuite.items.length).toBeGreaterThanOrEqual(10);
  });

  it("every item has multi-turn history (system + ≥1 user/assistant pair)", () => {
    for (const item of locomoRefinedSuite.items) {
      expect(item.messages?.length ?? 0).toBeGreaterThan(2);
      expect(item.messages?.[0]?.role).toBe("system");
    }
  });

  it("covers all 5 categories", () => {
    const cats = new Set(locomoRefinedSuite.items.map((i) => i.category));
    expect(cats.has("single-hop")).toBe(true);
    expect(cats.has("multi-hop")).toBe(true);
    expect(cats.has("temporal")).toBe(true);
    expect(cats.has("open-domain")).toBe(true);
    expect(cats.has("adversarial")).toBe(true);
  });
});

describe("locomo-refined — strict judge stand-in", () => {
  it("accepts answer containing expected substring (case-insensitive)", () => {
    const item = locomoRefinedSuite.items.find((i) => i.id === "lr-single-hop-1");
    expect(item).toBeDefined();
    expect(item!.expectedAnswerMatcher!("Subaru Outback")).toBe(true);
    expect(item!.expectedAnswerMatcher!("subaru outback")).toBe(true);
    expect(item!.expectedAnswerMatcher!("It was an OUTBACK")).toBe(true);
  });

  it("rejects answer without expected substring", () => {
    const item = locomoRefinedSuite.items.find((i) => i.id === "lr-single-hop-1");
    expect(item!.expectedAnswerMatcher!("Honda Civic")).toBe(false);
  });

  it("rejects answer containing forbidden substring even if expected is also there", () => {
    // adversarial-1: expected="Rust", forbidden=["Python"]
    const item = locomoRefinedSuite.items.find((i) => i.id === "lr-adv-1");
    expect(item).toBeDefined();
    expect(item!.expectedAnswerMatcher!("Rust")).toBe(true);
    // The strict-judge stand-in: "Rust, but I used to like Python" should NOT pass
    expect(item!.expectedAnswerMatcher!("Rust now, was Python before")).toBe(false);
    expect(item!.expectedAnswerMatcher!("Python")).toBe(false);
  });

  it("vegan/vegetarian adversarial: dairy in answer fails (strict judge logic)", () => {
    const item = locomoRefinedSuite.items.find((i) => i.id === "lr-adv-2");
    expect(item).toBeDefined();
    expect(item!.expectedAnswerMatcher!("a vegan place")).toBe(true);
    // Wrong: the user is vegan; answer suggesting cheese fails
    expect(item!.expectedAnswerMatcher!("a vegan place with cheese")).toBe(false);
  });

  it("temporal item rejects 15 (off-by-one — strict judge catches '15 days')", () => {
    const item = locomoRefinedSuite.items.find((i) => i.id === "lr-temporal-1");
    expect(item).toBeDefined();
    expect(item!.expectedAnswerMatcher!("14 days")).toBe(true);
    expect(item!.expectedAnswerMatcher!("fourteen")).toBe(true);
    expect(item!.expectedAnswerMatcher!("15 days")).toBe(false);
  });
});

describe("memory-agent-bench — shape", () => {
  it("has stable name + 20 items", () => {
    expect(memoryAgentBenchSuite.name).toBe("memory-agent-bench");
    expect(memoryAgentBenchSuite.items.length).toBe(20);
  });

  it("has 5 items per competency", () => {
    const counts: Record<string, number> = {};
    for (const item of memoryAgentBenchSuite.items) {
      const c = item.category ?? "?";
      counts[c] = (counts[c] ?? 0) + 1;
    }
    expect(counts.AR).toBe(5);
    expect(counts.TTL).toBe(5);
    expect(counts.LRU).toBe(5);
    expect(counts.CR).toBe(5);
  });

  it("every item ends with the actual question as the last user turn", () => {
    for (const item of memoryAgentBenchSuite.items) {
      const last = item.messages?.at(-1);
      expect(last?.role).toBe("user");
      // The last user turn must be the query (not noise)
      expect(last?.content).not.toMatch(/^\(noise/);
    }
  });
});

describe("memory-agent-bench — competency-specific judge logic", () => {
  it("AR: WiFi password requires exact substring", () => {
    const item = memoryAgentBenchSuite.items.find((i) => i.id === "mab-AR-1");
    expect(item).toBeDefined();
    expect(item!.expectedAnswerMatcher!("bluedolphin42")).toBe(true);
    expect(item!.expectedAnswerMatcher!("bluefish42")).toBe(false);
    // Forbidden mismatched permutation is rejected
    expect(item!.expectedAnswerMatcher!("dolphinblue42")).toBe(false);
  });

  it("TTL: 'amber=2' requires answer 2, rejects 1 or 3 (forbidden)", () => {
    const item = memoryAgentBenchSuite.items.find((i) => i.id === "mab-TTL-1");
    expect(item).toBeDefined();
    expect(item!.expectedAnswerMatcher!("priority 2")).toBe(true);
    expect(item!.expectedAnswerMatcher!("two")).toBe(true);
    // model leaks the wrong code → rejected
    expect(item!.expectedAnswerMatcher!("amber means 2 (was 1 earlier)")).toBe(false);
  });

  it("LRU: 'second book' requires Foundation, rejects Dune/Hyperion (forbidden)", () => {
    const item = memoryAgentBenchSuite.items.find((i) => i.id === "mab-LRU-3");
    expect(item).toBeDefined();
    expect(item!.expectedAnswerMatcher!("Foundation")).toBe(true);
    // model lists all three and gets it wrong: should fail
    expect(item!.expectedAnswerMatcher!("Dune, Foundation, Hyperion")).toBe(false);
  });

  it("CR: phone number conflict — old number must NOT appear", () => {
    const item = memoryAgentBenchSuite.items.find((i) => i.id === "mab-CR-1");
    expect(item).toBeDefined();
    expect(item!.expectedAnswerMatcher!("555-0200")).toBe(true);
    expect(item!.expectedAnswerMatcher!("Your number is 555-0200 (was 555-0100)")).toBe(false);
    expect(item!.expectedAnswerMatcher!("555-0100")).toBe(false);
  });

  it("CR: car switch — Tesla is forbidden, Prius/Toyota required", () => {
    const item = memoryAgentBenchSuite.items.find((i) => i.id === "mab-CR-5");
    expect(item).toBeDefined();
    expect(item!.expectedAnswerMatcher!("Toyota Prius")).toBe(true);
    expect(item!.expectedAnswerMatcher!("a Prius")).toBe(true);
    expect(item!.expectedAnswerMatcher!("Tesla → Prius (recently)")).toBe(false);
  });
});

describe("memory eval suites — registry", () => {
  it("both suites are exported via REFERENCE_SUITES", async () => {
    const { REFERENCE_SUITES } = await import("./index.js");
    expect(REFERENCE_SUITES["locomo-refined"]).toBeDefined();
    expect(REFERENCE_SUITES["memory-agent-bench"]).toBeDefined();
  });
});
