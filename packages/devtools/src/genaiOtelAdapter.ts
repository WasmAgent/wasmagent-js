/**
 * GenAI OTel adapter (D5 — framework-agnostic devtools ingest).
 *
 * Lets `WasmAgent devtools` consume any OTel GenAI semantic-convention
 * trace, not only WasmAgent's own EventLog. The shape we accept is the
 * intersection that Vercel AI SDK, Mastra, OpenAI Agents JS, Anthropic
 * SDK observability, and the OTel collector all already emit:
 *
 *   {
 *     "name": "<span name>",                   // e.g. "chat anthropic", "execute_tool"
 *     "traceId": "<32-char hex>",              // groups events into a run
 *     "spanId": "<16-char hex>",
 *     "parentSpanId": "<16-char hex>"|null,
 *     "startTimeUnixNano": "<int>",
 *     "endTimeUnixNano":   "<int>",
 *     "attributes": {
 *       "gen_ai.operation.name":              "invoke_agent" | "chat" | "execute_tool" | …
 *       "gen_ai.system":                      "anthropic" | "openai" | …
 *       "gen_ai.request.model":               "claude-sonnet-4-6" | "gpt-4o" | …
 *       "gen_ai.response.model":              "…",
 *       "gen_ai.response.finish_reasons":     "tool_use" | "stop" | …
 *       "gen_ai.usage.input_tokens":          number,
 *       "gen_ai.usage.output_tokens":         number,
 *       "gen_ai.usage.cache_read_input_tokens": number,
 *       "gen_ai.tool.name":                   "<tool>",
 *       "gen_ai.agent.task":                  "<task text>",
 *       …
 *     },
 *     "status": { "code": "OK"|"ERROR", "message": "…"? },
 *     "events": [{ "timeUnixNano": "…", "name": "…", "attributes": {…} }]
 *   }
 *
 * Two input shapes are supported:
 *
 *   1. **NDJSON** — one span per line (the lazy default tools dump when
 *      piping through the OTel collector). Lines that fail to parse are
 *      skipped.
 *   2. **OTLP/JSON** — `{ resourceSpans: [{ scopeSpans: [{ spans: […] }] }] }`,
 *      the OTel HTTP exporter wire format. Detected by `resourceSpans`.
 *
 * The adapter is best-effort: if a producer is missing some attributes
 * we surface the span with whatever we have, rather than dropping it.
 * Comparing two runs from different upstreams is the use case —
 * over-strictness would make that impossible.
 *
 * The output is a list of WasmAgent `LoggedEvent`s. We synthesize the
 * minimum set the existing `summariseRun` actually reads:
 * `run_start`, `step_start`, `step_end`, `model_done`, `tool_call`,
 * `tool_result`, `final_answer`, `error`. Anything beyond that
 * (artifacts, action lifecycle, guardrails) is producer-specific.
 */

import type { LoggedEvent } from "./EventLogReplay.js";

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Minimal span shape we read. Extra fields are passed through verbatim
 * via index signature — different OTel SDKs decorate spans differently
 * and we don't want to reject them.
 */
export interface GenAiSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: Record<string, unknown>;
  status?: { code?: string | number; message?: string };
  events?: Array<{
    timeUnixNano?: string | number;
    name?: string;
    attributes?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
}

export interface GenAiConversionResult {
  /** Synthesized WasmAgent `LoggedEvent`s, ordered by trace then by start time. */
  events: LoggedEvent[];
  /** Number of input spans the converter could not place. */
  skipped: number;
  /** Per-trace span count. */
  tracesSeen: number;
}

// ── Conversion ───────────────────────────────────────────────────────────────

