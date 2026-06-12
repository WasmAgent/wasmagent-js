/**
 * F1 — McpAgentServer: serve any SubagentRunnable over MCP JSON-RPC.
 */

import type { AgentEvent } from "@agentkit-js/core";
import { InMemoryTaskStore } from "./taskStore.js";
import type {
  McpAgentServerOptions,
  McpHandleResult,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpServerInfo,
  McpTaskRecord,
  McpTaskStore,
  McpToolEntry,
} from "./types.js";

// ── Spec constants ──────────────────────────────────────────────────────────

/**
 * The protocol revision we declare in `initialize.result.protocolVersion`.
 * Keeping it as the 2025-11-25 stable date matches what production hosts
 * expect; the 2026-07-28 RC accepts older protocolVersion strings during the
 * deprecation window, so we don't need a runtime switch.
 */
const PROTOCOL_VERSION = "2025-11-25";

const DEFAULT_TOOL_NAME = "run_agent";
const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_SYNC_TIMEOUT_MS = 25_000;

// JSON-RPC error codes (subset of the MCP-extended set).
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;
// MCP-specific extensions:
const ERR_TASK_NOT_FOUND = -32010;
const ERR_TOOL_NOT_FOUND = -32011;
const ERR_TASK_NOT_AWAITING = -32012;

// ── Class ───────────────────────────────────────────────────────────────────

export class McpAgentServer {
  readonly #serverInfo: McpServerInfo;
  readonly #agent: McpAgentServerOptions["agent"];
  readonly #toolMap: Map<string, McpToolEntry>;
  readonly #taskStore: McpTaskStore;
  readonly #maxEvents: number;
  readonly #allowSync: boolean;
  readonly #syncTimeoutMs: number;

