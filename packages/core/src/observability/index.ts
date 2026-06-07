/**
 * OpenTelemetry observability bridge.
 *
 * Bridges AgentEvent streams to OTel-compatible spans without a hard dependency
 * on @opentelemetry/api. The bridge works with any exporter that implements the
 * SpanExporter interface below, including:
 *  - InMemorySpanExporter (for tests)
 *  - OTLP HTTP/gRPC exporters
 *  - ConsoleSpanExporter
 *
 * E1 — OTel GenAI semantic conventions (gen_ai.*):
 * By default the bridge emits BOTH legacy private attributes (task, usage.inputTokens,
 * tool.name, …) AND the standardized gen_ai.* attributes so existing dashboards keep
 * working while Datadog/Honeycomb/Grafana GenAI views are automatically populated.
 *
 * Set `semconvMode: "stable"` to suppress legacy attribute names.
 * Set `semconvMode: "legacy"` to suppress gen_ai.* names (original behavior).
 *
 * Usage:
 *   const exporter = new InMemorySpanExporter();
 *   const bridge = new OtelBridge({ exporter });
 *   for await (const ev of agent.run(task)) {
 *     bridge.record(ev);
 *   }
 *   bridge.flush();
 */

import type { AgentEvent } from "../types/events.js";

// ── Span model (OTel-compatible, no hard dep) ─────────────────────────────────

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

export interface ReadableSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  startTimeMs: number;
  endTimeMs: number | undefined;
  attributes: SpanAttributes;
  status: "ok" | "error" | "unset";
  events: Array<{ name: string; timestampMs: number; attributes?: SpanAttributes }>;
}

export interface SpanExporter {
  export(spans: ReadableSpan[]): void;
}

// ── InMemorySpanExporter ──────────────────────────────────────────────────────

export class InMemorySpanExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[]): void {
    this.spans.push(...spans);
  }
  reset(): void { this.spans.length = 0; }
}

// ── OtelBridge ────────────────────────────────────────────────────────────────

/** No-op exporter used when no exporter is configured. */
const NOOP_EXPORTER: SpanExporter = { export() {} };

/** Counter for monotonic span IDs within this process. */
let _spanCounter = 0;
function nextSpanId(): string {
  return `span-${(++_spanCounter).toString(16).padStart(8, "0")}`;
}

interface LiveSpan {
  span: ReadableSpan;
  /** True = span has been ended and exported. */
  ended: boolean;
}

export interface OtelBridgeOptions {
  exporter?: SpanExporter;
  /**
   * Attribute naming mode (E1 — GenAI semconv).
   *
   * - "both" (default): emit both legacy names (task, usage.inputTokens, tool.name)
   *   AND gen_ai.* semconv names. Backward-compatible while enabling GenAI dashboards.
   * - "stable": emit only gen_ai.* names. Use when all consumers understand semconv.
   * - "legacy": emit only legacy names. Original behavior, no semconv.
   */
  semconvMode?: "both" | "stable" | "legacy";
}

/**
 * OtelBridge — stateful per-agent-run bridge.
 *
 * Create one instance per agent.run() call (or reuse across runs — the bridge
 * tracks open spans per traceId and flushes them automatically when the run ends).
 *
 * Span hierarchy (E1 semconv names in parentheses):
 *   run_start   → root span "agent.run"      (gen_ai.operation.name = "agent")
 *   step_start  → child span "agent.step.<N>"
 *   tool_call   → grandchild span "execute_tool" (gen_ai.operation.name = "execute_tool")
 */
export class OtelBridge {
  readonly #exporter: SpanExporter;
  readonly #semconvMode: "both" | "stable" | "legacy";
  readonly #runs = new Map<string, LiveSpan>();     // traceId → run span
  readonly #steps = new Map<string, LiveSpan>();    // `${traceId}:${step}` → step span
  readonly #tools = new Map<string, LiveSpan>();    // callId → tool span
  readonly #finished: ReadableSpan[] = [];

  constructor(opts: OtelBridgeOptions = {}) {
    this.#exporter = opts.exporter ?? NOOP_EXPORTER;
    this.#semconvMode = opts.semconvMode ?? "both";
  }

  record(ev: AgentEvent): void {
    const { traceId, timestampMs } = ev;