/**
 * Convert a flat list of GenAI semconv spans to WasmAgent `LoggedEvent`s
 * suitable for `groupByTraceId` / `summariseRun`. Spans without a
 * usable `traceId` are skipped (counted) — silent dropping would hide
 * producer bugs.
 *
 * Mapping (one or two events per input span, never more):
 *   - `gen_ai.operation.name == "invoke_agent"` → `run_start`
 *     (+ `final_answer` if a child `gen_ai.choice` event exists).
 *   - `... == "execute_tool"` → `tool_call` + `tool_result`.
 *   - `... == "chat"` → `model_start` + `model_done`.
 *   - span name prefixed `step.` / `agent.step` → `step_start` + `step_end`.
 *   - any other → no event (the aggregator does not read these).
 *
 * Errors on the span (status.code === ERROR) emit an `error` event
 * after the primary one.
 */
export function convertGenAiSpansToEvents(spans: GenAiSpan[]): GenAiConversionResult {
  const traceSet = new Set<string>();
  const out: Array<{ tsMs: number; ord: number; ev: LoggedEvent }> = [];
  let skipped = 0;
  let ord = 0;

  for (const span of spans) {
    if (!span.traceId || typeof span.traceId !== "string") {
      skipped++;
      continue;
    }
    traceSet.add(span.traceId);

    const attrs = span.attributes ?? {};
    const op = String(attrs["gen_ai.operation.name"] ?? "");
    const startMs = nsToMs(span.startTimeUnixNano);
    const endMs = nsToMs(span.endTimeUnixNano) ?? startMs;
    const traceId = span.traceId;
    const parentTraceId = (span.parentSpanId as string | undefined) ?? null;
    const isError =
      span.status?.code === "ERROR" ||
      span.status?.code === 2 || // OTLP numeric ERROR
      (typeof span.status?.message === "string" && span.status.code !== "OK");

    // Helper to push a fully-formed LoggedEvent. We bypass the strict
    // discriminated-union typing on AgentEvent because this adapter
    // emits a structural subset and `summariseRun` reads via runtime
    // string discriminator — see comment in RunsAggregator.summariseRun.
    const push = (suffix: string, tsMs: number, partial: Record<string, unknown>) => {
      ord++;
      const ev = {
        eventId: `${span.spanId}:${suffix}`,
        event: {
          traceId,
          parentTraceId,
          timestampMs: tsMs,
          ...partial,
        },
      } as unknown as LoggedEvent;
      out.push({ tsMs, ord, ev });
    };

    switch (op) {
      case "invoke_agent": {
        const task = (attrs["gen_ai.agent.task"] as string | undefined) ?? span.name;
        push("run_start", startMs, {
          channel: "text",
          event: "run_start",
          data: { task },
        });
        const finalEv = (span.events ?? []).find((e) =>
          ["gen_ai.choice", "final_answer", "agent.final_answer"].includes(String(e.name ?? ""))
        );
        if (finalEv) {
          const ans =
            (finalEv.attributes?.["gen_ai.choice.message.content"] as string | undefined) ??
            (finalEv.attributes?.["agent.final_answer"] as string | undefined) ??
            "";
          push("final_answer", endMs, {
            channel: "text",
            event: "final_answer",
            data: { answer: ans },
          });
        }
        break;
      }
      case "execute_tool": {
        const toolName = (attrs["gen_ai.tool.name"] as string | undefined) ?? span.name;
        const callId = span.spanId;
        push("tool_call", startMs, {
          channel: "tool",
          event: "tool_call",
          data: {
            toolName,
            args: {},
            callId,
            batchId: span.spanId,
            batchSize: 1,
            stepIndex: 0,
          },
        });
        push("tool_result", endMs, {
          channel: "tool",
          event: "tool_result",
          data: {
            callId,
            toolName,
            output: isError ? "" : "",
            ...(isError && {
              error: {
                code: "execution_error" as const,
                message: span.status?.message ?? "execute_tool span reported ERROR",
              },
            }),
            batchId: span.spanId,
            batchSize: 1,
            stepIndex: 0,
          },
        });
        break;
      }
      case "chat": {
        const modelId =
          (attrs["gen_ai.response.model"] as string | undefined) ??
          (attrs["gen_ai.request.model"] as string | undefined) ??
          "unknown";
        const finishReasons = attrs["gen_ai.response.finish_reasons"] as string | undefined;
        push("model_start", startMs, {
          channel: "model",
          event: "model_start",
          data: { modelId, step: 0 },
        });
        push("model_done", endMs, {
          channel: "model",
          event: "model_done",
          data: {
            modelId,
            step: 0,
            finishReason: finishReasons ?? "",
            inputTokens: numAttr(attrs, "gen_ai.usage.input_tokens"),
            outputTokens: numAttr(attrs, "gen_ai.usage.output_tokens"),
            cacheReadTokens: numAttr(attrs, "gen_ai.usage.cache_read_input_tokens"),
            thinkingTokens: numAttr(attrs, "gen_ai.usage.reasoning_tokens"),
            estimatedUsd:
              (attrs["gen_ai.usage.cost"] as number | undefined) ??
              (attrs["gen_ai.usage.cost.usd"] as number | undefined) ??
              0,
          },
        });
        if (isError) {
          push("error", endMs, {
            channel: "text",
            event: "error",
            data: { error: span.status?.message ?? "chat span reported ERROR" },
          });
        }
        break;
      }
      default: {
        const looksLikeStep = /^(step[._-]|agent\.step)/i.test(span.name);
        if (looksLikeStep) {
          push("step_start", startMs, {
            channel: "thinking",
            event: "step_start",
            data: { step: 0 },
          });
          push("step_end", endMs, {
            channel: "thinking",
            event: "step_end",
            data: { step: 0 },
          });
        }
        break;
      }
    }
  }

  // Stable sort: by trace, then by event timestamp, then by emit order.
  // We can't sort by traceId from the typed event because the cast
  // through `LoggedEvent` left it visible only via the structural data;
  // store traceId on the wrapper itself.
  out.sort((a, b) => {
    const ta = (a.ev.event as { traceId: string }).traceId;
    const tb = (b.ev.event as { traceId: string }).traceId;
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
    return a.ord - b.ord;
  });

  return {
    events: out.map((x) => x.ev),
    skipped,
    tracesSeen: traceSet.size,
  };
}

