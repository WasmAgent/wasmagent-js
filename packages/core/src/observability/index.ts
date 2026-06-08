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

/** O2: GenAI client metric point — emitted after each model_done with usage data. */
export interface GenAiMetricPoint {
  modelId: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  /** Operation duration in milliseconds. */
  durationMs?: number | undefined;
}

/** O2: Optional metrics export interface. When the exporter also implements this, metrics are forwarded. */
export interface MetricExporter {
  exportMetrics?(metrics: GenAiMetricPoint[]): void;
}

// ── InMemorySpanExporter ──────────────────────────────────────────────────────

export class InMemorySpanExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[]): void {
    this.spans.push(...spans);
  }
  reset(): void {
    this.spans.length = 0;
  }
}

// ── OtelBridge ────────────────────────────────────────────────────────────────

const NOOP_EXPORTER: SpanExporter = { export() {} };

function inferGenAiSystem(modelId: string): string {
  if (modelId.startsWith("claude-")) return "anthropic";
  if (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1") ||
    modelId.startsWith("o3") ||
    modelId.startsWith("o4")
  )
    return "openai";
  if (modelId.startsWith("deepseek-")) return "deepseek";
  if (modelId.startsWith("doubao-") || modelId.startsWith("ep-")) return "volcengine";
  if (modelId.startsWith("moonshot-") || modelId.startsWith("kimi-")) return "moonshot";
  if (modelId.startsWith("qwen-")) return "alibaba";
  if (modelId.startsWith("glm-")) return "zhipu";
  if (modelId.startsWith("MiniMax-")) return "minimax";
  return "unknown";
}

let _spanCounter = 0;

/**
 * Generate a cryptographically random W3C-compliant span ID (8 bytes = 16 hex chars).
 * Falls back to counter-based when crypto is unavailable (test environments without webcrypto).
 */
function nextSpanId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return (++_spanCounter).toString(16).padStart(16, "0");
}

/**
 * Generate a cryptographically random W3C-compliant trace ID (16 bytes = 32 hex chars).
 */
function newOtelTraceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return (++_spanCounter).toString(16).padStart(32, "0");
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
  /**
   * Optional upstream W3C traceparent to continue an existing trace.
   * Format: "00-<traceId>-<spanId>-<flags>" (e.g. from a request header).
   * When provided, all spans for runs received within this bridge use the
   * upstream traceId and the upstream spanId as the root parent.
   */
  traceparent?: string;
  /**
   * Content capture mode for prompt/completion recording.
   * - "off" (default): no content captured (privacy-safe default).
   * - "events": capture as span events (gen_ai.* event names).
   * - "pointer": store content in KV and attach pointer attribute to span.
   */
  captureContent?: "off" | "events" | "pointer";
}

function resolveSemconvMode(
  explicit: "both" | "stable" | "legacy" | undefined
): "both" | "stable" | "legacy" {
  if (explicit !== undefined) return explicit;
  // C2: standard env-based opt-in.
  const envVal =
    typeof process !== "undefined" ? process.env.OTEL_SEMCONV_STABILITY_OPT_IN : undefined;
  if (envVal === "gen_ai_latest_experimental") return "stable";
  return "both";
}

export class OtelBridge {
  readonly #exporter: SpanExporter;
  readonly #semconvMode: "both" | "stable" | "legacy";
  readonly #captureContent: "off" | "events" | "pointer";
  readonly #runs = new Map<string, LiveSpan>();
  readonly #steps = new Map<string, LiveSpan>();
  readonly #tools = new Map<string, LiveSpan>();
  /** E1: one inference span per model generation call, keyed by traceId:step. */
  readonly #inferences = new Map<string, LiveSpan>();
  readonly #finished: ReadableSpan[] = [];
  /** Maps agentkit traceId → OTel traceId (valid 32-char hex). */
  readonly #traceIdMap = new Map<string, string>();
  /** When a traceparent is injected, we continue that trace instead of creating a new one. */
  readonly #upstreamTraceId: string | undefined;
  readonly #upstreamSpanId: string | undefined;
  /** O2: accumulated metric points for export. */
  readonly #pendingMetrics: GenAiMetricPoint[] = [];