    switch (ev.event) {
      case "run_start": {
        const span = this.#open(traceId, undefined, "agent.run", timestampMs);
        const task = String((ev as { data: { task: string } }).data.task ?? "");
        this.#setAttr(span.attributes, "task", "gen_ai.agent.task", task);
        this.#setAttr(span.attributes, null, "gen_ai.operation.name", "agent");
        this.#runs.set(traceId, { span, ended: false });
        break;
      }

      case "step_start": {
        const step = (ev as { data: { step: number } }).data.step;
        const runSpan = this.#runs.get(traceId);
        const child = this.#open(traceId, runSpan?.span.spanId, `agent.step.${step}`, timestampMs);
        this.#setAttr(child.attributes, "step", "gen_ai.agent.step", step);
        this.#steps.set(`${traceId}:${step}`, { span: child, ended: false });
        break;
      }

      case "tool_call": {
        const d = (ev as { data: { toolName: string; callId: string; stepIndex: number } }).data;
        const stepSpan = this.#steps.get(`${traceId}:${d.stepIndex}`);
        const parentId = stepSpan?.span.spanId ?? this.#runs.get(traceId)?.span.spanId;
        // E1: tool execution span is named "execute_tool" per OTel GenAI semconv.
        const spanName = this.#semconvMode === "legacy" ? `tool.${d.toolName}` : "execute_tool";
        const child = this.#open(traceId, parentId, spanName, timestampMs);
        this.#setAttr(child.attributes, "tool.name", "gen_ai.tool.name", d.toolName);
        this.#setAttr(child.attributes, "tool.callId", "gen_ai.tool.call.id", d.callId);
        this.#setAttr(child.attributes, null, "gen_ai.operation.name", "execute_tool");
        this.#tools.set(d.callId, { span: child, ended: false });
        break;
      }

      case "tool_result": {
        const d = (ev as { data: { callId: string; isError?: boolean; error?: unknown } }).data;
        const live = this.#tools.get(d.callId);
        if (live && !live.ended) {
          live.span.status = d.error ? "error" : "ok";
          this.#close(live, timestampMs);
          this.#tools.delete(d.callId);
        }
        break;
      }

      case "final_answer": {
        const d = (ev as { data: { answer: unknown } }).data;
        const runLive = this.#runs.get(traceId);
        if (runLive && !runLive.ended) {
          runLive.span.status = "ok";
          this.#setAttr(runLive.span.attributes, "final_answer", "gen_ai.agent.final_answer", String(d.answer ?? ""));
          // Close any still-open step span.
          for (const [key, live] of this.#steps) {
            if (key.startsWith(`${traceId}:`) && !live.ended) {
              this.#close(live, timestampMs);
              this.#steps.delete(key);
            }
          }
          this.#close(runLive, timestampMs);
          this.#runs.delete(traceId);
        }
        break;
      }

      case "error": {
        const runLive = this.#runs.get(traceId);
        if (runLive && !runLive.ended) {
          runLive.span.status = "error";
          this.#setAttr(runLive.span.attributes, "error", "gen_ai.error.message", String((ev as { data: { error: string } }).data.error ?? ""));
          this.#close(runLive, timestampMs);
          this.#runs.delete(traceId);
        }
        break;
      }

      default: {
        // Handle usage-shaped data (inputTokens/outputTokens) forwarded from model events.
        const anyEv = ev as { data?: Record<string, unknown> };
        if (anyEv.data && typeof anyEv.data["inputTokens"] === "number") {
          const d = anyEv.data as {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            cacheReadTokens1h?: number;
          };
          const runLive = this.#runs.get(traceId);
          if (runLive) {
            const attrs = runLive.span.attributes;
            if (d.inputTokens !== undefined) {
              this.#addAttr(attrs, "usage.inputTokens", "gen_ai.usage.input_tokens", d.inputTokens);
            }
            if (d.outputTokens !== undefined) {
              this.#addAttr(attrs, "usage.outputTokens", "gen_ai.usage.output_tokens", d.outputTokens);
            }
            if (d.cacheReadTokens !== undefined) {
              this.#addAttr(attrs, "usage.cacheReadTokens", "gen_ai.usage.cache_read_input_tokens", d.cacheReadTokens);
            }
            if (d.cacheReadTokens1h !== undefined) {
              this.#addAttr(attrs, "usage.cacheReadTokens1h", "gen_ai.usage.cache_read_input_tokens_1h", d.cacheReadTokens1h);
            }
          }
        }
        break;
      }
    }
  }

  /** Flush all completed spans to the exporter. */
  flush(): void {
    if (this.#finished.length > 0) {
      this.#exporter.export([...this.#finished]);
      this.#finished.length = 0;
    }
  }

  /** Force-close any still-open spans and flush. Use when a run exits without final_answer. */
  forceFlush(nowMs: number = Date.now()): void {
    for (const [, live] of this.#runs) if (!live.ended) this.#close(live, nowMs);
    for (const [, live] of this.#steps) if (!live.ended) this.#close(live, nowMs);
    for (const [, live] of this.#tools) if (!live.ended) this.#close(live, nowMs);
    this.#runs.clear();
    this.#steps.clear();
    this.#tools.clear();
    this.flush();
  }

  #open(traceId: string, parentSpanId: string | undefined, name: string, startTimeMs: number): ReadableSpan {
    return {
      traceId,
      spanId: nextSpanId(),
      parentSpanId,
      name,
      startTimeMs,
      endTimeMs: undefined,
      attributes: {},
      status: "unset",
      events: [],
    };
  }

  #close(live: LiveSpan, endTimeMs: number): void {
    live.span.endTimeMs = endTimeMs;
    live.ended = true;
    this.#finished.push(live.span);
  }

  /** Set attribute under legacy and/or semconv names depending on semconvMode. */
  #setAttr(
    attrs: SpanAttributes,
    legacyKey: string | null,
    semconvKey: string,
    value: string | number | boolean
  ): void {
    if (legacyKey && this.#semconvMode !== "stable") attrs[legacyKey] = value;
    if (this.#semconvMode !== "legacy") attrs[semconvKey] = value;
  }

  /** Accumulate (add) a numeric attribute under legacy and/or semconv names. */
  #addAttr(
    attrs: SpanAttributes,
    legacyKey: string | null,
    semconvKey: string,
    delta: number
  ): void {
    if (legacyKey && this.#semconvMode !== "stable") {
      attrs[legacyKey] = ((attrs[legacyKey] as number) ?? 0) + delta;
    }
    if (this.#semconvMode !== "legacy") {
      attrs[semconvKey] = ((attrs[semconvKey] as number) ?? 0) + delta;
    }
  }
}

/**
 * Convenience: pipe an agent event generator through the bridge,
 * flushing on completion.
 *
 * Usage:
 *   const exporter = new InMemorySpanExporter();
 *   const bridge = new OtelBridge({ exporter });
 *   for await (const ev of withOtel(agent.run(task), bridge)) { ... }
 */
export async function* withOtel(
  source: AsyncGenerator<AgentEvent>,
  bridge: OtelBridge
): AsyncGenerator<AgentEvent> {
  try {
    for await (const ev of source) {
      bridge.record(ev);
      yield ev;
    }
  } finally {
    bridge.forceFlush();
  }
}