// ── Input parsing ────────────────────────────────────────────────────────────

/**
 * Parse an NDJSON or OTLP/JSON document into the flat span list the
 * converter expects. Returns an empty array on unrecognised shape.
 */
export function parseGenAiInput(rawText: string): GenAiSpan[] {
  const trimmed = rawText.trimStart();

  // OTLP/JSON: a single JSON object with `resourceSpans`.
  if (trimmed.startsWith("{")) {
    try {
      const doc = JSON.parse(rawText) as {
        resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: GenAiSpan[] }> }>;
        spans?: GenAiSpan[];
      };
      if (Array.isArray(doc.resourceSpans)) {
        const all: GenAiSpan[] = [];
        for (const rs of doc.resourceSpans) {
          for (const ss of rs.scopeSpans ?? []) {
            for (const sp of ss.spans ?? []) all.push(sp);
          }
        }
        return all;
      }
      if (Array.isArray(doc.spans)) return doc.spans;
    } catch {
      // Fall through to NDJSON.
    }
  }

  // NDJSON: one span per non-empty line.
  const out: GenAiSpan[] = [];
  for (const line of rawText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as GenAiSpan;
      if (obj && typeof obj === "object") out.push(obj);
    } catch {
      // Skip — caller logs once on the first bad line.
    }
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert UnixNano (string or number) to ms; returns 0 on failure. */
function nsToMs(v: unknown): number {
  if (typeof v === "bigint") return Number(v / 1_000_000n);
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v / 1_000_000);
  if (typeof v === "string" && /^\d+$/.test(v)) {
    try {
      return Number(BigInt(v) / 1_000_000n);
    } catch {
      return 0;
    }
  }
  return 0;
}

/** Read a numeric attribute, defaulting to 0 if missing or wrong type. */
function numAttr(attrs: Record<string, unknown>, key: string): number {
  const v = attrs[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  return 0;
}
