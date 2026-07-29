/**
 * #140 — Three-way merge / conflict primitives.
 *
 * Generalizes dirty-tracking into a git-style three-way merge so the agent
 * never overwrites a human's unsaved edits.
 *
 *   base   = last-synced values (common ancestor)
 *   local  = user / human edits
 *   remote = agent writes
 *
 * The reference app already surfaces `dirtyFields` as an advisory ("don't
 * clobber these"); this promotes it to a first-class conflict primitive that
 * also *resolves* the collision, not just flags it.
 *
 * CRDT is intentionally NOT shipped here (epic principle of universality — too
 * heavy for most apps). A CRDT-backed strategy can be added later behind the
 * same {@link ConflictStrategy} extension point (e.g. a `"crdt"` variant
 * delegating to Yjs/Automerge) without changing this API.
 */

// ── FieldTracker (dirty tracking) ───────────────────────────────────────────

/**
 * Tracks which fields have drifted from a known baseline.
 *
 * Mirrors the reference app's `dirtyFields` advisory signal, promoted to a
 * first-class primitive: dirty keys are the fields the agent must not clobber.
 */
export interface FieldTracker {
  /** The snapshot values are compared against. */
  baseline: Record<string, unknown>;
  /**
   * Return the keys whose current value differs from {@link baseline}.
   *
   * A key counts as dirty only when its value actually changed — comparison is
   * structural (deep), so replacing a value with a structurally-equal one (e.g.
   * a fresh object literal with the same fields) does NOT count as dirty. This
   * matches the field-level equality used by the projection layer.
   */
  dirtyKeys(current: Record<string, unknown>): string[];
}

/**
 * Create a {@link FieldTracker} anchored at `baseline`.
 *
 * @example
 * ```ts
 * const tracker = createFieldTracker({ title: "A", body: "x" });
 * tracker.dirtyKeys({ title: "A", body: "y" }); // => ["body"]
 * ```
 */
export function createFieldTracker(baseline: Record<string, unknown>): FieldTracker {
  return {
    baseline,
    dirtyKeys(current: Record<string, unknown>): string[] {
      const dirty: string[] = [];
      for (const key of Object.keys(current)) {
        if (!deepEqual(current[key], baseline[key])) {
          dirty.push(key);
        }
      }
      return dirty;
    },
  };
}

// ── Conflict strategies ─────────────────────────────────────────────────────

/**
 * How a three-way merge resolves a key that both `local` and `remote` changed
 * to differing values (a true conflict).
 *
 * - `"last-write-wins"` — the incoming `remote` (agent) write wins. This is the
 *   naive "clobber" default the merge layer exists to improve upon; it is the
 *   pre-#140 behavior.
 * - `"agent-yields-to-human"` — the `local` (human) value wins on conflict, so
 *   the agent never overwrites unsaved human edits. Non-conflicting agent
 *   writes still apply.
 * - `"manual"` — conflicted keys are left unresolved: the merged value falls
 *   back to `base` (the common ancestor) and the key is reported in
 *   `conflicts` for the application to decide.
 */
export type ConflictStrategy = "last-write-wins" | "agent-yields-to-human" | "manual";

// ── Three-way merge ─────────────────────────────────────────────────────────

/** Result of {@link threeWayMerge}. */
export interface MergeResult<T extends object> {
  /** The merged object. */
  merged: T;
  /**
   * Keys that were changed by BOTH `local` and `remote` to differing values.
   * Empty when there were no conflicts. Under `"manual"`, these keys retain
   * their `base` value in `merged` (left unresolved for the app).
   */
  conflicts: Array<keyof T>;
}

