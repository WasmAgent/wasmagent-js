import type { Retriever, SearchResult } from "../memory/Retriever.js";
import { type RolloutMemoryRecord, RolloutMemoryStore } from "./RolloutMemoryStore.js";

// ── Mock Retriever ────────────────────────────────────────────────────────────

function makeRetriever() {
  const store = new Map<string, { text: string; metadata?: Record<string, unknown> }>();
  const retriever: Retriever = {
    async add(id, text, metadata) {
      store.set(id, { text, metadata });
    },
    async search(query, topK = 3): Promise<SearchResult[]> {
      const results = [...store.entries()]
        .map(([id, { text, metadata }]) => ({
          id,
          text,
          score: text.toLowerCase().includes(query.toLowerCase()) ? 0.9 : 0.5,
          metadata,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return results;
    },
  };
  return { store, retriever };
}

function makeRecord(overrides: Partial<RolloutMemoryRecord> = {}): RolloutMemoryRecord {
  return {
    rolloutId: "r1",
    branchIndex: 0,
    task: "build a REST API",
    keySteps: "create_file → run_tests",
    objectiveScore: 1,
    finalAnswer: "done",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RolloutMemoryStore", () => {
  test("upsert objectiveScore=1 is stored and retrievable", async () => {
    const { retriever } = makeRetriever();
    const mem = new RolloutMemoryStore({ store: retriever });
    await mem.upsert(makeRecord({ task: "build a REST API", objectiveScore: 1 }));
    const results = await mem.retrieve("build a REST API");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.taskSummary).toContain("REST API");
  });

  test("upsert objectiveScore=0 is silently dropped (not stored)", async () => {
    const { retriever, store } = makeRetriever();
    const mem = new RolloutMemoryStore({ store: retriever });
    await mem.upsert(makeRecord({ objectiveScore: 0 }));
    expect(store.size).toBe(0);
  });

  test("retrieve from empty store returns empty array without throwing", async () => {
    const { retriever } = makeRetriever();
    const mem = new RolloutMemoryStore({ store: retriever });
    const results = await mem.retrieve("anything");
    expect(results).toEqual([]);
  });

  test("retrieve respects topK limit", async () => {
    const { retriever } = makeRetriever();
    const mem = new RolloutMemoryStore({ store: retriever });
    for (let i = 0; i < 5; i++) {
      await mem.upsert(makeRecord({ branchIndex: i, task: "shared task" }));
    }
    const results = await mem.retrieve("shared task", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("formatAsSystemPrompt returns empty string for empty memories", () => {
    const prompt = RolloutMemoryStore.formatAsSystemPrompt([]);
    expect(prompt).toBe("");
  });

  test("formatAsSystemPrompt includes numbered entries", () => {
    const memories = [
      { id: "1", taskSummary: "build API → created endpoints", keySteps: "", score: 0.95 },
      { id: "2", taskSummary: "write tests → all passed", keySteps: "", score: 0.92 },
    ];
    const prompt = RolloutMemoryStore.formatAsSystemPrompt(memories);
    expect(prompt).toContain("# Relevant past successful approaches:");
    expect(prompt).toContain("1. build API");
    expect(prompt).toContain("2. write tests");
  });

  test("multiple upserts with score=1 are all retrievable", async () => {
    const { retriever } = makeRetriever();
    const mem = new RolloutMemoryStore({ store: retriever });
    await mem.upsert(makeRecord({ rolloutId: "r1", branchIndex: 0, objectiveScore: 1 }));
    await mem.upsert(makeRecord({ rolloutId: "r1", branchIndex: 1, objectiveScore: 1 }));
    const results = await mem.retrieve("build", 10);
    expect(results.length).toBe(2);
  });

  test("store returns error-safe empty array when retriever throws", async () => {
    const badRetriever: Retriever = {
      async add() {},
      async search() {
        throw new Error("connection failed");
      },
    };
    const mem = new RolloutMemoryStore({ store: badRetriever });
    const results = await mem.retrieve("anything");
    expect(results).toEqual([]);
  });

  test("upsert with includeAllScores=true stores score=0 branches", async () => {
    const { retriever, store } = makeRetriever();
    const mem = new RolloutMemoryStore({ store: retriever, includeAllScores: true });
    await mem.upsert(makeRecord({ objectiveScore: 0, totalScore: 0.12 }));
    expect(store.size).toBe(1);
    const entry = [...store.values()][0]!;
    expect(entry.metadata?.totalScore).toBe(0.12);
  });

  test("retrieve with minScore filters out low-score memories", async () => {
    const { retriever } = makeRetriever();
    const mem = new RolloutMemoryStore({ store: retriever, includeAllScores: true });
    await mem.upsert(makeRecord({ branchIndex: 0, objectiveScore: 1, totalScore: 0.95 }));
    await mem.upsert(makeRecord({ branchIndex: 1, objectiveScore: 0, totalScore: 0.12 }));
    const all = await mem.retrieve("build", 10);
    expect(all.length).toBe(2);
    const filtered = await mem.retrieve("build", 10, 0.5);
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.score).toBeGreaterThanOrEqual(0.5);
  });

  test("formatAsSystemPrompt with mixed scores includes score values without avoid language", () => {
    const memories = [
      { id: "1", taskSummary: "build API → created endpoints", keySteps: "", score: 0.85 },
      { id: "2", taskSummary: "write tests → half failed", keySteps: "", score: 0.12 },
    ];
    const prompt = RolloutMemoryStore.formatAsSystemPrompt(memories);
    expect(prompt).toContain("# Trajectories on similar past tasks:");
    expect(prompt).toContain("[score: 0.85]");
    expect(prompt).toContain("[score: 0.12]");
    expect(prompt).not.toContain("avoid");
    expect(prompt).not.toContain("Relevant past successful");
  });

  test("default behaviour (includeAllScores=false) still drops score=0", async () => {
    const { retriever, store } = makeRetriever();
    const mem = new RolloutMemoryStore({ store: retriever });
    await mem.upsert(makeRecord({ objectiveScore: 0 }));
    expect(store.size).toBe(0);
    await mem.upsert(makeRecord({ objectiveScore: 1 }));
    expect(store.size).toBe(1);
  });
});