  constructor(opts: McpAgentServerOptions) {
    this.#serverInfo = opts.serverInfo;
    this.#agent = opts.agent;
    const tools = opts.tools ?? [defaultTool()];
    this.#toolMap = new Map(tools.map((t) => [t.name, t]));
    this.#taskStore = opts.taskStore ?? new InMemoryTaskStore();
    this.#maxEvents = opts.maxEventsPerTask ?? DEFAULT_MAX_EVENTS;
    this.#allowSync = opts.allowSyncCalls ?? true;
    this.#syncTimeoutMs = opts.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  }

  /** Visible for diagnostics / tests. */
  get serverInfo(): McpServerInfo {
    return this.#serverInfo;
  }

  /**
   * Handle a single JSON-RPC request. Returns the wire response and an
   * optional task id when a long-task was created or escalated to.
   */
  async handle(req: unknown): Promise<McpHandleResult> {
    const parsed = parseRequest(req);
    if ("error" in parsed) {
      return { response: parsed.error };
    }
    const request = parsed.request;
    try {
      switch (request.method) {
        case "initialize":
          return ok(request.id, this.#initialize());
        case "tools/list":
          return ok(request.id, this.#toolsList());
        case "tools/call":
          return await this.#toolsCall(request);
        case "tasks/create":
          return await this.#tasksCreate(request);
        case "tasks/get":
          return await this.#tasksGet(request);
        case "tasks/cancel":
          return await this.#tasksCancel(request);
        case "tasks/respond":
          return await this.#tasksRespond(request);
        case "tasks/list":
          return await this.#tasksList(request);
        case "ping":
          return ok(request.id, {});
        default:
          return errResponse(
            request.id ?? null,
            ERR_METHOD_NOT_FOUND,
            `Unknown method ${request.method}`
          );
      }
    } catch (err) {
      // Top-level catch so a buggy handler can't crash the host; surface as
      // an MCP error code instead.
      //
      // Honour `err.code` when the thrower is an MCP-typed error (e.g.
      // `McpInvalidParams`, code = -32602): the JSON-RPC contract is that
      // the wire code matches the failure category, not a generic INTERNAL.
      // Discovery: examples/integration-smoke/edge-mcp-protocol.mjs
      // observed -32603 for a missing-`name`-param call where -32602 is
      // required.
      const errCode =
        err && typeof err === "object" && typeof (err as { code?: unknown }).code === "number"
          ? ((err as { code: number }).code as number)
          : ERR_INTERNAL;
      return errResponse(
        request.id ?? null,
        errCode,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── method implementations ────────────────────────────────────────────────

  #initialize(): unknown {
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: {
        name: this.#serverInfo.name,
        version: this.#serverInfo.version,
        ...(this.#serverInfo.description ? { description: this.#serverInfo.description } : {}),
      },
      capabilities: {
        // Every server we ship is a tool server with Tasks support; there
        // are no prompts/resources/sampling on this side of the wire.
        tools: { listChanged: false },
        tasks: { create: true, cancel: true, respond: true },
      },
    };
  }

  #toolsList(): unknown {
    const tools = [...this.#toolMap.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.longRunning ? { _meta: { longRunning: true } } : {}),
    }));
    return { tools };
  }

  async #toolsCall(req: McpJsonRpcRequest): Promise<McpHandleResult> {
    const { name, args } = readToolCallParams(req);
    const tool = this.#toolMap.get(name);
    if (!tool) return errResponse(req.id ?? null, ERR_TOOL_NOT_FOUND, `Unknown tool ${name}`);

    if (!this.#allowSync || tool.longRunning) {
      // Caller asked us not to block, or the tool is declared long-running:
      // immediately route to the Tasks API and return the task id.
      const id = await this.#startTask(tool, args);
      return {
        response: jsonResponse(req.id ?? null, {
          // Per MCP 2025-11, a sync call routed to a task returns this shape.
          _meta: { taskId: id },
          content: [
            { type: "text", text: `Long-running task started; poll tasks/get with id ${id}` },
          ],
          isError: false,
        }),
        taskId: id,
      };
    }

    // Sync path: race the run against the timeout.
    const task = newTaskRecord(tool, args);
    const ac = new AbortController();
    const runPromise = this.#runOnce(task, ac.signal);
    let timedOut = false;
    const timeout = new Promise<"timeout">((resolve) => {
      const t = setTimeout(() => {
        timedOut = true;
        resolve("timeout");
      }, this.#syncTimeoutMs);
      // Don't keep the event loop alive solely for this timer.
      if (typeof t === "object" && t && "unref" in t && typeof t.unref === "function") t.unref();
    });
    const settled = await Promise.race([runPromise, timeout]);
    if (settled === "timeout") {
      // Persist what we have so far and let the host poll the task.
      ac.abort();
      // Best-effort: wait briefly for the agent's generator to wind down so
      // the persisted record reflects whatever it last yielded.
      await Promise.race([
        runPromise.catch(() => undefined),
        new Promise((r) => setTimeout(r, 50)),
      ]);
      task.state = task.state === "complete" || task.state === "failed" ? task.state : "running";
      await this.#persist(task);
      return {
        response: jsonResponse(req.id ?? null, {
          _meta: { taskId: task.id },
          content: [
            {
              type: "text",
              text: `Sync timeout after ${this.#syncTimeoutMs}ms; continue via tasks/get id=${task.id}`,
            },
          ],
          isError: false,
        }),
        taskId: task.id,
      };
    }
    if (timedOut) {
      // race won by something else but we already aborted — still surface task.
      return {
        response: jsonResponse(req.id ?? null, { _meta: { taskId: task.id } }),
        taskId: task.id,
      };
    }
    return {
      response: jsonResponse(req.id ?? null, {
        content: toContentBlocks(task),
        isError: task.state === "failed",
      }),
    };
  }

  async #tasksCreate(req: McpJsonRpcRequest): Promise<McpHandleResult> {
    const { name, args } = readToolCallParams(req);
    const tool = this.#toolMap.get(name);
    if (!tool) return errResponse(req.id ?? null, ERR_TOOL_NOT_FOUND, `Unknown tool ${name}`);
    const id = await this.#startTask(tool, args);
    return { response: jsonResponse(req.id ?? null, { id, state: "pending" }), taskId: id };
  }

  async #tasksGet(req: McpJsonRpcRequest): Promise<McpHandleResult> {
    const id = stringParam(req, "id");
    const rec = await this.#taskStore.get(id);
    if (!rec) return errResponse(req.id ?? null, ERR_TASK_NOT_FOUND, `Task ${id} not found`);
    return { response: jsonResponse(req.id ?? null, projectRecord(rec)) };
  }

