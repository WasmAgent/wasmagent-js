/**
 * BranchableWorkspace — git-worktree-equivalent for agent file edits (F3).
 *
 * The piece this primitive supplies is **isolation with cheap fanout**:
 * `fork()` makes a new branch that sees parent files transparently but
 * never writes back to them, so N parallel agents can edit the same logical
 * workspace without trampling each other. When the parallel work converges,
 * `diff(base)` and `merge(other, strategy)` give callers the structured
 * material they need to surface conflicts to a human (or to a judge).
 *
 * ## Storage layout
 *
 * Everything lives under one prefix on a {@link KvBackend} (typically the
 * same KV that `KvCheckpointer` and `EventLog` already use — F3 explicitly
 * does NOT introduce a new persistence concept):
 *
 *   wsmeta:<branchId>           → JSON {parent: branchId|null, createdAtMs}
 *   wsfile:<branchId>:<path>    → file content (UTF-8)
 *   wstomb:<branchId>:<path>    → "1" tombstone marking a delete
 *
 * Reads walk the parent chain at lookup time (copy-on-read), and writes only
 * touch the local branch's prefix (copy-on-write). A 1000-file fork therefore
 * costs O(0) writes — the cost is paid lazily and only on the files the
 * forked branch actually changes.
 *
 * ## Conflicts are surfaced, never auto-resolved
 *
 * `merge()` accepts strategies "fail-on-conflict" (default) and "ours" / "theirs",
 * but it never tries a 3-way merge of file *contents*. When two branches
 * change the same file, callers receive a structured `MergeConflict[]` and
 * decide — typically by handing it to a judge agent or to a human via the
 * approval policy. This matches the v3-plan rule "no silent overwrites".
 */

import type { KvBackend } from "../checkpoint/index.js";

// ── Public types ─────────────────────────────────────────────────────────────

export type MergeStrategy = "fail-on-conflict" | "ours" | "theirs";

export interface BranchMeta {
  /** Parent branch id; null for the root. */
  parent: string | null;
  createdAtMs: number;
}

export interface FileChange {
  path: string;
  /** "added" only on this branch; "deleted" via tombstone; "modified" content differs. */
  kind: "added" | "modified" | "deleted";
  /** Content as seen on this branch (null for "deleted"). */
  content: string | null;
}

export interface MergeConflict {
  path: string;
  /** Content on the receiver branch ("ours" / "this"). */
  ours: string | null;
  /** Content on the other branch ("theirs"). */
  theirs: string | null;
  /** Why this is a conflict — one of the structured reasons below. */
  reason: "both-modified" | "modified-vs-deleted" | "deleted-vs-modified";
}

export interface MergeResult {
  /** Files that merged cleanly (only one side changed, or strategy resolved them). */
  applied: string[];
  /** Files that needed a human/judge — empty when strategy is non-default. */
  conflicts: MergeConflict[];
}

// ── Key shaping (single source of truth) ────────────────────────────────────

const PREFIX_META = "wsmeta:";
const PREFIX_FILE = "wsfile:";
const PREFIX_TOMB = "wstomb:";

function metaKey(branchId: string): string {
  return `${PREFIX_META}${branchId}`;
}
function fileKey(branchId: string, path: string): string {
  return `${PREFIX_FILE}${branchId}:${path}`;
}
function tombKey(branchId: string, path: string): string {
  return `${PREFIX_TOMB}${branchId}:${path}`;
}
function branchFilePrefix(branchId: string): string {
  return `${PREFIX_FILE}${branchId}:`;
}
function branchTombPrefix(branchId: string): string {
  return `${PREFIX_TOMB}${branchId}:`;
}

// ── Implementation ──────────────────────────────────────────────────────────

export class BranchableWorkspace {
  readonly #kv: Required<KvBackend>;
  readonly #branchId: string;