  constructor(opts: OtelBridgeOptions = {}) {
    this.#exporter = opts.exporter ?? NOOP_EXPORTER;
    this.#semconvMode = resolveSemconvMode(opts.semconvMode);
    this.#captureContent = opts.captureContent ?? "off";
    if (opts.traceparent) {
      const parts = opts.traceparent.split("-");
      if (parts.length >= 3 && parts[1]?.length === 32 && parts[2]?.length === 16) {
        this.#upstreamTraceId = parts[1];
        this.#upstreamSpanId = parts[2];
      }
    }
  }

  /** Resolve the OTel traceId for an agentkit traceId, creating one if needed. */
  #resolveOtelTraceId(agentkitTraceId: string): string {
    let otelId = this.#traceIdMap.get(agentkitTraceId);
    if (!otelId) {
      otelId = this.#upstreamTraceId ?? newOtelTraceId();
      this.#traceIdMap.set(agentkitTraceId, otelId);
    }
    return otelId;
  }

  record(ev: AgentEvent): void {
    const { traceId, timestampMs } = ev;

    switch (ev.event) {
      case "run_start": {
        // C2: root span name is "invoke_agent" in stable/both mode; "agent.run" in legacy.
        const rootSpanName = this.#semconvMode === "legacy" ? "agent.run" : "invoke_agent";
        const parentSpanId = this.#upstreamSpanId;
        const span = this.#open(traceId, parentSpanId, rootSpanName, timestampMs);
        const task = String((ev as { data: { task: string } }).data.task ?? "");
        this.#setAttr(span.attributes, "task", "gen_ai.agent.task", task);
        this.#setAttr(span.attributes, null, "gen_ai.operation.name", "invoke_agent");
        // Preserve original agentkit traceId as an attribute for correlation.
        span.attributes["agentkit.trace_id"] = traceId;
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

      case "model_start": {
        // E1: open a GenAI inference span (gen_ai.operation.name = "chat").
        const d = (ev as { data: { modelId: string; step: number } }).data;
        const inferKey = `${traceId}:${d.step}`;
        const stepSpan = this.#steps.get(`${traceId}:${d.step}`);
        const parentId = stepSpan?.span.spanId ?? this.#runs.get(traceId)?.span.spanId;
        const spanName = this.#semconvMode === "legacy" ? `model.chat` : "chat";
        const child = this.#open(traceId, parentId, spanName, timestampMs);
        const providerName = inferGenAiSystem(d.modelId);
        this.#setAttr(child.attributes, "model.id", "gen_ai.request.model", d.modelId);
        this.#setAttr(child.attributes, null, "gen_ai.operation.name", "chat");
        // O4: both gen_ai.system (legacy) and gen_ai.provider.name (new stable).
        this.#setAttr(child.attributes, null, "gen_ai.system", providerName);
        if (this.#semconvMode !== "legacy") child.attributes["gen_ai.provider.name"] = providerName;
        // Track TTFB start time for metrics (O2).
        child.attributes._ttfbStartMs = timestampMs;
        this.#inferences.set(inferKey, { span: child, ended: false });
        break;
      }

      case "model_done": {
        // E1: close the inference span with finish reason + token usage.
        const d = (
          ev as {
            data: {
              modelId: string;
              step: number;
              finishReason: string;
              inputTokens?: number;
              outputTokens?: number;
              thinkingTokens?: number;
              cacheReadTokens?: number;
            };
          }
        ).data;
        const inferKey = `${traceId}:${d.step}`;
        const live = this.#inferences.get(inferKey);
        if (live && !live.ended) {
          live.span.status = "ok";
          this.#setAttr(live.span.attributes, "model.id", "gen_ai.response.model", d.modelId);
          this.#setAttr(
            live.span.attributes,
            "model.finishReason",
            "gen_ai.response.finish_reasons",
            d.finishReason
          );
          if (d.inputTokens !== undefined) {
            this.#setAttr(
              live.span.attributes,
              "usage.inputTokens",
              "gen_ai.usage.input_tokens",
              d.inputTokens
            );
          }
          if (d.outputTokens !== undefined) {
            this.#setAttr(
              live.span.attributes,
              "usage.outputTokens",
              "gen_ai.usage.output_tokens",
              d.outputTokens
            );
          }
          if (d.thinkingTokens !== undefined) {
            this.#setAttr(
              live.span.attributes,
              "usage.thinkingTokens",
              "gen_ai.usage.thinking_tokens",
              d.thinkingTokens
            );
          }
          if (d.cacheReadTokens !== undefined) {
            this.#setAttr(
              live.span.attributes,
              "usage.cacheReadTokens",
              "gen_ai.usage.cache_read_input_tokens",
              d.cacheReadTokens
            );
          }
          // O2: operation duration (ms).
          const startMs = live.span.attributes._ttfbStartMs as number | undefined;
          if (startMs !== undefined) {
            live.span.attributes["gen_ai.client.operation.duration_ms"] = timestampMs - startMs;
            delete live.span.attributes._ttfbStartMs;
          }
          this.#close(live, timestampMs);
          this.#inferences.delete(inferKey);

          // O2: record metrics data if we have usage and an exporter that supports metrics.
          if (d.inputTokens !== undefined || d.outputTokens !== undefined) {
            this.#pendingMetrics.push({
              modelId: d.modelId,
              inputTokens: d.inputTokens,
              outputTokens: d.outputTokens,
              durationMs: startMs !== undefined ? timestampMs - startMs : undefined,
            });
          }
        }
        break;
      }

      case "final_answer": {
        const d = (ev as { data: { answer: unknown } }).data;
        const runLive = this.#runs.get(traceId);
        if (runLive && !runLive.ended) {
          runLive.span.status = "ok";
          this.#setAttr(
            runLive.span.attributes,
            "final_answer",
            "gen_ai.agent.final_answer",
            String(d.answer ?? "")
          );
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
          this.#setAttr(
            runLive.span.attributes,
            "error",
            "gen_ai.error.message",
            String((ev as { data: { error: string } }).data.error ?? "")
          );
          this.#close(runLive, timestampMs);
          this.#runs.delete(traceId);
        }
        break;
      }

      default: {
        const anyEv = ev as { data?: Record<string, unknown> };
        if (anyEv.data && typeof anyEv.data.inputTokens === "number") {
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
              this.#addAttr(
                attrs,
                "usage.outputTokens",
                "gen_ai.usage.output_tokens",
                d.outputTokens
              );
            }
            if (d.thinkingTokens !== undefined) {
              this.#addAttr(
                attrs,
                "usage.thinkingTokens",
                "gen_ai.usage.thinking_tokens",
                d.thinkingTokens
              );
            }
            if (d.cacheReadTokens !== undefined) {
              this.#addAttr(
                attrs,
                "usage.cacheReadTokens",
                "gen_ai.usage.cache_read_input_tokens",
                d.cacheReadTokens
              );
            }
            if (d.cacheReadTokens1h !== undefined) {
              this.#addAttr(
                attrs,
                "usage.cacheReadTokens1h",
                "gen_ai.usage.cache_read_input_tokens_1h",
                d.cacheReadTokens1h
              );
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
    // O2: export accumulated metrics if the exporter supports it.
    if (this.#pendingMetrics.length > 0) {
      const metricExporter = this.#exporter as unknown as MetricExporter;
      if (typeof metricExporter.exportMetrics === "function") {
        metricExporter.exportMetrics([...this.#pendingMetrics]);
      }
      this.#pendingMetrics.length = 0;
    }
  }

  forceFlush(nowMs: number = Date.now()): void {
    for (const [, live] of this.#runs) if (!live.ended) this.#close(live, nowMs);
    for (const [, live] of this.#steps) if (!live.ended) this.#close(live, nowMs);
    for (const [, live] of this.#tools) if (!live.ended) this.#close(live, nowMs);
    for (const [, live] of this.#inferences) if (!live.ended) this.#close(live, nowMs);
    this.#runs.clear();
    this.#steps.clear();
    this.#tools.clear();
    this.#inferences.clear();
    this.flush();
  }

  #open(
    agentkitTraceId: string,
    parentSpanId: string | undefined,
    name: string,
    startTimeMs: number
  ): ReadableSpan {
    const otelTraceId = this.#resolveOtelTraceId(agentkitTraceId);
    return {
      traceId: otelTraceId,
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
