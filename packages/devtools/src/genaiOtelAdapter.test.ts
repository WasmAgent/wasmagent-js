/**
 * Tests for the GenAI OTel → agentkit LoggedEvent adapter (D5).
 */

import { convertGenAiSpansToEvents, type GenAiSpan, parseGenAiInput } from "./genaiOtelAdapter.js";
import { groupByTraceId, summariseRun } from "./RunsAggregator.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A typical Vercel AI SDK / Mastra-shaped invoke_agent + chat + tool trace. */
function makeAisdkLikeSpans(): GenAiSpan[] {
  const traceId = "a".repeat(32);
  return [
    {
      name: "invoke_agent claude-sonnet-4-6",
      traceId,
      spanId: "b".repeat(16),
      startTimeUnixNano: "1717900000000000000",
      endTimeUnixNano: "1717900003500000000",
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.system": "anthropic",
        "gen_ai.agent.task": "summarise the readme",
      },
      events: [
        {
          name: "gen_ai.choice",
          timeUnixNano: "1717900003400000000",
          attributes: { "gen_ai.choice.message.content": "Done." },
        },
      ],
      status: { code: "OK" },
    },
    {
      name: "chat anthropic",
      traceId,
      spanId: "c".repeat(16),
      parentSpanId: "b".repeat(16),
      startTimeUnixNano: "1717900000500000000",
      endTimeUnixNano: "1717900001500000000",
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": "claude-sonnet-4-6",
        "gen_ai.response.model": "claude-sonnet-4-6",
        "gen_ai.response.finish_reasons": "tool_use",
        "gen_ai.usage.input_tokens": 200,
        "gen_ai.usage.output_tokens": 30,
        "gen_ai.usage.cache_read_input_tokens": 50,
        "gen_ai.usage.cost.usd": 0.0024,
      },
      status: { code: "OK" },
    },
    {
      name: "execute_tool fs.read",
      traceId,
      spanId: "d".repeat(16),
      parentSpanId: "b".repeat(16),
      startTimeUnixNano: "1717900001600000000",
      endTimeUnixNano: "1717900001900000000",
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "fs.read",
      },
      status: { code: "OK" },
    },
  ];
}

// ── Conversion tests ─────────────────────────────────────────────────────────

describe("convertGenAiSpansToEvents — happy path", () => {
  it("emits run_start + final_answer + model_*+ tool_* events for a typical trace", () => {
    const result = convertGenAiSpansToEvents(makeAisdkLikeSpans());
    expect(result.skipped).toBe(0);
    expect(result.tracesSeen).toBe(1);
    const kinds = result.events.map((e) => e.event.event);
    expect(kinds).toContain("run_start");
    expect(kinds).toContain("model_start");
    expect(kinds).toContain("model_done");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("final_answer");
  });

  it("surfaces token + cost numbers on model_done so summariseRun reads them", () => {
    const events = convertGenAiSpansToEvents(makeAisdkLikeSpans()).events;
    const groups = groupByTraceId(events);
    const [first] = [...groups.values()];
    if (!first) throw new Error("expected one trace");
    const summary = summariseRun(first);
    expect(summary.tokens.input).toBe(200);
    expect(summary.tokens.output).toBe(30);
    expect(summary.tokens.cacheRead).toBe(50);
    expect(summary.costUsd).toBeCloseTo(0.0024, 6);
    expect(summary.modelCalls).toBe(1);
    expect(summary.outcome).toBe("complete");
    expect(summary.finalAnswer).toBe("Done.");
  });

  it("skips spans without traceId and counts them", () => {
    const spans: GenAiSpan[] = [
      { name: "no-trace", traceId: "", spanId: "x" },
      ...makeAisdkLikeSpans(),
    ];
    const r = convertGenAiSpansToEvents(spans);
    expect(r.skipped).toBe(1);
    expect(r.tracesSeen).toBe(1);
  });

  it("emits an error event when a chat span carries status.code = ERROR", () => {
    const spans = makeAisdkLikeSpans();
    const chat = spans.find((s) => s.attributes?.["gen_ai.operation.name"] === "chat");
    if (!chat) throw new Error("fixture broken");
    chat.status = { code: "ERROR", message: "rate limited" };
    const result = convertGenAiSpansToEvents(spans);
    const errs = result.events.filter((e) => e.event.event === "error");
    expect(errs.length).toBe(1);
  });

  it("treats step.* and agent.step span names as a step boundary", () => {
    const spans: GenAiSpan[] = [
      {
        name: "step.evaluate",
        traceId: "z".repeat(32),
        spanId: "s".repeat(16),
        startTimeUnixNano: "1000000000",
        endTimeUnixNano: "2000000000",
        attributes: {},
      },
    ];
    const r = convertGenAiSpansToEvents(spans);
    const kinds = r.events.map((e) => e.event.event);
    expect(kinds).toEqual(["step_start", "step_end"]);
  });
});

// ── Parser tests ─────────────────────────────────────────────────────────────

describe("parseGenAiInput", () => {
  it("parses NDJSON with one span per line", () => {
    const lines = makeAisdkLikeSpans().map((s) => JSON.stringify(s));
    const parsed = parseGenAiInput(lines.join("\n"));
    expect(parsed.length).toBe(3);
  });

  it("parses OTLP/JSON shape with resourceSpans → scopeSpans → spans", () => {
    const spans = makeAisdkLikeSpans();
    const otlp = JSON.stringify({
      resourceSpans: [{ scopeSpans: [{ spans }] }],
    });
    const parsed = parseGenAiInput(otlp);
    expect(parsed.length).toBe(3);
  });

  it("skips malformed NDJSON lines without throwing", () => {
    const ndjson = `${JSON.stringify(makeAisdkLikeSpans()[0])}\n{not-json}\n`;
    const parsed = parseGenAiInput(ndjson);
    expect(parsed.length).toBe(1);
  });

  it("returns empty array on completely unrecognised input", () => {
    expect(parseGenAiInput("")).toEqual([]);
    expect(parseGenAiInput("   \n   ")).toEqual([]);
  });
});
