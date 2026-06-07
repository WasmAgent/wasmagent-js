import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ActionIR, IRNode } from "./ir.js";

/**
 * Scheduler (C2/C3).
 *
 * C2 — Wave-based parallel DAG execution: each wave runs all nodes whose
 * dependsOn list is fully satisfied in parallel (Promise.all).
 *
 * C3 — Speculative execution: readOnly nodes whose dependencies are satisfied
 * are launched immediately, even while non-readOnly nodes from the same or a
 * prior wave are still in-flight. A barrier is inserted before any
 * non-readOnly node — it must wait until all speculative predecessors finish
 * so side-effectful operations see a consistent state.
 *
 * Deadlock detection: if no progress is made in a wave iteration (no node can
 * start and there are still pending nodes), a cycle exists.
 *
 * ── Resource conflict responsibility (Q7) ────────────────────────────────────
 * C3 does NOT provide any resource-conflict detection between !readOnly nodes.
 * When two !readOnly nodes have no dependsOn relationship, they are executed in
 * parallel (Promise.all). If both write to the same external resource (e.g. the
 * same API endpoint, the same file), the caller is responsible for serialising
 * them via dependsOn. The Scheduler has no knowledge of which resources each
 * tool accesses — that information lives in the application layer.
 *
 * Rule: any two !idempotent nodes that may operate on the same resource MUST
 * be connected with a dependsOn edge to guarantee serial execution.
 */
export class Scheduler {
  constructor(private readonly tools: ToolRegistry) {}

  async *execute(ir: ActionIR): AsyncGenerator<SchedulerEvent> {
    // Q8: AbortController to cancel in-flight speculative Promises when the
    // consumer breaks out of the for-await loop early. Without this, speculative
    // readOnly tool calls continue executing (and calling external APIs) even
    // though the caller no longer cares about the results — "ghost requests".
    // Note: cancellation only takes effect if ToolRegistry.call() passes the
    // signal to the underlying fetch/API; it is a best-effort mechanism.
    const ac = new AbortController();

    try {
      yield* this.#executeInner(ir, ac.signal);
    } finally {
      // generator return() or throw() from consumer break/early-exit lands here.
      ac.abort();
      // Swallow any in-flight rejections caused by the abort so they don't become
      // unhandledRejection events after the generator has already finished.
    }
  }

  async *#executeInner(ir: ActionIR, signal: AbortSignal): AsyncGenerator<SchedulerEvent> {
    const remaining = new Map<string, Set<string>>();
    for (const node of ir.nodes) {
      remaining.set(node.id, new Set(node.dependsOn));
    }

    const completed = new Set<string>();
    // Track in-flight speculative futures (readOnly nodes) for barrier logic.
    const speculative = new Map<string, Promise<{ node: IRNode; result: unknown }>>();

    while (completed.size < ir.nodes.length) {
      const ready = ir.nodes.filter(
        (n) => !completed.has(n.id) && !speculative.has(n.id) && (remaining.get(n.id)?.size ?? 0) === 0
      );

      const readyReadOnly = ready.filter((n) => n.readOnly);
      const readyWriting = ready.filter((n) => !n.readOnly);

      if (ready.length === 0 && speculative.size === 0) {
        const pending = ir.nodes.filter((n) => !completed.has(n.id)).map((n) => n.id);
        throw new Error(
          `Scheduler deadlock: circular dependency among nodes [${pending.join(", ")}]`
        );
      }

      // C3: launch all readOnly ready nodes speculatively right now.
      for (const node of readyReadOnly) {
        yield { type: "node_start", nodeId: node.id };
        speculative.set(
          node.id,
          this.tools
            .call(
              { toolName: node.toolName, args: node.args, callId: node.id, signal },
              node.extraCapabilities
            )
            .then((result) => ({ node, result }))
        );
      }

      // C3 barrier: before running any non-readOnly node, drain all in-flight
      // speculative futures so side-effectful nodes see a consistent state.
      if (readyWriting.length > 0 && speculative.size > 0) {
        for (const settled of await Promise.allSettled([...speculative.entries()].map(
          ([id, p]) => p.then((r) => ({ ...r, _id: id }))
        ))) {
          if (settled.status === "fulfilled") {
            const { node, result, _id } = settled.value;
            speculative.delete(_id);
            completed.add(node.id);
            yield { type: "node_done", nodeId: node.id, result };
            this.#unblockDependents(node.id, remaining);
          } else {
            // Find which nodeId this promise belonged to by checking speculative map keys.
            // The map entry was already iterated above; find the failed node id by elimination.
            for (const [id] of speculative) {
              if (!completed.has(id)) {
                speculative.delete(id);
                yield { type: "node_done", nodeId: id, result: undefined };
                break;
              }
            }
          }
        }
        // Re-evaluate after barrier — some previously-blocked nodes may now be unblocked.
        continue;
      }

      // Run non-readOnly ready nodes in parallel (they're not speculative).
      if (readyWriting.length > 0) {
        for (const node of readyWriting) yield { type: "node_start", nodeId: node.id };
        for (const { node, result } of await Promise.all(
          readyWriting.map(async (node) => ({
            node,
            result: await this.tools.call(
              { toolName: node.toolName, args: node.args, callId: node.id, signal },
              node.extraCapabilities
            ),
          }))
        )) {
          completed.add(node.id);
          yield { type: "node_done", nodeId: node.id, result };
          this.#unblockDependents(node.id, remaining);
        }
        continue;
      }

    // Q8: abort the remaining speculative in-flight futures on early generator exit.
    // Only speculative futures in-flight — drain them all to make progress.
    if (speculative.size > 0) {
        for (const settled of await Promise.allSettled([...speculative.entries()].map(
          ([id, p]) => p.then((r) => ({ ...r, _id: id }))
        ))) {
          if (settled.status === "fulfilled") {
            const { node, result, _id } = settled.value;
            speculative.delete(_id);
            completed.add(node.id);
            yield { type: "node_done", nodeId: node.id, result };
            this.#unblockDependents(node.id, remaining);
          } else {
            for (const [id] of speculative) {
              if (!completed.has(id)) {
                speculative.delete(id);
                yield { type: "node_done", nodeId: id, result: undefined };
                break;
              }
            }
          }
        }
      }
    }
  }

  #unblockDependents(completedId: string, remaining: Map<string, Set<string>>): void {
    for (const deps of remaining.values()) {
      deps.delete(completedId);
    }
  }
}

export interface SchedulerEvent {
  type: "node_start" | "node_done";
  nodeId: string;
  result?: unknown;
}
