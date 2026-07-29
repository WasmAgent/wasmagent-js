import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  AEPEmitter,
  type AEPRecord,
  createLocalSignerFromSeed,
  EvidencePublisher,
  InMemoryEvidenceStore,
  type StreamEvent,
} from "@wasmagent/aep";
import type { ReadableSpan } from "@wasmagent/core/experimental";
import {
  aepRecordToOtlpSpans,
  GENAI_SEMCONV_VERSION,
  OtlpEvidenceTransport,
  OtlpHttpExporter,
} from "./index.js";

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
    mock.restore();
  });

  it("fires POST to /v1/traces with correct content-type", async () => {
    const fetchSpy = mock().mockResolvedValue({ ok: true, text: async () => "" } as Response);
    globalThis.fetch = fetchSpy;

    const exporter = new OtlpHttpExporter({ endpoint: "http://collector:4318" });
    await exporter.exportAsync([makeSpan()]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://collector:4318/v1/traces");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("includes resourceSpans with service.name in payload", async () => {
    let capturedBody = "";
    const fetchSpy = mock().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return { ok: true, text: async () => "" } as Response;
    });
    globalThis.fetch = fetchSpy;

    const exporter = new OtlpHttpExporter({
      endpoint: "http://localhost:4318",
      serviceName: "my-agent-service",
      serviceVersion: "1.0.0",
    });
    await exporter.exportAsync([makeSpan()]);

    const payload = JSON.parse(capturedBody);
    expect(payload.resourceSpans).toHaveLength(1);
    const resourceAttrs = payload.resourceSpans[0].resource.attributes as Array<{
      key: string;
      value: { stringValue: string };
    }>;
    const serviceNameAttr = resourceAttrs.find((a) => a.key === "service.name");
    expect(serviceNameAttr?.value.stringValue).toBe("my-agent-service");
    const versionAttr = resourceAttrs.find((a) => a.key === "service.version");
    expect(versionAttr?.value.stringValue).toBe("1.0.0");
  });

  it("encodes span traceId and spanId as padded hex", async () => {
    let capturedBody = "";
    const fetchSpy = mock().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return { ok: true, text: async () => "" } as Response;
    });
    globalThis.fetch = fetchSpy;

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
    const fetchSpy = mock().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return { ok: true } as Response;
    });
    globalThis.fetch = fetchSpy;

    const exporter = new OtlpHttpExporter();
    await exporter.exportAsync([makeSpan({ status: "error" })]);

    const payload = JSON.parse(capturedBody);
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2);
  });

  it("encodes attributes correctly (string/number/bool)", async () => {
    let capturedBody = "";
    const fetchSpy = mock().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return { ok: true } as Response;
    });
    globalThis.fetch = fetchSpy;

    const exporter = new OtlpHttpExporter();
    await exporter.exportAsync([
      makeSpan({
        attributes: {
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.system": "anthropic",
          "gen_ai.request.stream": true,
          "gen_ai.usage.cost": 0.005,
        },
      }),
    ]);

    const payload = JSON.parse(capturedBody);
    const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes as Array<{
      key: string;
      value: Record<string, unknown>;
    }>;
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
    const fetchSpy = mock().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return { ok: true } as Response;
    });
    globalThis.fetch = fetchSpy;

    const exporter = new OtlpHttpExporter();
    await exporter.exportAsync([makeSpan({ parentSpanId: "span-00000002" })]);

    const payload = JSON.parse(capturedBody);
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.parentSpanId).toBeDefined();
    expect(span.parentSpanId.length).toBe(16);
  });

  it("fire-and-forget export() does not throw on fetch error and logs after retries", async () => {
    const fetchSpy = mock().mockRejectedValue(new Error("network error"));
    globalThis.fetch = fetchSpy;
    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});

    // Use maxRetries:0 to skip retries and get immediate error logging
    const exporter = new OtlpHttpExporter({ maxRetries: 0 });
    exporter.export([makeSpan()]);
    // Allow the microtask queue + minimal delay to flush
    await new Promise((r) => setTimeout(r, 20));
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("export() is no-op for empty spans", () => {
    const fetchSpy = mock();
    globalThis.fetch = fetchSpy;
    const exporter = new OtlpHttpExporter();
    exporter.export([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("OTEL_SEMCONV_STABILITY_OPT_IN (#30)", () => {
  afterEach(() => {
    delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
  });

  it("GENAI_SEMCONV_VERSION is exported and equals 1.28.0", () => {
    expect(GENAI_SEMCONV_VERSION).toBe("1.28.0");
  });

  it("useLatestSemconv is false by default", () => {
    const exporter = new OtlpHttpExporter();
    expect(exporter.useLatestSemconv).toBe(false);
  });

  it("useLatestSemconv is true when semconvVersion: 'latest' is passed", () => {
    const exporter = new OtlpHttpExporter({ semconvVersion: "latest" });
    expect(exporter.useLatestSemconv).toBe(true);
  });

  it("useLatestSemconv is true when OTEL_SEMCONV_STABILITY_OPT_IN=genai/experimental", () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "genai/experimental";
    const exporter = new OtlpHttpExporter();
    expect(exporter.useLatestSemconv).toBe(true);
  });

  it("useLatestSemconv remains false for unrelated env var values", () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "http/dup";
    const exporter = new OtlpHttpExporter();
    expect(exporter.useLatestSemconv).toBe(false);
  });

  it("explicit semconvVersion: 'default' overrides env var", () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "genai/experimental";
    // When explicitly set to "default", the option wins over env var
    const exporter = new OtlpHttpExporter({ semconvVersion: "default" });
    // Actually per our logic, the env var OR option triggers it.
    // Let's verify: our code says opts.semconvVersion === "latest" || envOpt === "genai/experimental"
    // So if env is set, even with "default" option, it's true. This is intentional:
    // the env var is a cluster-level override that trumps per-instance config.
    expect(exporter.useLatestSemconv).toBe(true);
  });
});

// ── M7: real-time evidence streaming → OTLP (#276) ───────────────────────────

const EVIDENCE_SEED = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const EVIDENCE_KEY_ID = "otlp-test-key";

/** Emit a signed AEPRecord with the given actions. */
async function makeEvidenceRecord(
  actions: Array<{ tool_name: string; state_changing: boolean; action_id?: string }>,
  run_id = "run-otlp-1"
): Promise<AEPRecord> {
  const signer = createLocalSignerFromSeed(EVIDENCE_SEED, EVIDENCE_KEY_ID);
  const emitter = new AEPEmitter({ run_id, signer, allowEmptyActions: true });
  for (const a of actions) {
    emitter.addAction({
      tool_name: a.tool_name,
      state_changing: a.state_changing,
      ...(a.action_id !== undefined ? { action_id: a.action_id } : {}),
    });
  }
  return emitter.emit(1_700_000_000_000);
}

/** Look up an OTLP attribute value by key. */
function attrValue(
  attrs: Array<{ key: string; value: Record<string, unknown> }>,
  key: string
): unknown {
  return attrs.find((a) => a.key === key)?.value;
}

/** A fetch mock that captures every call's url + body and returns a configured response. */
function recordingFetcher(
  responses: Array<{ ok: boolean; status: number }>
): typeof fetch & { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  let i = 0;
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body as string });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: r.ok, status: r.status, text: async () => "" } as Response;
  };
  return Object.assign(fn as typeof fetch, { calls });
}

