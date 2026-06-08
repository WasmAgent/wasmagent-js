/**
 * Derives dependsOn edges from inter-call output references within a single
 * parallel tool-call batch.
 *
 * Reference syntax: a string value of exactly `$<callId>` in a tool's input
 * means "the output of call <callId> must be available before this call runs."
 *
 * Example: if call B has input { sourceId: "$call-A" }, then B dependsOn ["call-A"].
 */

export interface CallDescriptor {
  id: string;
  input: Record<string, unknown>;
}

/**
 * Returns a Map<callId, dependsOnIds[]> for every call in the batch.
 * Throws if circular dependencies are detected (deadlock prevention).
 */
export function deriveDependencies(calls: CallDescriptor[]): Map<string, string[]> {
  const callIds = new Set(calls.map((c) => c.id));
  const deps = new Map<string, string[]>();

  for (const call of calls) {
    const referenced = collectRefs(call.input, callIds, call.id);
    deps.set(call.id, referenced);
  }

  detectCycles(deps);
  return deps;
}

/** Recursively scan a value for $<callId> references. */
function collectRefs(value: unknown, callIds: Set<string>, selfId: string): string[] {
  const found = new Set<string>();

  function walk(v: unknown): void {
    if (typeof v === "string") {
      const m = /^\$(.+)$/.exec(v);
      if (m && m[1] !== selfId && callIds.has(m[1]!)) {
        found.add(m[1]!);
      }
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v !== null && typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) walk(val);
    }
  }

  walk(value);
  return [...found];
}

/**
 * C1: Recursively replace $<callId> references in args with the actual
 * completed node result. Supports whole-value replacement only (not sub-field
 * path notation). Reuses the same regex as collectRefs for consistency.
 *
 * Pure-ordering uses (no $ref strings) pass through unchanged.
 */
export function resolveRefs(value: unknown, completed: Map<string, unknown>): unknown {
  if (typeof value === "string") {
    const m = /^\$(.+)$/.exec(value);
    if (m && completed.has(m[1]!)) {
      return completed.get(m[1]!);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveRefs(item, completed));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveRefs(v, completed);
    }
    return result;
  }
  return value;
}
function detectCycles(deps: Map<string, string[]>): void {
  const inDegree = new Map<string, number>();
  for (const id of deps.keys()) inDegree.set(id, 0);
  for (const edges of deps.values()) {
    for (const dep of edges) {
      inDegree.set(dep, inDegree.get(dep) ?? 0); // dep must exist as node
    }
  }
  // Build reverse: dep -> nodes that depend on it
  const revAdj = new Map<string, string[]>();
  for (const [id, edges] of deps) {
    for (const dep of edges) {
      const cur = revAdj.get(dep) ?? [];
      cur.push(id);
      revAdj.set(dep, cur);
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    processed++;
    for (const neighbor of revAdj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (processed < deps.size) {
    const cycle = [...inDegree.entries()].filter(([, d]) => d > 0).map(([id]) => id);
    throw new Error(`Circular dependency detected among tool calls: [${cycle.join(", ")}]`);
  }
}
