import { describe, it, expect, vi, afterEach } from "vitest";
import { OtlpHttpExporter } from "./index.js";
import type { ReadableSpan } from "@agentkit-js/core";

function makeSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    traceId: "agent-abc123",
    spanId: "span-00000001",
    parentSpanId: undefined,
    name: "invoke_agent",
    startTimeMs: 1000,
    endTimeMs: 2000,
    attributes: { "gen_ai.operation.name": "invoke_agent", task: "test task" },
    status: "ok",
    events: [],
    ...overrides,
  };
}

describe("OtlpHttpExporter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires POST to /v1/traces with correct content-type", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "" } as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const exporter = new OtlpHttpExporter({ endpoint: "http://collector:4318" });
    await exporter.exportAsync([makeSpan()]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://collector:4318/v1/traces");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("includes resourceSpans with service.name in payload", async () => {
    let capturedBody = "";
    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return { ok: true, text: async () => "" } as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);

    const exporter = new OtlpHttpExporter({
      endpoint: "http://localhost:4318",
      serviceName: "my-agent-service",
      serviceVersion: "1.0.0",
    });
    await exporter.exportAsync([makeSpan()]);

    const payload = JSON.parse(capturedBody);
    expect(payload.resourceSpans).toHaveLength(1);
    const resourceAttrs = payload.resourceSpans[0].resource.attributes as Array<{ key: string; value: { stringValue: string } }>;
    const serviceNameAttr = resourceAttrs.find((a) => a.key === "service.name");
    expect(serviceNameAttr?.value.stringValue).toBe("my-agent-service");
    const versionAttr = resourceAttrs.find((a) => a.key === "service.version");
    expect(versionAttr?.value.stringValue).toBe("1.0.0");
  });

  it("encodes span traceId and spanId as padded hex", async () => {
    let capturedBody = "";
    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return { ok: true, text: async () => "" } as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);

    const exporter = new OtlpHttpExporter();
    await exporter.exportAsync([makeSpan()]);

    const payload = JSON.parse(capturedBody);
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(typeof span.traceId).toBe("string");
    expect(span.traceId.length).toBe(32);
    expect(span.spanId.length).toBe(16);
  });

  it("maps span status ok → code 1, error → code 2", async () => {
    let capturedBody = "";
    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return { ok: true } as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);

    const exporter = new OtlpHttpExporter();
    await exporter.exportAsync([makeSpan({ status: "error" })]);

    const payload = JSON.parse(capturedBody);
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2);
  });

  it("encodes attributes correctly (string/number/bool)", async () => {
    let capturedBody = "";
    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return { ok: true } as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);

    const exporter = new OtlpHttpExporter();
    await exporter.exportAsync([makeSpan({
      attributes: {
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.system": "anthropic",
        "gen_ai.request.stream": true,
        "gen_ai.usage.cost": 0.005,
      },
    })]);

    const payload = JSON.parse(capturedBody);
    const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes as Array<{ key: string; value: Record<string, unknown> }>;
    const intAttr = attrs.find((a) => a.key === "gen_ai.usage.input_tokens");
    expect(intAttr?.value.intValue).toBe("100");
    const strAttr = attrs.find((a) => a.key === "gen_ai.system");
    expect(strAttr?.value.stringValue).toBe("anthropic");
    const boolAttr = attrs.find((a) => a.key === "gen_ai.request.stream");
    expect(boolAttr?.value.boolValue).toBe(true);
    const floatAttr = attrs.find((a) => a.key === "gen_ai.usage.cost");
    expect(floatAttr?.value.doubleValue).toBe(0.005);
  });

  it("handles parent span ID correctly", async () => {
    let capturedBody = "";
    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return { ok: true } as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);

    const exporter = new OtlpHttpExporter();
    await exporter.exportAsync([makeSpan({ parentSpanId: "span-00000002" })]);

    const payload = JSON.parse(capturedBody);
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.parentSpanId).toBeDefined();
    expect(span.parentSpanId.length).toBe(16);
  });

  it("fire-and-forget export() does not throw on fetch error", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", fetchSpy);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const exporter = new OtlpHttpExporter();
    exporter.export([makeSpan()]);
    // Allow the microtask queue to flush
    await new Promise((r) => setTimeout(r, 10));
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("export() is no-op for empty spans", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const exporter = new OtlpHttpExporter();
    exporter.export([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
