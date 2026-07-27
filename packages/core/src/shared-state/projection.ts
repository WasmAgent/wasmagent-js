/**
 * #138 — Projection Pipeline
 *
 * Efficient diff-based projection system for state changes.
 * Computes field-level structural diffs between projected states
 * and optionally narrates changes for human/agent consumption.
 */

import type { ConflictStrategy } from "./merge.js";
import { threeWayMerge } from "./merge.js";
import type { Action, StateModel } from "./StateModel.js";

// ── Projection type alias ───────────────────────────────────────────────────

/**
 * Function that projects internal state into a read-friendly view.
 * The view type `V` defaults to `unknown` when the projection shape
 * is not statically known.
 */
export type ProjectionFn<S, V = unknown> = (state: S) => V;

/** Represents the structural difference between two projections. */
export interface ProjectionDelta {
  /** Fields that were added or changed (path -> new value). */
  changed: Record<string, unknown>;
  /** Field paths that were removed. */
  removed: string[];
  /**
   * #140 — Fields in conflict from a three-way merge, surfaced so the agent
   * knows which fields it must not touch.
   *
   * Populated only by merge-aware projection (see
   * {@link ProjectionPipeline.mergeDelta}); absent for plain two-state diffs.
   * Each entry is a state field that both the human and the agent changed to
   * differing values — for the default identity projection these correspond
   * directly to projection fields.
   */
  conflicts?: string[];
}

/**
 * A projection pipeline that can produce full projections,
 * compute diffs, and optionally narrate changes.
 */
export interface ProjectionPipeline<S> {
  /** Produce the full projection of a state. */
  full(state: S): unknown;
  /** Compute the structural diff between two states' projections. */
  diff(prev: S, next: S): ProjectionDelta;
  /** Optional: produce a human-readable narration of a delta. */
  narrate?(delta: ProjectionDelta): string;
  /**
   * #140 — Three-way merge surfaced as a projection delta.
   *
   * Runs a git-style {@link threeWayMerge} on the raw states, then reports the
   * outcome as a {@link ProjectionDelta}: `changed`/`removed` describe how the
   * merged projection differs from `base`, and `conflicts` lists the state
   * fields the agent must not touch (changed by both human and agent to
   * differing values).
   *
   * Under the `"manual"` strategy, conflicted fields are left unresolved (they
   * keep their `base` value) and appear in `conflicts` so the application can
   * decide.
   */
  mergeDelta(base: S, local: S, remote: S, strategy: ConflictStrategy): ProjectionDelta;
}

/**
 * Create a projection pipeline from a StateModel.
 *
 * Uses the model's `project` function (or identity if not defined)
 * and performs field-level structural comparison for diffs.
 */
export function createProjectionPipeline<S, A extends Action>(
  model: StateModel<S, A>,
  opts?: { narrator?: (delta: ProjectionDelta) => string }
): ProjectionPipeline<S> {
  const project = (state: S): unknown => {
    return model.project ? model.project(state) : state;
  };

  const result: ProjectionPipeline<S> = {
    full(state: S): unknown {
      return project(state);
    },

    diff(prev: S, next: S): ProjectionDelta {
      const prevProjection = project(prev);
      const nextProjection = project(next);
      return computeDelta(prevProjection, nextProjection);
    },

    mergeDelta(base: S, local: S, remote: S, strategy: ConflictStrategy): ProjectionDelta {
      const { merged, conflicts } = threeWayMerge(
        base as Record<string, unknown>,
        local as Record<string, unknown>,
        remote as Record<string, unknown>,
        strategy
      );
      const delta = computeDelta(project(base), project(merged as S));
      return {
        changed: delta.changed,
        removed: delta.removed,
        conflicts: conflicts.map((key) => String(key)),
      };
    },
  };

  if (opts?.narrator) {
    const narrator = opts.narrator;
    result.narrate = (delta: ProjectionDelta) => narrator(delta);
  }

  return result;
}

/**
 * Compute a field-level structural delta between two projected values.
 * Only compares top-level fields of objects. For non-object projections,
 * treats the entire value as a single "root" field.
 */
function computeDelta(prev: unknown, next: unknown): ProjectionDelta {
  const changed: Record<string, unknown> = {};
  const removed: string[] = [];
  const rootKey = "$root";

  // Handle non-object cases
  if (prev === null || typeof prev !== "object" || next === null || typeof next !== "object") {
    if (!structuralEqual(prev, next)) {
      changed[rootKey] = next;
    }
    return { changed, removed };
  }

  // Handle arrays as a single value
  if (Array.isArray(prev) || Array.isArray(next)) {
    if (!structuralEqual(prev, next)) {
      changed[rootKey] = next;
    }
    return { changed, removed };
  }

  const prevObj = prev as Record<string, unknown>;
  const nextObj = next as Record<string, unknown>;

  // Find changed and added fields
  for (const key of Object.keys(nextObj)) {
    if (!structuralEqual(prevObj[key], nextObj[key])) {
      changed[key] = nextObj[key];
    }
  }

  // Find removed fields
  for (const key of Object.keys(prevObj)) {
    if (!(key in nextObj)) {
      removed.push(key);
    }
  }

  return { changed, removed };
}

/**
 * Deep structural equality check via JSON serialization.
 * Simple and correct for JSON-serializable state.
 */
function structuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
