import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { SubagentRunnable } from "@agentkit-js/core";
import type { A2AAgentCard, A2AServer, A2AServerOptions, A2ATaskRequest, A2ATaskResponse } from "./types.js";

/**
 * A2A HTTP server — exposes a SubagentRunnable as an A2A v1.0 compliant agent.
 *
 * Endpoints:
 *   GET  /.well-known/agent-card  → Agent Card JSON
 *   POST /tasks                    → Submit a task, returns streaming NDJSON or single JSON
 *
 * Usage:
 *   const agent = new ToolCallingAgent({ ... });
 *   const server = createA2AServer(agent, {
 *     agentId: "https://example.com/agents/my-agent",
 *     name: "My Agent",
 *     description: "Does things",
 *     port: 3000,
 *   });
 *   const url = await server.start();
 *   console.log(`A2A agent running at ${url}`);
 */
export function createA2AServer(
  agent: SubagentRunnable,
  opts: A2AServerOptions
): A2AServer {
  const port = opts.port ?? 3000;
  const baseUrl = `http://localhost:${port}`;

  const card: A2AAgentCard = {
    id: opts.agentId,
    name: opts.name,
    description: opts.description,
    protocolVersion: "1.0",
    capabilities: {
      skills: opts.skills ?? [],
      streaming: true,
      stateful: false,
    },
    taskEndpoint: `${baseUrl}/tasks`,
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers for browser agents.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", baseUrl);

    // Agent Card endpoint.
    if (req.method === "GET" && url.pathname === "/.well-known/agent-card") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(card));
      return;
    }

    // Task submission endpoint.
    if (req.method === "POST" && url.pathname === "/tasks") {
      let body = "";
      for await (const chunk of req) body += chunk;

      let taskReq: A2ATaskRequest;
      try {
        taskReq = JSON.parse(body) as A2ATaskRequest;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      const acceptsStreaming = req.headers["accept"]?.includes("application/x-ndjson");

      if (acceptsStreaming) {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Transfer-Encoding": "chunked",
          "Cache-Control": "no-cache",
        });

        try {
          for await (const event of agent.run(taskReq.message, taskReq.parentId ?? null)) {
            const delta: A2ATaskResponse = {
              taskId: taskReq.id,
              status: "running",
            };
            if (event.event === "final_answer") {
              delta.status = "completed";
              delta.result = event.data.answer;
            } else if (event.event === "error") {
              delta.status = "failed";
              delta.error = event.data.error;
            } else if (event.event === "step_start") {
              delta.delta = `[step ${(event.data as { step: number }).step}]`;
            }
            res.write(JSON.stringify(delta) + "\n");
            if (delta.status === "completed" || delta.status === "failed") break;
          }
        } catch (err) {
          const errResp: A2ATaskResponse = {
            taskId: taskReq.id,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          };
          res.write(JSON.stringify(errResp) + "\n");
        }
        res.end();
      } else {
        // Non-streaming: collect to final answer.
        let finalResult: unknown = null;
        let errorMsg: string | null = null;

        try {
          for await (const event of agent.run(taskReq.message, taskReq.parentId ?? null)) {
            if (event.event === "final_answer") finalResult = event.data.answer;
            else if (event.event === "error") errorMsg = event.data.error;
          }
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : String(err);
        }

        const resp: A2ATaskResponse = errorMsg !== null
          ? { taskId: taskReq.id, status: "failed", error: errorMsg }
          : { taskId: taskReq.id, status: "completed", result: finalResult };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return {
    agentCard(): A2AAgentCard { return card; },

    start(): Promise<string> {
      return new Promise((resolve, reject) => {
        server.listen(port, () => resolve(baseUrl));
        server.once("error", reject);
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    },
  };
}