  async #tasksCancel(req: McpJsonRpcRequest): Promise<McpHandleResult> {
    const id = stringParam(req, "id");
    const rec = await this.#taskStore.get(id);
    if (!rec) return errResponse(req.id ?? null, ERR_TASK_NOT_FOUND, `Task ${id} not found`);
    if (rec.state !== "complete" && rec.state !== "failed") {
      rec.state = "failed";
      rec.error = "cancelled by host";
      await this.#persist(rec);
    }
    return { response: jsonResponse(req.id ?? null, { id, state: rec.state }) };
  }

  async #tasksRespond(req: McpJsonRpcRequest): Promise<McpHandleResult> {
    // The MCP elicitation flow: server emitted `pendingElicitation`; the host
    // calls tasks/respond with { id, response }. We currently only record the
    // response — the agent's await_human_input integration is performed by
    // the consumer who plugs this into a CheckpointableRun. That keeps the
    // boundary clean: F1 surfaces elicitation; resume mechanics live in core.
    const id = stringParam(req, "id");
    const response = (req.params?.response as string | undefined) ?? "";
    const rec = await this.#taskStore.get(id);
    if (!rec) return errResponse(req.id ?? null, ERR_TASK_NOT_FOUND, `Task ${id} not found`);
    if (rec.state !== "awaiting-input" || !rec.pendingElicitation) {
      return errResponse(
        req.id ?? null,
        ERR_TASK_NOT_AWAITING,
        `Task ${id} is not awaiting elicitation`
      );
    }
    rec.events.push({
      traceId: rec.id,
      parentTraceId: null,
      timestampMs: 0,
      channel: "status",
      event: "human_response",
      data: { promptId: rec.pendingElicitation.promptId, response },
    } as unknown as AgentEvent);
    delete rec.pendingElicitation;
    rec.state = "running";
    await this.#persist(rec);
    return { response: jsonResponse(req.id ?? null, { id, state: rec.state }) };
  }

  async #tasksList(req: McpJsonRpcRequest): Promise<McpHandleResult> {
    if (!this.#taskStore.list) {
      return errResponse(req.id ?? null, ERR_METHOD_NOT_FOUND, "Task store does not enumerate");
    }
    const ids = await this.#taskStore.list();
    const records = await Promise.all(ids.map((id) => this.#taskStore.get(id)));
    return {
      response: jsonResponse(req.id ?? null, {
        tasks: records.filter(Boolean).map((r) => projectRecord(r as McpTaskRecord)),
      }),
    };
  }

  // ── task lifecycle ────────────────────────────────────────────────────────

  async #startTask(tool: McpToolEntry, args: Record<string, unknown>): Promise<string> {
    const task = newTaskRecord(tool, args);
    await this.#persist(task);
    // Kick off the run in the background; we never await it here.
    void this.#runOnce(task, undefined).catch(async (err) => {
      task.state = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      await this.#persist(task).catch(() => undefined);
    });
    return task.id;
  }

  async #runOnce(task: McpTaskRecord, signal: AbortSignal | undefined): Promise<void> {
    task.state = "running";
    await this.#persist(task);
    const tool = this.#toolMap.get(task.toolName);
    if (!tool) {
      task.state = "failed";
      task.error = `tool ${task.toolName} disappeared mid-run`;
      await this.#persist(task);
      return;
    }
    const taskString =
      tool.resolveTask != null
        ? tool.resolveTask(task.input)
        : defaultResolveTask(tool, task.input);
    try {
      for await (const ev of this.#agent.run(taskString, null)) {
        if (signal?.aborted) {
          task.state = "failed";
          task.error = "aborted";
          await this.#persist(task);
          return;
        }
        // Bound the events array.
        if (task.events.length >= this.#maxEvents) {
          // Always keep the latest 'final_answer' or 'error' if it lands in
          // the truncated tail — drop the oldest non-terminal event.
          task.events.shift();
        }
        task.events.push(ev);
        if (ev.event === "await_human_input") {
          task.state = "awaiting-input";
          task.pendingElicitation = {
            promptId: ev.data.promptId,
            prompt: ev.data.prompt,
          };
          await this.#persist(task);
          return;
        }
        if (ev.event === "final_answer") {
          task.state = "complete";
          task.result = ev.data.answer;
          await this.#persist(task);
          return;
        }
        if (ev.event === "error") {
          task.state = "failed";
          task.error = ev.data.error;
          await this.#persist(task);
          return;
        }
        // Persist periodically so a host poll mid-run sees fresh progress.
        if (task.events.length % 5 === 0) await this.#persist(task);
      }
      // Generator exited without terminal — treat as failed for clarity.
      if (task.state === "running") {
        task.state = "failed";
        task.error = "agent terminated without final_answer";
        await this.#persist(task);
      }
    } catch (err) {
      task.state = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      await this.#persist(task);
    }
  }

  async #persist(task: McpTaskRecord): Promise<void> {
    task.version++;
    await this.#taskStore.put(task);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function defaultTool(): McpToolEntry {
  return {
    name: DEFAULT_TOOL_NAME,
    description:
      "Run the underlying agentkit-js agent on a free-form task and return its final answer.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What you want the agent to do." },
      },
      required: ["task"],
      additionalProperties: false,
    },
  };
}

