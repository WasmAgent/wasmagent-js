import type { ToolDefinition } from "@agentkit-js/core";
import { z } from "zod";
import type { A2AAgentCard, A2ATaskRequest, A2ATaskResponse } from "./types.js";

export interface A2ARemoteAgentOptions {
  /** A2A server task endpoint URL. */
  taskEndpoint: string;
  /** Tool name to use when registered in a parent agent. */
  name: string;
  /** Tool description. */
  description: string;
  /** Bearer token or API key for authentication. */
  apiKey?: string;
  /** Request timeout in milliseconds. Default: 60_000. */
  timeoutMs?: number;
}

/**
 * A2ARemoteAgent — wraps a remote A2A agent as a local ToolDefinition.
 *
 * Allows a remote A2A agent to be injected into a ToolCallingAgent as a tool,
 * making cross-framework / cross-organization agent composition seamless.
 *
 * Usage:
 *   const remoteTool = A2ARemoteAgent.asTool({
 *     taskEndpoint: "https://example.com/tasks",
 *     name: "remote_search_agent",
 *     description: "Performs web searches via a remote agent",
 *   });
 *   const parent = new ToolCallingAgent({ tools: [remoteTool], model });
 */
// biome-ignore lint/complexity/noStaticOnlyClass: public API namespace
export class A2ARemoteAgent {
  /**
   * Fetch an Agent Card from a remote A2A server.
   *
   * @param baseUrl - Base URL of the A2A server (without /.well-known/agent-card).
   */
  static async fetchAgentCard(baseUrl: string): Promise<A2AAgentCard> {
    const url = `${baseUrl.replace(/\/$/, "")}/.well-known/agent-card`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to fetch Agent Card from ${url}: HTTP ${resp.status}`);
    }
    return resp.json() as Promise<A2AAgentCard>;
  }

  /**
   * Create a ToolDefinition from a remote A2A agent's options.
   * The resulting tool can be registered in any ToolCallingAgent.
   */
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  static asTool(opts: A2ARemoteAgentOptions): ToolDefinition<any, unknown> {
    const timeoutMs = opts.timeoutMs ?? 60_000;

    return {
      name: opts.name,
      description: opts.description,
      inputSchema: z.object({
        task: z.string().describe("The task to delegate to the remote agent"),
        parentTaskId: z.string().optional().describe("Parent task ID for distributed tracing"),
      }),
      outputSchema: z.unknown(),
      readOnly: false,
      idempotent: false,

      async forward(input: { task: string; parentTaskId?: string }, signal?: AbortSignal) {
        const taskReq: A2ATaskRequest = {
          id: crypto.randomUUID(),
          message: input.task,
          ...(input.parentTaskId ? { parentId: input.parentTaskId } : {}),
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const combinedSignal = signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal;

        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

          const resp = await fetch(opts.taskEndpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(taskReq),
            signal: combinedSignal,
          });

          if (!resp.ok) {
            throw new Error(`A2A remote agent returned HTTP ${resp.status}: ${await resp.text()}`);
          }

          const result = (await resp.json()) as A2ATaskResponse;

          if (result.status === "failed") {
            throw new Error(
              `Remote agent "${opts.name}" failed: ${result.error ?? "unknown error"}`
            );
          }

          return result.result;
        } finally {
          clearTimeout(timeout);
        }
      },
    };
  }
}
