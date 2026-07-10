/**
 * RolloutMemoryStore — persists high-quality rollout experiences for future sampling.
 *
 * Only rollouts with objectiveScore=1 are stored. Low-quality branches are silently
 * discarded to keep the memory free of poisoning examples.
 *
 * On retrieval, the top-K most similar past approaches are formatted as a system
 * prompt injection that RolloutForkRunner can prepend before launching new branches.
 *
 * Uses the Retriever/Embedder interfaces from packages/core/src/memory/Retriever.ts
 * so any backend (InMemory, Pinecone, Qdrant) works without changes here.
 */

import type { Retriever } from "../memory/Retriever.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RolloutMemoryRecord {
  rolloutId: string;
  branchIndex: number;
  task: string;
  /** Formatted key steps: tool names + brief output, no LLM summarization. */
  keySteps: string;
  objectiveScore: 0 | 1;
  finalAnswer: string;
  totalScore?: number;
}

export interface RolloutMemory {
  id: string;
  taskSummary: string;
  keySteps: string;
  score: number;
}

export interface RolloutMemoryStoreOptions {
  store: Retriever;
  includeAllScores?: boolean;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class RolloutMemoryStore {
  readonly #store: Retriever;
  readonly #includeAllScores: boolean;

  constructor(opts: RolloutMemoryStoreOptions) {
    this.#store = opts.store;
    this.#includeAllScores = opts.includeAllScores ?? false;
  }

  /**
   * Persist a rollout. When includeAllScores=false (default), only score=1 is kept.
   */
  async upsert(rollout: RolloutMemoryRecord): Promise<void> {
    if (!this.#includeAllScores && rollout.objectiveScore !== 1) return;

    const id = `${rollout.rolloutId}-b${rollout.branchIndex}`;
    const text = formatMemoryText(rollout.task, rollout.keySteps);
    const totalScore = rollout.totalScore ?? rollout.objectiveScore;
    await this.#store.add(id, text, {
      rolloutId: rollout.rolloutId,
      branchIndex: rollout.branchIndex,
      objectiveScore: rollout.objectiveScore,
      totalScore,
    });
  }

  /**
   * Retrieve the topK most relevant past rollout memories for the given task.
   */
  async retrieve(task: string, topK = 3, minScore?: number): Promise<RolloutMemory[]> {
    try {
      const results = await this.#store.search(task, topK);
      const memories = results.map((r) => {
        const meta = r.metadata ?? {};
        return {
          id: r.id,
          taskSummary: r.text,
          keySteps: String(meta.keySteps ?? ""),
          score: typeof meta.totalScore === "number" ? (meta.totalScore as number) : r.score,
        };
      });
      if (minScore !== undefined) {
        return memories.filter((m) => m.score >= minScore);
      }
      return memories;
    } catch {
      return [];
    }
  }

  /**
   * Format retrieved memories as a system prompt injection for RolloutForkRunner.
   */
  static formatAsSystemPrompt(memories: RolloutMemory[]): string {
    if (memories.length === 0) return "";
    const allHighScore = memories.every((m) => m.score >= 0.9);
    if (allHighScore) {
      const lines = memories.map((m, i) => `${i + 1}. ${m.taskSummary}`);
      return `# Relevant past successful approaches:\n${lines.join("\n")}`;
    }
    const lines = memories.map(
      (m, i) => `${i + 1}. [score: ${m.score.toFixed(2)}] ${m.taskSummary}`
    );
    return `# Trajectories on similar past tasks:\n${lines.join("\n")}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMemoryText(task: string, keySteps: string): string {
  const summary = task.length > 120 ? `${task.slice(0, 117)}...` : task;
  return keySteps ? `${summary} → ${keySteps}` : summary;
}
