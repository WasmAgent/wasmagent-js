/**
 * AgentDurableObject — Cloudflare Durable Object for long-running
 * agent runs.
 *
 * Why: standard Workers have a hard 30s CPU / 5min real-time cap per
 * request. Long agent runs (planning + many tool calls) can exceed
 * that. Durable Objects have no such cap, and they let multiple
 * clients subscribe to the same run via SSE.
 *
 * Usage:
 *   1. Bind in wrangler.toml:
 *      [[durable_objects.bindings]]
 *      name = "AGENT_DO"
 *      class_name = "AgentDurableObject"
 *      [[migrations]]
 *      tag = "v1"
 *      new_classes = ["AgentDurableObject"]
 *
 *   2. From your Worker:
 *      const id = env.AGENT_DO.idFromName(runId);
 *      const stub = env.AGENT_DO.get(id);
 *      return stub.fetch(req);
 *
 *   3. Endpoints handled by the DO:
 *      POST /start    → kick off the run (idempotent)
 *      GET  /stream   → SSE subscribe to in-flight events
 *      GET  /status   → current state JSON
 *      POST /cancel   → cancel the run
 */

import type { AgentEvent } from "@agentkit-js/core";

interface AgentRunRequest {
  task: string;
  agentType?: "code" | "tool-calling";
  maxSteps?: number;
}

export interface AgentDurableState {
  runId: string;
  request: AgentRunRequest | null;
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  events: AgentEvent[];
  finalAnswer: string | null;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

/** Minimal Durable Object base interface. */
export interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export type AgentRunner = (req: AgentRunRequest) => AsyncGenerator<AgentEvent>;

/**
 * Generic AgentDurableObject. Wire it up by passing your own
 * agent-runner factory; the DO owns persistence and SSE fan-out.
 *
 * NOTE: this is a self-contained reference impl. The actual
 * `class_name` you bind in wrangler.toml is whatever you export from
 * your worker entry; this file shows the canonical structure.
 */
export class AgentDurableObject {
  readonly #state: DurableObjectState;
  readonly #runner: AgentRunner;
  // Active SSE subscribers
  readonly #subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  #cached: AgentDurableState | null = null;

  constructor(state: DurableObjectState, runner: AgentRunner) {
    this.#state = state;
    this.#runner = runner;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/start") && request.method === "POST") {
      return this.#handleStart(request);
    }
    if (url.pathname.endsWith("/stream")) return this.#handleStream();
    if (url.pathname.endsWith("/status")) return this.#handleStatus();
    if (url.pathname.endsWith("/cancel") && request.method === "POST") return this.#handleCancel();
    return new Response("not found", { status: 404 });
  }

  async #loadState(): Promise<AgentDurableState> {
    if (this.#cached) return this.#cached;
    const stored = await this.#state.storage.get<AgentDurableState>("state");
    if (stored) {
      this.#cached = stored;
      return stored;
    }
    const fresh: AgentDurableState = {
      runId: crypto.randomUUID(),
      request: null,
      status: "idle",
      events: [],
      finalAnswer: null,
      error: null,
      startedAt: null,
      completedAt: null,
    };
    this.#cached = fresh;
    return fresh;
  }

  async #saveState(): Promise<void> {
    if (this.#cached) await this.#state.storage.put("state", this.#cached);
  }

  async #handleStart(request: Request): Promise<Response> {
    return this.#state.blockConcurrencyWhile(async () => {
      const s = await this.#loadState();
      if (s.status === "running") {
        return new Response(JSON.stringify({ runId: s.runId, status: s.status }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = (await request.json()) as AgentRunRequest;
      s.request = body;
      s.status = "running";
      s.startedAt = Date.now();
      s.events = [];
      s.finalAnswer = null;
      s.error = null;
      s.completedAt = null;
      await this.#saveState();

      // Run async — don't block response.
      void this.#runAgentInBackground(s);

      return new Response(JSON.stringify({ runId: s.runId, status: s.status }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  async #runAgentInBackground(s: AgentDurableState): Promise<void> {
    if (!s.request) return;
    try {
      for await (const ev of this.#runner(s.request)) {
        s.events.push(ev);
        this.#broadcast(ev);
        if (ev.event === "final_answer" && ev.channel === "text") {
          s.finalAnswer = String((ev.data as { answer?: unknown }).answer ?? "");
        }
        // Persist every N events to bound storage I/O.
        if (s.events.length % 10 === 0) await this.#saveState();
      }
      s.status = "completed";
    } catch (e) {
      s.status = "failed";
      s.error = e instanceof Error ? e.message : String(e);
    } finally {
      s.completedAt = Date.now();
      await this.#saveState();
      this.#closeAllSubscribers();
    }
  }

  async #handleStream(): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Replay any events already collected.
    const s = await this.#loadState();
    for (const ev of s.events) {
      writer.write(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`)).catch(() => {});
    }
    if (s.status === "running") {
      this.#subscribers.add(writer);
    } else {
      writer.close().catch(() => {});
    }

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  #broadcast(ev: AgentEvent): void {
    const encoder = new TextEncoder();
    const chunk = encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
    for (const w of this.#subscribers) {
      w.write(chunk).catch(() => {
        this.#subscribers.delete(w);
      });
    }
  }

  #closeAllSubscribers(): void {
    for (const w of this.#subscribers) {
      w.close().catch(() => {});
    }
    this.#subscribers.clear();
  }

  async #handleStatus(): Promise<Response> {
    const s = await this.#loadState();
    return new Response(
      JSON.stringify({
        runId: s.runId,
        status: s.status,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        eventCount: s.events.length,
        finalAnswer: s.finalAnswer,
        error: s.error,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  async #handleCancel(): Promise<Response> {
    const s = await this.#loadState();
    if (s.status === "running") {
      s.status = "cancelled";
      s.completedAt = Date.now();
      await this.#saveState();
      this.#closeAllSubscribers();
    }
    return new Response(JSON.stringify({ runId: s.runId, status: s.status }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
