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
}

export interface RolloutMemory {
  id: string;
  taskSummary: string;
  keySteps: string;
  score: number;
}

export interface RolloutMemoryStoreOptions {
  store: Retriever;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class RolloutMemoryStore {
  readonly #store: Retriever;

  constructor(opts: RolloutMemoryStoreOptions) {
    this.#store = opts.store;
  }

  /**
   * Persist a rollout if objectiveScore=1. Score=0 records are silently dropped.
   *
   * The stored text is "task_summary + key_steps" — no LLM summarisation, purely
   * deterministic formatting so the memory content is reproducible.
   */
  async upsert(rollout: RolloutMemoryRecord): Promise<void> {
    if (rollout.objectiveScore !== 1) return;

    const id = `${rollout.rolloutId}-b${rollout.branchIndex}`;
    const text = formatMemoryText(rollout.task, rollout.keySteps);
    await this.#store.add(id, text, {
      rolloutId: rollout.rolloutId,
      branchIndex: rollout.branchIndex,
      objectiveScore: rollout.objectiveScore,
    });
  }

  /**
   * Retrieve the topK most relevant past rollout memories for the given task.
   *
   * Returns an empty array (never throws) when the store is empty or the
   * query returns no results.
   */
  async retrieve(task: string, topK = 3): Promise<RolloutMemory[]> {
    try {
      const results = await this.#store.search(task, topK);
      return results.map((r) => {
        const meta = r.metadata ?? {};
        return {
          id: r.id,
          taskSummary: r.text,
          keySteps: String(meta.keySteps ?? ""),
          score: r.score,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Format retrieved memories as a system prompt injection for RolloutForkRunner.
   *
   * Returns empty string when memories is empty so callers can safely concatenate.
   */
  static formatAsSystemPrompt(memories: RolloutMemory[]): string {
    if (memories.length === 0) return "";
    const lines = memories.map((m, i) => `${i + 1}. ${m.taskSummary}`);
    return `# Relevant past successful approaches:\n${lines.join("\n")}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMemoryText(task: string, keySteps: string): string {
  const summary = task.length > 120 ? `${task.slice(0, 117)}...` : task;
  return keySteps ? `${summary} → ${keySteps}` : summary;
}
