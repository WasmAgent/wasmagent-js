import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ActionIR, IRNode } from "./ir.js";

/**
 * Scheduler (C1/C2 skeleton).
 *
 * M0/M1: serial execution of a flat node list (mirrors smolagents baseline).
 * M2: true DAG scheduling — topological sort, parallel independent nodes.
 */
export class Scheduler {
  constructor(private readonly tools: ToolRegistry) {}

  async *execute(ir: ActionIR): AsyncGenerator<SchedulerEvent> {
    // M0: Serial execution in node order.
    for (const node of ir.nodes) {
      yield { type: "node_start", nodeId: node.id };
      const result = await this.tools.call({
        toolName: node.toolName,
        args: node.args,
        callId: node.id,
      });
      yield { type: "node_done", nodeId: node.id, result };
    }
  }
}

export interface SchedulerEvent {
  type: "node_start" | "node_done";
  nodeId: string;
  result?: unknown;
}