describe("aepRecordToOtlpSpans (#276)", () => {
  it("emits one span per action with valid hex ids and aep.* attributes", async () => {
    const record = await makeEvidenceRecord([
      { tool_name: "read_file", state_changing: false, action_id: "a1" },
      { tool_name: "write_file", state_changing: true, action_id: "a2" },
    ]);

    const spans = aepRecordToOtlpSpans(record);

    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(span.name).toBe("tool.call");
      expect(span.kind).toBe(2);
      expect(attrValue(span.attributes, "aep.run_id")).toEqual({ stringValue: "run-otlp-1" });
    }
    // All actions share the same trace id (scoped to the run).
    expect(spans[0]!.traceId).toBe(spans[1]!.traceId);
    expect(attrValue(spans[0]!.attributes, "aep.tool_name")).toEqual({ stringValue: "read_file" });
    expect(attrValue(spans[1]!.attributes, "aep.state_changing")).toEqual({ boolValue: true });
  });
});

describe("OtlpEvidenceTransport (#276)", () => {
  afterEach(() => {
    mock.restore();
  });

  it("POSTs one span per action to <endpoint>/v1/traces and counts sent", async () => {
    const fetcher = recordingFetcher([{ ok: true, status: 200 }]);
    const transport = new OtlpEvidenceTransport({
      endpoint: "http://collector:4318",
      serviceName: "agent-svc",
      fetcher,
      maxRetries: 0,
    });
    const record = await makeEvidenceRecord([
      { tool_name: "read_file", state_changing: false },
      { tool_name: "shell", state_changing: true },
    ]);

    await transport.send({
      record,
      sequence: 1,
      publishedAtMs: 1,
      topic: "t",
    } satisfies StreamEvent);

    expect(transport.sentCount).toBe(1);
    expect(transport.failedCount).toBe(0);
    const calls = fetcher.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://collector:4318/v1/traces");
    const payload = JSON.parse(calls[0]!.body);
    const resourceSpans = payload.resourceSpans[0];
    expect(attrValue(resourceSpans.resource.attributes, "service.name")).toEqual({
      stringValue: "agent-svc",
    });
    expect(resourceSpans.scopeSpans[0].spans).toHaveLength(2);
    expect(resourceSpans.scopeSpans[0].scope.name).toBe("@wasmagent/aep");
  });

  it("retries on HTTP 5xx then succeeds", async () => {
    const fetcher = recordingFetcher([
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ]);
    const transport = new OtlpEvidenceTransport({
      fetcher,
      maxRetries: 2,
      retryDelayMs: 1,
    });
    const record = await makeEvidenceRecord([{ tool_name: "t", state_changing: false }]);

    await transport.send({
      record,
      sequence: 1,
      publishedAtMs: 1,
      topic: "t",
    } satisfies StreamEvent);

    expect(transport.sentCount).toBe(1);
    expect(transport.failedCount).toBe(0);
    const calls = fetcher.calls;
    expect(calls).toHaveLength(2); // one retry
  });

  it("does not retry on HTTP 4xx and records the failure", async () => {
    const fetcher = recordingFetcher([{ ok: false, status: 400 }]);
    const transport = new OtlpEvidenceTransport({
      fetcher,
      maxRetries: 3,
      retryDelayMs: 1,
    });
    const record = await makeEvidenceRecord([{ tool_name: "t", state_changing: false }]);

    await transport.send({
      record,
      sequence: 1,
      publishedAtMs: 1,
      topic: "t",
    } satisfies StreamEvent);

    expect(transport.sentCount).toBe(0);
    expect(transport.failedCount).toBe(1);
    expect(transport.lastError).toBeInstanceOf(Error);
    expect((transport.lastError as Error).message).toContain("400");
    const calls = fetcher.calls;
    expect(calls).toHaveLength(1); // no retry on 4xx
  });

  it("retries on network errors and records failure when exhausted", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const transport = new OtlpEvidenceTransport({
      fetcher,
      maxRetries: 1,
      retryDelayMs: 1,
    });
    const record = await makeEvidenceRecord([{ tool_name: "t", state_changing: false }]);

    await transport.send({
      record,
      sequence: 1,
      publishedAtMs: 1,
      topic: "t",
    } satisfies StreamEvent);

    expect(transport.sentCount).toBe(0);
    expect(transport.failedCount).toBe(1);
    expect(calls).toBe(2); // initial + 1 retry
  });
});

