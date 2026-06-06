/**
 * Action IR — language-neutral directed graph for agent planning (C2).
 *
 * The scheduler converts a planning step's text plan into a DAG of
 * tool nodes + data-dependency edges, then executes independent nodes
 * in parallel (replacing smolagents' strict serial while loop).
 *
 * The Scheduler implements wave-based parallel DAG execution (C2).
 */

export interface IRNode {
  id: string;
  /** Tool to call. */
  toolName: string;
  args: Record<string, unknown>;
  /** IDs of nodes this node depends on (must complete before this can run). */
  dependsOn: string[];
  /**
   * True = safe for speculative pre-execution (C3).
   *
   * ⚠️  Resource conflict warning: the Scheduler does NOT detect conflicts between
   * !readOnly nodes. Two !idempotent nodes without a dependsOn relationship will
   * be executed in parallel. If they may touch the same external resource, add a
   * dependsOn edge to serialise them — the Scheduler cannot infer this for you.
   */
  readOnly: boolean;
  idempotent: boolean;
  /**
   * Named capabilities granted for this node's tool call (A2 extraCapabilities).
   * Forwarded to ToolRegistry.call() so capability-gated tools can be invoked.
   */
  extraCapabilities?: string[];
}

export interface ActionIR {
  nodes: IRNode[];
  /** Serialisable + replayable (C2 DoD). */
  toJSON(): object;
}

export class SimpleIR implements ActionIR {
  constructor(readonly nodes: IRNode[]) {}

  toJSON(): object {
    return { nodes: this.nodes };
  }

  static fromJSON(data: { nodes: IRNode[] }): SimpleIR {
    return new SimpleIR(data.nodes);
  }
}