  /**
   * @param kv  The shared persistence backend. MUST implement `list()` —
   *            without enumeration we cannot diff or merge. The constructor
   *            throws otherwise rather than failing later in a hot path.
   * @param branchId  Stable id for this branch; treat it like a git ref name.
   */
  constructor(kv: KvBackend, branchId: string) {
    if (!kv.list) {
      throw new Error(
        "BranchableWorkspace: KvBackend must implement list(prefix) — required for diff/merge"
      );
    }
    if (!branchId || /[\s:]/.test(branchId)) {
      // ":" is our key separator; whitespace would survive into KV keys.
      throw new Error(
        `BranchableWorkspace: branchId must be a non-empty string with no ':' or whitespace; got ${JSON.stringify(branchId)}`
      );
    }
    this.#kv = kv as Required<KvBackend>;
    this.#branchId = branchId;
  }

  /** This branch's id. */
  get branchId(): string {
    return this.#branchId;
  }

  /**
   * Initialise the branch metadata. Idempotent — calling twice does not
   * reparent. Use {@link openOrCreateRoot} for the canonical root branch.
   */
  async init(parent: string | null): Promise<void> {
    const existing = await this.#kv.get(metaKey(this.#branchId));
    if (existing) return;
    const meta: BranchMeta = { parent, createdAtMs: 0 };
    // createdAtMs intentionally 0 — workflows can't read clocks (Date.now()
    // is forbidden in the workflow runtime). Tests inject their own when needed.
    await this.#kv.put(metaKey(this.#branchId), JSON.stringify(meta));
  }

  /**
   * Read a file, walking up the parent chain on miss. Returns null when the
   * file does not exist on any ancestor OR when the nearest record is a
   * tombstone (the file was deleted on this branch).
   */
  async read(path: string): Promise<string | null> {
    let cursor: string | null = this.#branchId;
    while (cursor) {
      // Tombstone wins over both local content and parent content.
      const tomb = await this.#kv.get(tombKey(cursor, path));
      if (tomb) return null;
      const local = await this.#kv.get(fileKey(cursor, path));
      if (local !== null) return local;
      cursor = await this.#parentOf(cursor);
    }
    return null;
  }

