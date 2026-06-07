/**
 * OpenTelemetry observability bridge (C2 — GenAI semconv v1.40/1.41).
 *
 * Bridges AgentEvent streams to OTel-compatible spans without a hard dependency
 * on @opentelemetry/api.
 *
 * Semantic convention opt-in (C2):
 *  Standard env: OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
 *  → root span is "invoke_agent", gen_ai.operation.name="invoke_agent"
 *
 * semconvMode override:
 *  - "both" (default): emit both legacy and gen_ai.* attributes.
 *  - "stable": emit only gen_ai.* attributes.
 *  - "legacy": emit only legacy attributes (no semconv).
 *
 * Span hierarchy:
 *   invoke_agent (root)           gen_ai.operation.name=invoke_agent
 *     agent.step.<N>
 *       execute_tool              gen_ai.operation.name=execute_tool
 */

import type { AgentEvent } from "../types/events.js";

// ── Span model ────────────────────────────────────────────────────────────────

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
  export(spans: ReadableSpan[]): void { this.spans.push(...spans); }
  reset(): void { this.spans.length = 0; }
}

// ── OtelBridge ────────────────────────────────────────────────────────────────

const NOOP_EXPORTER: SpanExporter = { export() {} };

let _spanCounter = 0;
function nextSpanId(): string {
  return `span-${(++_spanCounter).toString(16).padStart(8, "0")}`;
}

interface LiveSpan {
  span: ReadableSpan;
  ended: boolean;
}

export interface OtelBridgeOptions {
  exporter?: SpanExporter;
  /**
   * Attribute naming mode.
   * - "both" (default): emit both legacy and gen_ai.* names.
   * - "stable": emit only gen_ai.* names.
   * - "legacy": emit only legacy names.
   *
   * When omitted, the mode is auto-detected from OTEL_SEMCONV_STABILITY_OPT_IN:
   *   "gen_ai_latest_experimental" → "stable"
   *   anything else               → "both"
   */
  semconvMode?: "both" | "stable" | "legacy";
}

function resolveSemconvMode(
  explicit: "both" | "stable" | "legacy" | undefined
): "both" | "stable" | "legacy" {
  if (explicit !== undefined) return explicit;
  // C2: standard env-based opt-in.
  const envVal = typeof process !== "undefined"
    ? process.env["OTEL_SEMCONV_STABILITY_OPT_IN"]
    : undefined;
  if (envVal === "gen_ai_latest_experimental") return "stable";
  return "both";
}

export class OtelBridge {
  readonly #exporter: SpanExporter;
  readonly #semconvMode: "both" | "stable" | "legacy";
  readonly #runs = new Map<string, LiveSpan>();
  readonly #steps = new Map<string, LiveSpan>();
  readonly #tools = new Map<string, LiveSpan>();
  readonly #finished: ReadableSpan[] = [];

  constructor(opts: OtelBridgeOptions = {}) {
    this.#exporter = opts.exporter ?? NOOP_EXPORTER;
    this.#semconvMode = resolveSemconvMode(opts.semconvMode);
  }

  record(ev: AgentEvent): void {
    const { traceId, timestampMs } = ev;

    switch (ev.event) {
      case "run_start": {
        // C2: root span name is "invoke_agent" in stable/both mode; "agent.run" in legacy.
        const rootSpanName = this.#semconvMode === "legacy" ? "agent.run" : "invoke_agent";
        const span = this.#open(traceId, undefined, rootSpanName, timestampMs);
        const task = String((ev as { data: { task: string } }).data.task ?? "");
        this.#setAttr(span.attributes, "task", "gen_ai.agent.task", task);
        this.#setAttr(span.attributes, null, "gen_ai.operation.name", "invoke_agent");
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
        const anyEv = ev as { data?: Record<string, unknown> };
        if (anyEv.data && typeof anyEv.data["inputTokens"] === "number") {
          const d = anyEv.data as {
            inputTokens?: number;
            outputTokens?: number;
            thinkingTokens?: number;
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
            if (d.thinkingTokens !== undefined) {
              this.#addAttr(attrs, "usage.thinkingTokens", "gen_ai.usage.thinking_tokens", d.thinkingTokens);
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

  flush(): void {
    if (this.#finished.length > 0) {
      this.#exporter.export([...this.#finished]);
      this.#finished.length = 0;
    }
  }

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

  #setAttr(
    attrs: SpanAttributes,
    legacyKey: string | null,
    semconvKey: string,
    value: string | number | boolean
  ): void {
    if (legacyKey && this.#semconvMode !== "stable") attrs[legacyKey] = value;
    if (this.#semconvMode !== "legacy") attrs[semconvKey] = value;
  }

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
 * Pipe an agent event generator through the bridge, flushing on completion.
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