function defaultResolveTask(tool: McpToolEntry, input: Record<string, unknown>): string {
  if (tool.name === DEFAULT_TOOL_NAME) {
    const t = input.task;
    if (typeof t !== "string" || !t.length) {
      throw new Error(`run_agent requires a non-empty 'task' string; got ${JSON.stringify(t)}`);
    }
    return t;
  }
  return JSON.stringify(input);
}

function newTaskRecord(tool: McpToolEntry, input: Record<string, unknown>): McpTaskRecord {
  return {
    id: `t-${Math.floor(Math.random() * 1e9).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    toolName: tool.name,
    input,
    state: "pending",
    events: [],
    version: 0,
  };
}

function readToolCallParams(req: McpJsonRpcRequest): {
  name: string;
  args: Record<string, unknown>;
} {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const name = params.name;
  if (typeof name !== "string" || !name.length) {
    throw new McpInvalidParams("'name' is required and must be a string");
  }
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new McpInvalidParams("'arguments' must be an object");
  }
  return { name, args };
}

function stringParam(req: McpJsonRpcRequest, name: string): string {
  const v = req.params?.[name];
  if (typeof v !== "string" || !v.length) {
    throw new McpInvalidParams(`'${name}' must be a non-empty string`);
  }
  return v;
}

class McpInvalidParams extends Error {
  readonly code = ERR_INVALID_PARAMS;
}

function projectRecord(rec: McpTaskRecord): unknown {
  // What the host sees. We expose state, the latest event tail, and the
  // result/error/elicitation when present. We deliberately do NOT echo back
  // the input — it's already on the host's side and would just bloat polls.
  return {
    id: rec.id,
    toolName: rec.toolName,
    state: rec.state,
    events: rec.events,
    ...(rec.result !== undefined ? { result: rec.result } : {}),
    ...(rec.error ? { error: rec.error } : {}),
    ...(rec.pendingElicitation ? { elicitation: rec.pendingElicitation } : {}),
    version: rec.version,
  };
}

function toContentBlocks(rec: McpTaskRecord): Array<{ type: "text"; text: string }> {
  if (rec.error) return [{ type: "text", text: rec.error }];
  if (rec.result === undefined) return [{ type: "text", text: "" }];
  const text = typeof rec.result === "string" ? rec.result : JSON.stringify(rec.result, null, 2);
  return [{ type: "text", text }];
}

function jsonResponse(
  id: McpJsonRpcRequest["id"] extends infer _ ? unknown : never,
  result: unknown
): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id: (id ?? null) as McpJsonRpcResponse["id"], result };
}

function ok(id: McpJsonRpcRequest["id"], result: unknown): McpHandleResult {
  return { response: { jsonrpc: "2.0", id: id ?? null, result } };
}

function errResponse(id: McpJsonRpcResponse["id"], code: number, message: string): McpHandleResult {
  return { response: { jsonrpc: "2.0", id, error: { code, message } } };
}

function parseRequest(
  raw: unknown
): { request: McpJsonRpcRequest } | { error: McpJsonRpcResponse } {
  if (raw == null || typeof raw !== "object") {
    return {
      error: {
        jsonrpc: "2.0",
        id: null,
        error: { code: ERR_PARSE, message: "request must be an object" },
      },
    };
  }
  const obj = raw as Partial<McpJsonRpcRequest>;
  if (obj.jsonrpc !== "2.0" || typeof obj.method !== "string") {
    return {
      error: {
        jsonrpc: "2.0",
        id: (obj.id ?? null) as McpJsonRpcResponse["id"],
        error: { code: ERR_INVALID_REQUEST, message: "missing jsonrpc:'2.0' or method" },
      },
    };
  }
  return { request: obj as McpJsonRpcRequest };
}