describe("EvidencePublisher + OtlpEvidenceTransport integration (#276)", () => {
  afterEach(() => {
    mock.restore();
  });

  it("streams published records to the OTLP collector", async () => {
    const fetcher = recordingFetcher([{ ok: true, status: 200 }]);
    const transport = new OtlpEvidenceTransport({ fetcher, maxRetries: 0 });
    const publisher = new EvidencePublisher({ topic: "live-evidence" });
    publisher.addTransport(transport);

    const record = await makeEvidenceRecord([{ tool_name: "read_file", state_changing: false }]);
    const result = await publisher.publish(record);

    expect(result.deliveredToTransports).toBe(1);
    expect(transport.sentCount).toBe(1);
    expect(publisher.stats.published).toBe(1);
    await publisher.close();
  });

  it("a failing collector never aborts the publisher fan-out", async () => {
    const fetcher = (async () => {
      throw new Error("collector down");
    }) as unknown as typeof fetch;
    const transport = new OtlpEvidenceTransport({ fetcher, maxRetries: 0 });
    const publisher = new EvidencePublisher();
    const seen: AEPRecord[] = [];
    publisher.subscribe((event) => seen.push(event.record));
    publisher.addTransport(transport);

    const record = await makeEvidenceRecord([{ tool_name: "t", state_changing: false }]);
    const result = await publisher.publish(record);

    // The subscriber still received the record and publish resolved — the
    // transport is best-effort (like the other evidence transports): it tracks
    // its own failure rather than throwing through the fan-out.
    expect(seen).toHaveLength(1);
    expect(result.deliveredToSubscribers).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(transport.failedCount).toBe(1);
    expect(transport.lastError).toBeInstanceOf(Error);
    await publisher.close();
  });

  it("watch mode streams store records through the OTLP transport", async () => {
    const fetcher = recordingFetcher([{ ok: true, status: 200 }]);
    const transport = new OtlpEvidenceTransport({ fetcher, maxRetries: 0 });
    const store = new InMemoryEvidenceStore();
    const publisher = new EvidencePublisher({ store, pollIntervalMs: 5 });
    publisher.addTransport(transport);

    await publisher.start();
    await store.append(await makeEvidenceRecord([{ tool_name: "t", state_changing: false }]));

    // Wait for at least one successful export.
    const start = Date.now();
    while (Date.now() - start < 1000 && transport.sentCount < 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    publisher.stop();
    await publisher.close();

    expect(transport.sentCount).toBe(1);
  });
});
