/**
 * Mutation runner — applies all or a named subset of mutators to text.
 */

export type { Mutator } from "./mutators.js";
export { ALL_MUTATORS } from "./mutators.js";

import { ALL_MUTATORS } from "./mutators.js";
import type { Mutator } from "./mutators.js";

export interface MutationResult {
  mutatorName: string;
  original: string;
  mutated: string;
  /** True when the mutation produced no visible change to the text. */
  identical: boolean;
}

/**
 * Apply every registered mutator to `text` and return one result per mutator.
 */
export function applyAllMutators(text: string, seed?: number): MutationResult[] {
  return ALL_MUTATORS.map((m) => applyMutator(m, text, seed));
}

/**
 * Apply a specific subset of mutators (by name) to `text`.
 * Unknown names are silently skipped.
 */
export function applyMutators(text: string, mutatorNames: string[], seed?: number): MutationResult[] {
  const selected = ALL_MUTATORS.filter((m) => mutatorNames.includes(m.name));
  return selected.map((m) => applyMutator(m, text, seed));
}

/** Return all registered mutator names in declaration order. */
export function getMutatorNames(): string[] {
  return ALL_MUTATORS.map((m) => m.name);
}

// ── Internal ─────────────────────────────────────────────────────────────────

function applyMutator(m: Mutator, text: string, seed?: number): MutationResult {
  const mutated = m.apply(text, seed);
  return {
    mutatorName: m.name,
    original: text,
    mutated,
    identical: mutated === text,
  };
}
