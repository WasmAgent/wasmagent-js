/**
 * Action IR — language-neutral directed graph for agent planning (C2).
 *
 * The scheduler converts a planning step's text plan into a DAG of
 * tool nodes + data-dependency edges, then executes independent nodes
 * in parallel (replacing smolagents' strict serial while loop).
 *
 * Status: Skeleton — full DAG scheduling lands in M2.
 */

export interface IRNode {
  id: string;
  /** Tool to call. */
  toolName: string;
  args: Record<string, unknown>;
  /** IDs of nodes this node depends on (must complete before this can run). */
  dependsOn: string[];
  /** True = safe for speculative pre-execution (C3). */
  readOnly: boolean;
  idempotent: boolean;
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