/**
 * Merge three object snapshots git-style.
 *
 * Per key:
 * - changed by only one side → that side's value wins;
 * - changed by both sides to the SAME value → no conflict, value applied;
 * - changed by both sides to DIFFERING values → conflict, resolved per
 *   {@link ConflictStrategy} and reported in `conflicts`.
 *
 * Keys present on only one side are preserved — human and agent additions are
 * never silently dropped. A key removed from both `local` and `remote` is
 * dropped from the merged result.
 *
 * @example
 * ```ts
 * const base = { title: "A", body: "x", tags: ["a"] };
 * const local = { title: "A", body: "human", tags: ["a"] };  // human edited body
 * const remote = { title: "B", body: "agent", tags: ["a"] }; // agent edited title + body
 * const { merged, conflicts } = threeWayMerge(base, local, remote, "agent-yields-to-human");
 * // merged.body === "human"  (human wins the conflict)
 * // merged.title === "B"     (non-conflicting agent write still applies)
 * // conflicts   === ["body"]
 * ```
 */
export function threeWayMerge<T extends object>(
  base: T,
  local: T,
  remote: T,
  strategy: ConflictStrategy
): MergeResult<T> {
  const merged: Record<string, unknown> = {};
  const conflicts: Array<keyof T> = [];

  const baseObj = base as Record<string, unknown>;
  const localObj = local as Record<string, unknown>;
  const remoteObj = remote as Record<string, unknown>;

  const allKeys = new Set<string>([
    ...Object.keys(baseObj),
    ...Object.keys(localObj),
    ...Object.keys(remoteObj),
  ]);

  for (const key of allKeys) {
    const inBase = key in baseObj;
    const inLocal = key in localObj;
    const inRemote = key in remoteObj;

    if (inLocal && inRemote) {
      const lv = localObj[key];
      const rv = remoteObj[key];

      // Both sides agree → no conflict.
      if (deepEqual(lv, rv)) {
        merged[key] = lv;
        continue;
      }

      const localChanged = !inBase || !deepEqual(baseObj[key], lv);
      const remoteChanged = !inBase || !deepEqual(baseObj[key], rv);

      if (localChanged && remoteChanged) {
        // True conflict: both sides changed the same key to differing values.
        conflicts.push(key as keyof T);
        merged[key] = resolveConflict(strategy, baseObj, key, inBase, lv, rv);
      } else if (remoteChanged) {
        merged[key] = rv;
      } else if (localChanged) {
        merged[key] = lv;
      } else {
        // Neither side moved off base, yet they differ — should be unreachable
        // given the deepEqual check above, but fall back to base to be safe.
        merged[key] = baseObj[key];
      }
    } else if (inLocal) {
      // Only local has the key (human addition, or remote removed it).
      // Preserve human data; never silently drop it.
      merged[key] = localObj[key];
    } else if (inRemote) {
      // Only remote has the key (agent addition).
      merged[key] = remoteObj[key];
    }
    // else: present only in base → removed by both sides → omit from merged.
  }

  return { merged: merged as T, conflicts };
}

/**
 * Resolve a single conflicted key according to the strategy.
 * Only called for true conflicts (both sides changed the key, values differ).
 */
function resolveConflict(
  strategy: ConflictStrategy,
  baseObj: Record<string, unknown>,
  key: string,
  inBase: boolean,
  localValue: unknown,
  remoteValue: unknown
): unknown {
  switch (strategy) {
    case "last-write-wins":
      // Incoming agent write wins (naive clobber — the pre-#140 behavior).
      return remoteValue;
    case "agent-yields-to-human":
      // Human's dirty value wins over the agent write.
      return localValue;
    case "manual":
      // Unresolved: fall back to the common ancestor when available so the
      // merged object keeps a well-typed shape; otherwise omit the value.
      return inBase ? baseObj[key] : undefined;
    default:
      return remoteValue;
  }
}

// ── Equality ────────────────────────────────────────────────────────────────

/**
 * Structural (deep) equality for JSON-serializable values.
 *
 * Mirrors `projection.ts#structuralEqual` so dirty detection and merge
 * decisions agree with the projection layer on what "changed" means.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