  /**
   * True iff `read(path)` would return a string. Distinguishes "file does
   * not exist" from "file exists with empty string content".
   */
  async exists(path: string): Promise<boolean> {
    let cursor: string | null = this.#branchId;
    while (cursor) {
      if (await this.#kv.get(tombKey(cursor, path))) return false;
      if ((await this.#kv.get(fileKey(cursor, path))) !== null) return true;
      cursor = await this.#parentOf(cursor);
    }
    return false;
  }

  /** Write a file on this branch. Clears any local tombstone for `path`. */
  async write(path: string, content: string): Promise<void> {
    await this.#kv.delete(tombKey(this.#branchId, path));
    await this.#kv.put(fileKey(this.#branchId, path), content);
  }

  /**
   * Mark a file as deleted on this branch. The parent's copy is untouched —
   * other branches forked off the parent still see it. Re-writing the same
   * path lifts the tombstone (see `write`).
   */
  async remove(path: string): Promise<void> {
    await this.#kv.delete(fileKey(this.#branchId, path));
    await this.#kv.put(tombKey(this.#branchId, path), "1");
  }

  /**
   * List every visible path on this branch, walking the parent chain and
   * applying tombstones. The result is sorted lexicographically — call sites
   * that care about order get it deterministically.
   */
  async list(): Promise<string[]> {
    const visible = new Set<string>();
    const tombstoned = new Set<string>();
    let cursor: string | null = this.#branchId;
    while (cursor) {
      const fileKeys = await this.#kv.list(branchFilePrefix(cursor));
      const tombKeys = await this.#kv.list(branchTombPrefix(cursor));
      for (const k of tombKeys) {
        const path = k.slice(branchTombPrefix(cursor).length);
        // A child tombstone hides any ancestor copy; only mark on first sight.
        if (!visible.has(path)) tombstoned.add(path);
      }
      for (const k of fileKeys) {
        const path = k.slice(branchFilePrefix(cursor).length);
        // Don't undo an ancestor's tombstone we already saw.
        if (!tombstoned.has(path)) visible.add(path);
      }
      cursor = await this.#parentOf(cursor);
    }
    return [...visible].sort();
  }

  /**
   * Create a child branch. Returns a new {@link BranchableWorkspace}
   * pointing at the child, and writes the child's metadata with `parent`
   * set to this branch's id.
   *
   * No file content is copied — that's the point of copy-on-write. A 10k-file
   * workspace fork costs exactly one KV `put`.
   */
  async fork(childId: string): Promise<BranchableWorkspace> {
    const child = new BranchableWorkspace(this.#kv, childId);
    await child.init(this.#branchId);
    return child;
  }

  /**
   * Compute every change visible on this branch relative to its parent
   * chain at depth `base.branchId`. `base` MUST be an ancestor — passing an
   * unrelated branch throws.
   */
  async diff(base: BranchableWorkspace): Promise<FileChange[]> {
    if (!(await this.#isAncestor(base.branchId))) {
      throw new Error(
        `BranchableWorkspace.diff: ${base.branchId} is not an ancestor of ${this.#branchId}`
      );
    }
    const changes: FileChange[] = [];
    const visited = new Set<string>();

    // Walk every branch from `this` down to (but not including) base, so we
    // capture changes that happened anywhere in the divergent chain.
    let cursor: string | null = this.#branchId;
    while (cursor && cursor !== base.branchId) {
      const tombKeys = await this.#kv.list(branchTombPrefix(cursor));
      const fileKeys = await this.#kv.list(branchFilePrefix(cursor));

      for (const k of tombKeys) {
        const path = k.slice(branchTombPrefix(cursor).length);
        if (visited.has(path)) continue;
        visited.add(path);
        const baseContent = await base.read(path);
        if (baseContent !== null) {
          changes.push({ path, kind: "deleted", content: null });
        }
        // tombstone with no base file → no-op (deleting something that
        // wasn't there). Skip silently rather than report a phantom change.
      }
      for (const k of fileKeys) {
        const path = k.slice(branchFilePrefix(cursor).length);
        if (visited.has(path)) continue;
        visited.add(path);
        const ourContent = await this.read(path);
        const baseContent = await base.read(path);
        if (ourContent === null) continue; // tombstoned later in the chain
        if (baseContent === null) {
          changes.push({ path, kind: "added", content: ourContent });
        } else if (baseContent !== ourContent) {
          changes.push({ path, kind: "modified", content: ourContent });
        }
        // baseContent === ourContent → no change recorded
      }
      cursor = await this.#parentOf(cursor);
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));
    return changes;
  }

  /**
   * Merge another branch into this one.
   *
   * The other branch must share an ancestor with this one (typically: both
   * forked off the same parent). The merge base is the nearest common
   * ancestor; we diff each side against that base and apply non-conflicting
   * changes from `other` onto `this`.
   *
   * Conflicts are NEVER auto-resolved beyond the explicit `strategy`:
   *   - "fail-on-conflict" (default): conflicts come back in the result;
   *     callers (judge agent, human via approval policy) decide.
   *   - "ours": keep this branch's version; other-side change is dropped.
   *   - "theirs": apply the other side's change verbatim.
   *
   * Three-way content merging (line-level) is intentionally out of scope —
   * the v3 plan says "leave conflicts to humans / judge", and a built-in
   * 3-way merge is its own correctness footgun.
   */
  async merge(
    other: BranchableWorkspace,
    strategy: MergeStrategy = "fail-on-conflict"
  ): Promise<MergeResult> {
    const base = await this.#commonAncestor(other);
    if (!base) {
      throw new Error(
        `BranchableWorkspace.merge: ${this.#branchId} and ${other.branchId} have no common ancestor`
      );
    }
    const baseWs = new BranchableWorkspace(this.#kv, base);

    const ourChanges = await this.diff(baseWs);
    const theirChanges = await other.diff(baseWs);
    const ourMap = new Map(ourChanges.map((c) => [c.path, c]));
    const applied: string[] = [];
    const conflicts: MergeConflict[] = [];

    for (const t of theirChanges) {
      const o = ourMap.get(t.path);
      if (!o) {
        // Only "theirs" touched this file — apply directly.
        if (t.kind === "deleted") {
          await this.remove(t.path);
        } else if (t.content !== null) {
          await this.write(t.path, t.content);
        }
        applied.push(t.path);
        continue;
      }
      // Both sides changed the same path — figure out the conflict shape.
      const conflict = classifyConflict(o, t);
      if (!conflict) {
        // Identical changes (same write, both delete) — collapse silently.
        applied.push(t.path);
        continue;
      }
      if (strategy === "fail-on-conflict") {
        conflicts.push(conflict);
        continue;
      }
      if (strategy === "theirs") {
        if (t.kind === "deleted") await this.remove(t.path);
        else if (t.content !== null) await this.write(t.path, t.content);
        applied.push(t.path);
      } else {
        // "ours" — keep this branch's state untouched; record as applied so
        // callers can see we considered it.
        applied.push(t.path);
      }
    }

    return { applied, conflicts };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  async #parentOf(branchId: string): Promise<string | null> {
    const raw = await this.#kv.get(metaKey(branchId));
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as BranchMeta).parent;
    } catch {
      return null;
    }
  }

  async #ancestorChain(branchId: string): Promise<string[]> {
    const chain: string[] = [];
    let cursor: string | null = branchId;
    while (cursor) {
      chain.push(cursor);
      cursor = await this.#parentOf(cursor);
    }
    return chain;
  }

  async #isAncestor(candidate: string): Promise<boolean> {
    if (candidate === this.#branchId) return true;
    const chain = await this.#ancestorChain(this.#branchId);
    return chain.includes(candidate);
  }

  async #commonAncestor(other: BranchableWorkspace): Promise<string | null> {
    const ours = new Set(await this.#ancestorChain(this.#branchId));
    const theirs = await this.#ancestorChain(other.branchId);
    for (const id of theirs) {
      if (ours.has(id)) return id;
    }
    return null;
  }
}

/**
 * Classify how two same-path changes collide. Returns null when the changes
 * are identical (same content write, or both deletes) — in that case there
 * is no conflict to surface.
 */
function classifyConflict(ours: FileChange, theirs: FileChange): MergeConflict | null {
  // Both deleted → no conflict.
  if (ours.kind === "deleted" && theirs.kind === "deleted") return null;
  // Identical content writes → no conflict.
  if (
    (ours.kind === "added" || ours.kind === "modified") &&
    (theirs.kind === "added" || theirs.kind === "modified") &&
    ours.content === theirs.content
  ) {
    return null;
  }
  // Modified vs deleted (either direction) — different shape, separate label.
  if (ours.kind === "deleted" && (theirs.kind === "added" || theirs.kind === "modified")) {
    return {
      path: ours.path,
      ours: null,
      theirs: theirs.content,
      reason: "deleted-vs-modified",
    };
  }
  if (theirs.kind === "deleted" && (ours.kind === "added" || ours.kind === "modified")) {
    return { path: ours.path, ours: ours.content, theirs: null, reason: "modified-vs-deleted" };
  }
  // Both modified or both added with different content.
  return { path: ours.path, ours: ours.content, theirs: theirs.content, reason: "both-modified" };
}

/**
 * Open the canonical root branch on `kv`, creating it the first time. The
 * root has `parent = null`; child forks point back here.
 */
export async function openOrCreateRoot(
  kv: KvBackend,
  rootId = "root"
): Promise<BranchableWorkspace> {
  const ws = new BranchableWorkspace(kv, rootId);
  await ws.init(null);
  return ws;
}
